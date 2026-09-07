import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localPeerPid } from "../adapters/claude-native-v1/darwin-peerpid.mjs";
import { normalizeProcStart, processStart, processUid } from "../adapters/claude-native-v1/darwin-procargs.mjs";
import { assertPrivateFile, ensurePrivateDirectory, LEGACY_STATE_DIR_ENV, STATE_DIR_ENV, statePaths } from "./state-paths.mjs";

export async function ensureDaemon({ root, timeoutMs = 10_000 } = {}) {
  const paths = statePaths(root); await ensurePrivateDirectory(paths.root);
  const live = await readLive(paths); if (live) return live;
  await reclaimDeadDaemon(paths);
  const daemonScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../daemon.mjs");
  const child = spawn("bun", [daemonScript], { detached: true, stdio: "ignore", env: daemonEnvironment(paths.root) }); child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const row = await readLive(paths); if (row) return row; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("daemon readiness timed out");
}

// The daemon is told where its state directory is under the current name, and the old name is
// taken off the child's environment rather than left next to it. A parent that is itself running
// on an explicit root — every test here, and `controlCall({ root })` — would otherwise hand the
// child two names for two different directories, and the child refuses to start on that.
function daemonEnvironment(root) {
  const environment = { ...process.env, [STATE_DIR_ENV]: root };
  delete environment[LEGACY_STATE_DIR_ENV];
  return environment;
}

// Checking a target table and executing against it are two requests, and until a command said so
// there was nothing in the second one that named what the first one had read. A daemon that was
// replaced in between is authenticated exactly as the checked one was — it is the live daemon, and
// that is all this end could ever ask — and a table rewritten in between is simply the table the
// command is carried out against. So a caller that has checked something says what it checked, and
// the command is refused unless both ends still hold it: this end will not write a bound command
// to a daemon that is not the one it names, and the daemon refuses one whose table digest is not
// the one it is holding (src/daemon.mjs). Neither check is the other's backstop — this one keeps
// the bytes off a stranger's socket, and that one is the enforcement, because it is the side that
// executes.
export async function controlCall(method, args = {}, { root, expect = null } = {}) {
  const paths = statePaths(root); const daemon = await ensureDaemon({ root });
  await assertPrivateFile(paths.controlToken, { maxBytes: 256 }); const token = (await fsp.readFile(paths.controlToken, "utf8")).trim();
  const request = { token, clientPid: process.pid, clientProcStart: processStart(), requestId: crypto.randomUUID(), method, args, ...(expect === null ? {} : { expect }) };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: paths.controlSocket }); let buffer = ""; let settled = false;
    const timer = setTimeout(() => finish(new Error("control request timed out")), 310_000);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once("error", finish);
    socket.once("connect", () => {
      try {
        const pid = localPeerPid(socket);
        if (pid !== daemon.pid || processUid(pid) !== process.getuid() || normalizeProcStart(processStart(pid)) !== normalizeProcStart(daemon.procStart)) return finish(new Error("control daemon identity mismatch"));
        if (expect !== null && (pid !== expect.daemonPid || normalizeProcStart(processStart(pid)) !== normalizeProcStart(expect.daemonProcStart))) return finish(unboundDaemon());
        socket.write(`${JSON.stringify(request)}\n`);
      }
      catch (error) { finish(error); }
    });
    socket.setEncoding("utf8"); socket.on("data", (chunk) => { buffer += chunk; if (Buffer.byteLength(buffer) > 1024 * 1024) return finish(new Error("control response too large")); const newline = buffer.indexOf("\n"); if (newline < 0) return; let response; try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish(new Error("invalid control response")); } if (response.requestId !== request.requestId) return finish(new Error("control response correlation mismatch")); if (response.ok) return finish(null, response.result); const error = new Error(typeof response.error?.message === "string" ? response.error.message : "control request failed"); error.code = typeof response.error?.code === "string" ? response.error.code : "INTERNAL_FAILURE"; finish(error); });
  });
}

// Same published code as any other unreachable target, and for the same reason as the façade's
// stale-table refusal: from the caller's side the daemon it checked is not the daemon this
// connection reached, so the target it was about to name is not one this connection can reach.
function unboundDaemon() {
  const error = new Error("the daemon this call was checked against has been replaced; re-read the target table and check again");
  error.code = "TARGET_UNAVAILABLE";
  return error;
}

