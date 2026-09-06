import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processStart, processUid, provePermissionMode } from "./darwin-procargs.mjs";

export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const REQUIRED_PEER_FEATURES = ["notify_idle", "reply_across_default_dirs"];

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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) continue;
      const row = JSON.parse(await fsp.readFile(file, "utf8"));
      if (row.sessionId !== expected.sessionId) continue;
      if (uidReader(row.pid) !== process.getuid() || startReader(row.pid) !== row.procStart) continue;
      candidates.push({ row, file });
    } catch {}
  }
  if (candidates.length !== 1) throw new Error(`target resolved to ${candidates.length} live candidates`);
  const { row, file } = candidates[0];
  const expectedCwd = await fsp.realpath(expected.cwd); const actualCwd = await fsp.realpath(row.cwd);
  if (expectedCwd !== actualCwd) throw new Error("target cwd mismatch");
  if (row.peerProtocol !== 1 || !Array.isArray(row.peerFeatures) || REQUIRED_PEER_FEATURES.some((feature) => !row.peerFeatures.includes(feature))) throw new Error("unsupported Claude peer protocol");
  if (startReader(row.pid) !== row.procStart) throw new Error("target process identity changed");
  const socket = row.messagingSocketPath;
  const socketStat = await fsp.lstat(socket);
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o077) !== 0) throw new Error("target socket is not private");
  const keyPath = path.join(sessionsDir, `${row.pid}.${crypto.createHash("sha256").update(path.resolve(socket)).digest("hex")}.key`);
  const keyStat = await fsp.lstat(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.uid !== process.getuid() || (keyStat.mode & 0o077) !== 0) throw new Error("target key is not private");
  const key = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  if (key.procStart !== row.procStart || typeof key.peerToken !== "string" || key.peerToken.length < 16) throw new Error("target key identity mismatch");
  const permission = provePermissionMode(expected.permissionMode, row.pid, row.procStart, options.argvReader, options.startReader ?? startReader);
  return {
    sessionId: row.sessionId, cwd: actualCwd, pid: row.pid, procStart: row.procStart,
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
