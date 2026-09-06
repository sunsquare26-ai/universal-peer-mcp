import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localPeerPid } from "../adapters/claude-native-v1/darwin-peerpid.mjs";
import { processStart, processUid } from "../adapters/claude-native-v1/darwin-procargs.mjs";
import { assertPrivateFile, ensurePrivateDirectory, statePaths } from "./state-paths.mjs";

export async function ensureDaemon({ root, timeoutMs = 10_000 } = {}) {
  const paths = statePaths(root); await ensurePrivateDirectory(paths.root);
  const live = await readLive(paths); if (live) return live;
  await reclaimDeadDaemon(paths);
  const daemonScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../daemon.mjs");
  const child = spawn("bun", [daemonScript], { detached: true, stdio: "ignore", env: { ...process.env, CLAUDE_PEER_MCP_STATE_DIR: paths.root } }); child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const row = await readLive(paths); if (row) return row; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("daemon readiness timed out");
}

export async function controlCall(method, args = {}, { root } = {}) {
  const paths = statePaths(root); const daemon = await ensureDaemon({ root });
  await assertPrivateFile(paths.controlToken, { maxBytes: 256 }); const token = (await fsp.readFile(paths.controlToken, "utf8")).trim();
  const request = { token, clientPid: process.pid, clientProcStart: processStart(), requestId: crypto.randomUUID(), method, args };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: paths.controlSocket }); let buffer = ""; let settled = false;
    const timer = setTimeout(() => finish(new Error("control request timed out")), 310_000);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once("error", finish);
    socket.once("connect", () => {
      try { const pid = localPeerPid(socket); if (pid !== daemon.pid || processUid(pid) !== process.getuid() || processStart(pid) !== daemon.procStart) return finish(new Error("control daemon identity mismatch")); socket.write(`${JSON.stringify(request)}\n`); }
      catch (error) { finish(error); }
    });
    socket.setEncoding("utf8"); socket.on("data", (chunk) => { buffer += chunk; if (Buffer.byteLength(buffer) > 1024 * 1024) return finish(new Error("control response too large")); const newline = buffer.indexOf("\n"); if (newline < 0) return; let response; try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish(new Error("invalid control response")); } if (response.requestId !== request.requestId) return finish(new Error("control response correlation mismatch")); if (response.ok) return finish(null, response.result); const error = new Error(typeof response.error?.message === "string" ? response.error.message : "control request failed"); error.code = typeof response.error?.code === "string" ? response.error.code : "INTERNAL_FAILURE"; finish(error); });
  });
}

async function readLive(paths) {
  try {
    await assertPrivateFile(paths.daemon, { maxBytes: 4096 }); const row = JSON.parse(await fsp.readFile(paths.daemon, "utf8"));
    if (row.socketPath !== paths.controlSocket || row.procStart !== processStart(row.pid)) return null;
    const stat = await fsp.lstat(paths.controlSocket); if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    return row;
  } catch { return null; }
}

async function reclaimDeadDaemon(paths) {
  let row = null;
  try { await assertPrivateFile(paths.daemon, { maxBytes: 4096 }); row = JSON.parse(await fsp.readFile(paths.daemon, "utf8")); } catch (error) { if (error.code !== "ENOENT") return; }
  if (row) {
    if (!Number.isInteger(row.pid) || row.pid <= 1 || row.socketPath !== paths.controlSocket || typeof row.procStart !== "string") throw new Error("stale daemon identity is malformed");
    if (recordedProcessIsLive(row)) throw new Error("recorded daemon is alive but could not be authenticated");
  }
  try {
    await assertPrivateFile(paths.daemonLock, { maxBytes: 4096 });
    const lock = JSON.parse(await fsp.readFile(paths.daemonLock, "utf8"));
    if (!Number.isInteger(lock.pid) || lock.pid <= 1 || typeof lock.procStart !== "string") throw new Error("daemon lock is malformed");
    if (recordedProcessIsLive(lock)) throw new Error("recorded daemon lock is owned by a live process");
    await fsp.unlink(paths.daemonLock);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const file of [paths.controlSocket, paths.controlToken, paths.daemon]) {
    try { const stat = await fsp.lstat(file); if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("stale daemon artifact is not owned"); await fsp.unlink(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function recordedProcessIsLive({ pid, procStart: recordedStart }) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  try { return processStart(pid) === recordedStart; }
  catch (error) {
    try { process.kill(pid, 0); }
    catch (retry) { if (retry.code === "ESRCH") return false; throw retry; }
    throw new Error("recorded process start could not be authenticated", { cause: error });
  }
}
