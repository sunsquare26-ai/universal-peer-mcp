import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { atomicPrivateWrite } from "../../core/state-paths.mjs";
import { localPeerPid } from "./darwin-peerpid.mjs";
import { processStart, processUid } from "./darwin-procargs.mjs";

export async function startReceiver(onFrame, { sessionsDir = path.join(os.homedir(), ".claude", "sessions"), socketDir = "/tmp/cc-socks", peerIdentityReader = defaultPeerIdentity } = {}) {
  await assertOwnedPrivateDirectory(sessionsDir);
  await assertOwnedPrivateDirectory(socketDir);
  const socketPath = path.join(socketDir, `${process.pid}.sock`);
  const token = crypto.randomBytes(16).toString("hex");
  const sessionId = crypto.randomUUID();
  const procStart = processStart();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    accept(socket, token, onFrame, peerIdentityReader);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await fsp.chmod(socketPath, 0o600);
  const registryPath = path.join(sessionsDir, `${process.pid}.json`);
  const keyPath = path.join(sessionsDir, `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await atomicPrivateWrite(keyPath, `${JSON.stringify({ peerToken: token, procStart, pidDomain: "darwin" })}\n`);
  await atomicPrivateWrite(registryPath, `${JSON.stringify({
    pid: process.pid, sessionId, cwd: process.cwd(), procStart, peerProtocol: 1,
    peerFeatures: ["notify_idle", "reply_across_default_dirs"], pidDomain: "darwin",
    messagingSocketPath: socketPath, name: "Claude MCP", status: "idle", updatedAt: Date.now()
  })}\n`);
  return {
    address: `uds:${socketPath}`, sessionId,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
      await Promise.allSettled([socketPath, registryPath, keyPath].map((file) => fsp.unlink(file)));
    }
  };
}

function accept(socket, token, onFrame, peerIdentityReader) {
  let authenticated = false; let buffer = ""; let chain = Promise.resolve();
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch { return socket.destroy(); }
      if (!authenticated) {
        if (frame.type !== "auth" || !safeEqual(frame.token, token)) return socket.destroy();
        authenticated = true; continue;
      }
      try {
        const peer = peerIdentityReader(socket);
        if (peer.uid !== process.getuid()) return socket.destroy();
        chain = chain.then(() => onFrame(frame, peer)).catch(() => socket.destroy());
      } catch { socket.destroy(); }
    }
  });
}

function defaultPeerIdentity(socket) { const pid = localPeerPid(socket); return { pid, uid: processUid(pid), procStart: processStart(pid) }; }

async function assertOwnedPrivateDirectory(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Claude socket/registry directory is not private");
}
function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
