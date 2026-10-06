import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPrivateFile, STATE_DIR_ENV, statePaths } from "./state-paths.mjs";
import { ALIAS, codexPeersPath } from "./peer-directory.mjs";
import { defaultCodexHome } from "./codex-identity.mjs";
import { requireUuid } from "./limits.mjs";

// `open <alias>` (M5): reopen the session an alias is registered to, in the terminal it is run from.
//
// What it removes is the hand-made relaunch script per session (my-claude, my-codex, ...) and the
// prompt that came with each one ("give me the command to reopen my partner in bypass mode"). It
// reads the alias out of the owner's own peer directory and builds the one command line that keeps
// the session a peer:
//   - Claude: an absolute argv[0] and an explicit --permission-mode, because the permission proof
//     reads both from the kernel's copy of argv (darwin-procargs.mjs) and fails closed without them.
//   - Codex: `--remote unix://`, so the thread runs on the shared app-server and the doorbell can
//     start or steer a turn on it; a local TUI thread cannot be rung.
// It also hands the session this state directory and puts this install's bin on PATH, so the
// session's own `universal-peer-mcp inbox` / `post` reach the same daemon without a long path.
//
// It never registers anything (registration is proved from inside the session), never picks a
// session by guess (an alias names exactly one id, and the id is passed explicitly), and never
// raises a permission: the Claude mode is the one the table already records for the alias, and a
// `prompting` alias is reopened in a prompting mode, never in bypass.
export const CLAUDE_MODE_FOR = { bypass: "bypassPermissions", prompting: "default" };
const PROMPTING_FLAGS = new Set(["default", "plan", "acceptEdits", "auto"]);

function coded(code, message) { return Object.assign(new Error(message), { code }); }

