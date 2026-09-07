import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { statePaths } from "./core/state-paths.mjs";
import { redactPublic } from "./mcp/redact.mjs";

function tilde(value) { const home = os.homedir(); return typeof value === "string" && home ? value.split(home).join("~") : value; }
function reason(error) { return tilde(error instanceof Error ? error.message : String(error)); }

export function versionAtLeast(actual, minimum) {
  const parse = (value) => String(value).split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const left = parse(actual); const right = parse(minimum);
  if (left.some((part) => !Number.isInteger(part)) || right.some((part) => !Number.isInteger(part))) return null;
  for (let index = 0; index < 3; index += 1) { if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0); }
  return true;
}

// The returned document is the public projection: every string goes through the same
// redactPublic used by the MCP façade, so no path outside the home shorthand, no
// credential shape and no registry supplied value can reach stdout.
export async function doctor(options = {}) {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bunVersion = typeof Bun === "undefined" ? null : Bun.version;
  const minimumBun = manifest.engines?.bun?.replace(/^>=/, "") ?? null;
  const runtime = {
    bun: bunVersion, node: process.versions.node,
    requiresBun: manifest.engines?.bun ?? null,
    bunSatisfied: bunVersion && minimumBun ? versionAtLeast(bunVersion, minimumBun) : false
  };
  const system = {
    platform: process.platform, arch: process.arch, release: os.release(),
    supportedPlatforms: manifest.os ?? [], supportedArchitectures: manifest.cpu ?? [],
    platformSupported: (manifest.os ?? []).includes(process.platform),
    architectureSupported: (manifest.cpu ?? []).includes(process.arch)
  };
  const paths = options.stateRoot ? statePaths(options.stateRoot) : statePaths();
  const state = await inspectState(paths);
  const targets = await inspectTargets(paths.targets);
  const claudeRegistry = await inspectRegistry(options.sessionsDir);
  const codexWake = await inspectCodexWake();
  const ok = Boolean(system.platformSupported && system.architectureSupported && runtime.bunSatisfied
    && state.ok && targets.ok && claudeRegistry.ok && codexWake.ok);
  return redactPublic({
    ok, platform: process.platform, arch: process.arch, runtime: bunVersion ? `Bun ${bunVersion}` : `Node ${process.versions.node}`,
    stateDirectory: tilde(paths.root),
    system, runtimes: runtime, state, targets, claudeRegistry, codexWake,
    note: "doctor does not print tokens or process arguments",
    writes: "none — doctor never creates the state directory or any file"
  });
}

// "I could not look" is not "there is nothing there". Only ENOENT means absent; every other
// errno means the check did not happen, and a check that did not happen is never reported ok.
function unreadable(error, note) { return { ok: false, status: "unreadable", present: null, reason: reason(error), note }; }

async function inspectState(paths) {
  let stat = null;
  try { stat = await fsp.lstat(paths.root); }
  catch (error) {
    if (error.code !== "ENOENT") return unreadable(error, "the state directory could not be inspected");
    return { ok: true, status: "absent", present: false, note: "created on first serve" };
  }
  const isPrivate = stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  const files = [];
  let unreadableFiles = 0;
  for (const key of ["targets", "events", "owner", "daemon", "daemonLock", "controlToken", "controlSocket"]) {
    try {
      const entry = await fsp.lstat(paths[key]);
      files.push({ name: path.basename(paths[key]), mode: (entry.mode & 0o777).toString(8).padStart(4, "0"), owned: entry.uid === process.getuid(), private: (entry.mode & 0o077) === 0 && !entry.isSymbolicLink() });
    } catch (error) { if (error.code !== "ENOENT") unreadableFiles += 1; }
  }
  return { ok: isPrivate && unreadableFiles === 0 && files.every((file) => file.owned && file.private), status: "present", present: true, private: isPrivate, mode: (stat.mode & 0o777).toString(8).padStart(4, "0"), unreadable: unreadableFiles, files };
}

