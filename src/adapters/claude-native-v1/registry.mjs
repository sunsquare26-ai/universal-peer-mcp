import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProcStart, processStart, processUid, provePermissionMode } from "./darwin-procargs.mjs";

export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
export const SUPPORTED_PEER_PROTOCOL = 1;
export const REQUIRED_PEER_FEATURES = Object.freeze(["notify_idle", "reply_across_default_dirs"]);

export async function resolveTarget(expected, options = {}) {
  const sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  const startReader = options.processStartReader ?? processStart;
  const uidReader = options.processUidReader ?? processUid;
  await assertPrivateDirectory(sessionsDir);
  const candidates = [];
  for (const name of await fsp.readdir(sessionsDir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const file = path.join(sessionsDir, name);
      const stat = await fsp.lstat(file);
      // The one file in this adapter judged on write alone, because it is the one we do not write.
      // Claude Code 2.1.260 publishes ~/.claude/sessions/<pid>.json at 0644 — measured on every
      // live row on this machine — so demanding 0600 here refused every real session and closed
      // nothing: the row carries pid, session id, cwd and a socket path, and the secret that
      // admits a sender is the peerToken in the separate key file below, which stays 0600. What a
      // mode can still prove about a file we do not own is that no other account can rewrite it,
      // and rewriting it is the whole attack — a row another account can edit points this resolver
      // at a socket of its choosing. So group and other write are refused and read is not.
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) continue;
      const row = JSON.parse(await fsp.readFile(file, "utf8"));
      if (row.sessionId !== expected.sessionId) continue;
      if (typeof row.procStart !== "string" || uidReader(row.pid) !== process.getuid() || normalizeProcStart(startReader(row.pid)) !== normalizeProcStart(row.procStart)) continue;
      candidates.push({ row, file });
    } catch {}
  }
  if (candidates.length !== 1) throw new Error(`target resolved to ${candidates.length} live candidates`);
  const { row, file } = candidates[0];
  // The row was rendered by the session that wrote it and is compared against a rendering made
  // here; only the squeezed form of either is the fact. It is squeezed once and it is the
  // squeezed one that travels, so every later check — the key file, the argv proof, the
  // re-verify before a write, the peer identity on an inbound frame — compares one form.
  const recordedStart = normalizeProcStart(row.procStart);
  const expectedCwd = await fsp.realpath(expected.cwd); const actualCwd = await fsp.realpath(row.cwd);
  if (expectedCwd !== actualCwd) throw new Error("target cwd mismatch");
  if (row.peerProtocol !== SUPPORTED_PEER_PROTOCOL || !Array.isArray(row.peerFeatures) || REQUIRED_PEER_FEATURES.some((feature) => !row.peerFeatures.includes(feature))) throw new Error("unsupported Claude peer protocol");
  if (normalizeProcStart(startReader(row.pid)) !== recordedStart) throw new Error("target process identity changed");
  const socket = row.messagingSocketPath;
  const socketStat = await fsp.lstat(socket);
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o077) !== 0) throw new Error("target socket is not private");
  const keyPath = path.join(sessionsDir, `${row.pid}.${crypto.createHash("sha256").update(path.resolve(socket)).digest("hex")}.key`);
  const keyStat = await fsp.lstat(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.uid !== process.getuid() || (keyStat.mode & 0o077) !== 0) throw new Error("target key is not private");
  const key = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  if (normalizeProcStart(key.procStart) !== recordedStart || typeof key.peerToken !== "string" || key.peerToken.length < 16) throw new Error("target key identity mismatch");
  const permission = provePermissionMode(expected.permissionMode, row.pid, recordedStart, options.argvReader, options.startReader ?? startReader);
  return {
    sessionId: row.sessionId, cwd: actualCwd, pid: row.pid, procStart: recordedStart,
    socketPath: socket, token: key.peerToken, permission, peerFeatures: row.peerFeatures,
    observedDisplayName: typeof row.name === "string" ? row.name : null,
    expectedDisplayName: expected.expectedDisplayName, registryPath: file
  };
}

export async function reverifyTarget(target, expected, options = {}) {
  const current = await resolveTarget(expected, options);
  for (const key of ["sessionId", "cwd", "pid", "procStart", "socketPath"]) if (current[key] !== target[key]) throw new Error("target identity changed before write");
  return current;
}

async function assertPrivateDirectory(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Claude sessions directory is not private");
}