async function readLive(paths) {
  try {
    await assertPrivateFile(paths.daemon, { maxBytes: 4096 }); const row = JSON.parse(await fsp.readFile(paths.daemon, "utf8"));
    if (row.socketPath !== paths.controlSocket || normalizeProcStart(row.procStart) !== normalizeProcStart(processStart(row.pid))) return null;
    const stat = await fsp.lstat(paths.controlSocket); if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    return row;
  } catch { return null; }
}

// The only operation in this product that deletes. Everything it deletes belongs to whoever holds
// daemon.lock, so it takes that lock before the first unlink and gives it up after the last one:
// letting go first leaves a window in which a daemon starts, publishes its token and its record,
// and has them deleted under it by a reclaimer still working from a list it made earlier. A fresh
// directory has nothing to reclaim and takes no lock, so two callers racing to start the first
// daemon behave exactly as they did before.
export async function reclaimDeadDaemon(paths) {
  const present = [];
  for (const file of [paths.daemon, paths.daemonLock, paths.controlSocket, paths.controlToken]) {
    try { await fsp.lstat(file); present.push(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (present.length === 0) return;
  let row = null;
  try { await assertPrivateFile(paths.daemon, { maxBytes: 4096 }); row = JSON.parse(await fsp.readFile(paths.daemon, "utf8")); } catch (error) { if (error.code !== "ENOENT") return; }
  if (row) {
    if (!Number.isInteger(row.pid) || row.pid <= 1 || row.socketPath !== paths.controlSocket || typeof row.procStart !== "string") throw new Error("stale daemon identity is malformed");
    const state = recordedProcessState(row);
    if (state === "same") throw new Error("recorded daemon is alive but could not be authenticated");
    if (state === "ambiguous") throw new Error(ambiguous("daemon record"));
  }
  try {
    await assertPrivateFile(paths.daemonLock, { maxBytes: 4096 });
    const lock = JSON.parse(await fsp.readFile(paths.daemonLock, "utf8"));
    if (!Number.isInteger(lock.pid) || lock.pid <= 1 || typeof lock.procStart !== "string") throw new Error("daemon lock is malformed");
    const state = recordedProcessState(lock);
    if (state === "same") throw new Error("recorded daemon lock is owned by a live process");
    if (state === "ambiguous") throw new Error(ambiguous("daemon lock"));
    await fsp.unlink(paths.daemonLock);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Between dropping a dead lock and taking a live one there is a gap, and a daemon can start in
  // it. That is not a window in which anything is deleted — it is a window in which this loses,
  // and losing means standing down without touching a file.
  let held;
  try { held = await fsp.open(paths.daemonLock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("another process took the daemon lock before this cleanup began"); throw error; }
  try {
    await held.writeFile(`${JSON.stringify({ pid: process.pid, procStart: processStart() })}\n`); await held.sync();
    for (const file of [paths.controlSocket, paths.controlToken, paths.daemon]) {
      try { const stat = await fsp.lstat(file); if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("stale daemon artifact is not owned"); await fsp.unlink(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } finally {
    await held.close().catch(() => {});
    await fsp.unlink(paths.daemonLock).catch(() => {});
  }
}

// Not two answers, three. The pid is gone (ESRCH): the record is dead and its files are ours to
// clear. The pid answers and renders the start time the record holds: the daemon is running and
// nothing here may touch it. The pid answers and renders something else: that is not knowledge,
// it is doubt — the record may be an earlier build's rendering of that same running daemon, or a
// stranger that inherited the pid, and the two are indistinguishable from here. Clearing on doubt
// puts a second daemon in the directory and a second writer on one append-only ledger, which is
// the one failure this ledger cannot survive. So doubt stops and a person decides.
function recordedProcessState({ pid, procStart: recordedStart }) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return "gone"; throw error; }
  try { return normalizeProcStart(processStart(pid)) === normalizeProcStart(recordedStart) ? "same" : "ambiguous"; }
  catch (error) {
    try { process.kill(pid, 0); }
    catch (retry) { if (retry.code === "ESRCH") return "gone"; throw retry; }
    return "ambiguous";
  }
}
function ambiguous(subject) {
  return `the ${subject} names a live process it does not identify; this state directory may still belong to a running daemon and must be cleared by hand`;
}
