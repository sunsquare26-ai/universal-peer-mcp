import fsp from "node:fs/promises";
import { settleAllWithin } from "./wait.mjs";

export const SHUTDOWN_WAIT_MILLIS = 8000;

// Production and the process fixture share this function: a wedged ledger cannot leave the
// real daemon outside the bound that the test exercises. The caller owns process.exit.
export async function shutdownResources({ server, controlSockets = new Set(), receiver, store, daemonLock = null, paths, timeoutMs = SHUTDOWN_WAIT_MILLIS }) {
  const deadline = Date.now() + timeoutMs;
  const files = [paths.controlSocket, paths.controlToken, paths.daemon, paths.daemonLock].filter(Boolean);
  const owned = await settleAllWithin(files.map((file) => ["stat_artifact", fsp.lstat(file).then((stat) => ({ file, stat }))]), deadline - Date.now());
  const serverClosed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const socket of controlSockets) socket.destroy();
  const closes = await settleAllWithin([
    ["control_server_close", serverClosed], ["receiver_close", receiver.close()], ["event_store_close", store.close()]
  ], deadline - Date.now());
  const lock = daemonLock ? await settleAllWithin([["daemon_lock_close", daemonLock.close()]], deadline - Date.now()) : [];
  const removals = await settleAllWithin(owned.filter((item) => item.status === "fulfilled").map(({ value }) => ["unlink_artifact", unlinkOwned(value)]), deadline - Date.now());
  return [...owned, ...closes, ...lock, ...removals].filter((item) => item.status === "rejected" && item.reason?.code !== "ENOENT");
}

async function unlinkOwned({ file, stat: expected }) {
  const current = await fsp.lstat(file);
  if (current.uid !== process.getuid() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || (current.mode & 0o077) !== 0) throw new Error("daemon artifact changed during cleanup");
  await fsp.unlink(file);
}