async function inspectTargets(file) {
  try { await fsp.lstat(file); }
  catch (error) {
    if (error.code !== "ENOENT") return unreadable(error, "the target file could not be inspected");
    return { ok: true, status: "absent", present: false, count: 0, note: "copy targets.example.json into the state directory to add targets" };
  }
  try {
    const { loadTargets } = await import("./core/target-config.mjs");
    const loaded = await loadTargets(file);
    return { ok: true, status: "present", present: true, schemaValid: true, count: Object.keys(loaded).length, aliases: Object.keys(loaded) };
  } catch (error) { return { ok: false, status: "present", present: true, schemaValid: false, count: 0, reason: reason(error) }; }
}

async function inspectRegistry(sessionsDirOverride) {
  let registry = null;
  try { registry = await import("./adapters/claude-native-v1/registry.mjs"); }
  catch (error) { return { ok: false, present: false, reason: reason(error) }; }
  const sessionsDir = sessionsDirOverride ?? registry.DEFAULT_SESSIONS_DIR;
  const directory = tilde(sessionsDir);
  const supportedProtocol = registry.SUPPORTED_PEER_PROTOCOL;
  const requiredFeatures = [...registry.REQUIRED_PEER_FEATURES];
  let stat = null;
  try { stat = await fsp.lstat(sessionsDir); }
  catch (error) {
    if (error.code !== "ENOENT") return { ...unreadable(error, "the session registry could not be inspected"), directory, supportedProtocol, requiredFeatures };
    return { ok: false, status: "absent", present: false, directory, supportedProtocol, requiredFeatures, note: "no Claude Code session registry on this machine" };
  }
  const isPrivate = stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  const byProtocol = {}; const missingRequiredFeatures = {};
  let entries = 0; let unreadableEntries = 0; let compatible = 0; let incompatible = 0;
  try {
    for (const name of await fsp.readdir(sessionsDir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      entries += 1;
      let row = null;
      try { row = JSON.parse(await fsp.readFile(path.join(sessionsDir, name), "utf8")); } catch { unreadableEntries += 1; continue; }
      // peerProtocol is attacker controlled from doctor's point of view: it is only ever
      // bucketed into a closed vocabulary, never echoed as a key or a value.
      const protocol = Number.isInteger(row?.peerProtocol) ? row.peerProtocol : null;
      const bucket = protocol !== null ? String(protocol) : (row === null || typeof row !== "object" || row.peerProtocol === undefined ? "absent" : "invalid");
      byProtocol[bucket] = (byProtocol[bucket] ?? 0) + 1;
      const features = Array.isArray(row?.peerFeatures) ? row.peerFeatures : [];
      const missing = requiredFeatures.filter((feature) => !features.includes(feature));
      for (const feature of missing) missingRequiredFeatures[feature] = (missingRequiredFeatures[feature] ?? 0) + 1;
      if (protocol === supportedProtocol && missing.length === 0) compatible += 1; else incompatible += 1;
    }
  } catch (error) { return { ok: false, status: "unreadable", present: true, private: isPrivate, directory, supportedProtocol, requiredFeatures, reason: reason(error) }; }
  return {
    ok: isPrivate && unreadableEntries === 0 && incompatible === 0,
    status: "present", present: true, private: isPrivate, directory, supportedProtocol, requiredFeatures,
    entries, compatible, incompatible, unreadable: unreadableEntries, byProtocol, missingRequiredFeatures,
    note: "counts only — doctor never prints session ids, pids, sockets or tokens"
  };
}

async function inspectCodexWake() {
  try {
    const { codexWakeExtension } = await import("./extensions/codex-wake/index.mjs");
    return codexWakeExtension.enabled
      ? { ok: true, enabled: true, helpChecked: false, note: "codex wake help compatibility is checked by the extension when it ships" }
      : { ok: true, enabled: false, helpChecked: false, note: "codex wake is off — no codex CLI is invoked" };
  } catch (error) { return { ok: false, enabled: false, reason: reason(error) }; }
}