async function readJson(file) {
  try { await assertPrivateFile(file, { maxBytes: 256 * 1024 }); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

export function firstExecutable(candidates, { isExecutable = defaultIsExecutable } = {}) {
  for (const candidate of candidates) if (typeof candidate === "string" && path.isAbsolute(candidate) && isExecutable(candidate)) return candidate;
  return null;
}
function defaultIsExecutable(file) { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }
function onPath(name, environment) { return (environment.PATH ?? "").split(":").filter(Boolean).map((dir) => path.join(dir, name)); }

// The working directory a Codex thread was started in is recorded once, in the first line of its
// rollout (`session_meta.payload.cwd`). Only that line is read — at most 64 KiB, never the
// conversation after it.
export function codexThreadCwd(threadId, { codexHome = defaultCodexHome() } = {}) {
  const root = path.join(codexHome, "sessions"); const suffix = `-${threadId}.jsonl`;
  const find = (dir, depth) => {
    let names; try { names = fs.readdirSync(dir); } catch { return null; }
    for (const name of names.sort().reverse()) {
      const full = path.join(dir, name);
      if (depth === 3) { if (name.startsWith("rollout-") && name.endsWith(suffix)) return full; continue; }
      if (!/^\d{2,4}$/.test(name)) continue;
      const hit = find(full, depth + 1); if (hit) return hit;
    }
    return null;
  };
  const file = find(root, 0); if (!file) return null;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024); const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\n")[0];
    const cwd = JSON.parse(line)?.payload?.cwd;
    return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

// Pure: alias row in, the exact command out. Everything it decides is visible in the result, so
// `open --print` shows the owner what would run before anything does.
export function buildOpenCommand({ alias, peer, root, binDir, claudeBin, codexBin, cwd, permissionFlag = null, environment = process.env }) {
  const env = { [STATE_DIR_ENV]: root, PATH: [binDir, environment.PATH].filter(Boolean).join(":") };
  if (peer.kind === "claude") {
    const recorded = peer.permissionMode;
    if (!CLAUDE_MODE_FOR[recorded]) throw coded("OPEN_PERMISSION_UNKNOWN", `alias ${alias} records no permission mode this can reopen`);
    let flag = CLAUDE_MODE_FOR[recorded];
    if (permissionFlag !== null) {
      // A different prompting flag is the owner's choice; crossing between bypass and prompting is not.
      const crossed = recorded === "bypass" ? permissionFlag !== "bypassPermissions" : !PROMPTING_FLAGS.has(permissionFlag);
      if (crossed) throw coded("OPEN_PERMISSION_CHANGE", `alias ${alias} is registered as ${recorded}; reopen it in that mode, or register a new session`);
      flag = permissionFlag;
    }
    if (!claudeBin) throw coded("OPEN_CLAUDE_NOT_FOUND", "no absolute claude executable found; pass --claude <absolute path>");
    return { alias, kind: "claude", cwd: peer.cwd, argv: [claudeBin, "--resume", peer.sessionId, "--permission-mode", flag], env };
  }
  if (peer.kind === "codex") {
    if (!codexBin) throw coded("OPEN_CODEX_NOT_FOUND", "no absolute codex executable found; pass --codex <absolute path>");
    if (!cwd) throw coded("OPEN_CWD_UNKNOWN", `the working directory of ${alias}'s thread is not recorded; pass --cwd <absolute path>`);
    return { alias, kind: "codex", cwd, argv: [codexBin, "--remote", "unix://", "--no-alt-screen", "-C", cwd, "resume", peer.threadId], env };
  }
  throw coded("OPEN_KIND_UNKNOWN", `alias ${alias} has no kind this can reopen`);
}

export async function planOpen(alias, { root = statePaths().root, binDir, claude = null, codex = null, cwd = null, permissionFlag = null, environment = process.env, codexHome } = {}) {
  if (typeof alias !== "string" || !ALIAS.test(alias)) throw coded("OPEN_USAGE", "usage: open <alias> [--print] [--permission-mode <flag>] [--cwd <dir>] [--claude <path>] [--codex <path>]");
  const paths = statePaths(root);
  const targets = await readJson(paths.targets); const codexPeers = await readJson(codexPeersPath(paths.root));
  let peer = null;
  if (targets[alias]) { const row = targets[alias]; requireUuid(row.sessionId, "sessionId"); peer = { kind: "claude", sessionId: row.sessionId.toLowerCase(), cwd: row.cwd, permissionMode: row.permissionMode }; }
  else if (codexPeers[alias]) { const row = codexPeers[alias]; requireUuid(row.threadId, "threadId"); peer = { kind: "codex", threadId: row.threadId.toLowerCase() }; }
  if (!peer) throw coded("UNKNOWN_ALIAS", `no peer is registered as ${alias}`);
  if (peer.kind === "claude" && (typeof peer.cwd !== "string" || !path.isAbsolute(peer.cwd) || !fs.existsSync(peer.cwd))) throw coded("OPEN_CWD_MISSING", `the working directory recorded for ${alias} does not exist`);
  if (cwd !== null && (!path.isAbsolute(cwd) || !fs.existsSync(cwd))) throw coded("OPEN_CWD_MISSING", "--cwd must be an existing absolute directory");
  const home = os.homedir();
  const claudeBin = firstExecutable([claude, environment.UNIVERSAL_PEER_CLAUDE_BIN, path.join(home, ".local", "bin", "claude"), ...onPath("claude", environment)]);
  const codexBin = firstExecutable([codex, environment.UNIVERSAL_PEER_CODEX_BIN, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", ...onPath("codex", environment)]);
  const threadCwd = peer.kind === "codex" ? (cwd ?? codexThreadCwd(peer.threadId, codexHome ? { codexHome } : {})) : null;
  return buildOpenCommand({ alias, peer, root: paths.root, binDir, claudeBin, codexBin, cwd: threadCwd, permissionFlag, environment });
}

// Runs the planned command in this terminal and returns its exit code. stdio is inherited: the
// session takes over the pane exactly as if the line had been typed.
export async function runOpen(plan, { spawn = Bun.spawn } = {}) {
  const child = spawn(plan.argv, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
