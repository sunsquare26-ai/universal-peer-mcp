import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { atomicPrivateWrite } from "../../core/state-paths.mjs";
import { localPeerPid } from "./darwin-peerpid.mjs";
import { processIdentity, processStart } from "./darwin-procargs.mjs";

export async function startReceiver(onFrame, { sessionsDir = path.join(os.homedir(), ".claude", "sessions"), socketDir = "/tmp/cc-socks", peerIdentityReader = defaultPeerIdentity, onFrameRefused = null } = {}) {
  await assertOwnedPrivateDirectory(sessionsDir);
  await assertOwnedPrivateDirectory(socketDir);
  const socketPath = path.join(socketDir, `${process.pid}.sock`);
  const token = crypto.randomBytes(16).toString("hex");
  const sessionId = crypto.randomUUID();
  const procStart = processStart();
  const sockets = new Set(); let connections = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    connections += 1;
    accept(socket, token, onFrame, { peerIdentityReader, onFrameRefused, connectionId: connections });
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

// Who wrote a frame is read from the kernel with that frame, and from nothing else.
// LOCAL_PEERPID answers with the peer socket's last_pid, so the value changes when another
// process inherits or is passed the descriptor and writes on it. A read taken when the
// connection was accepted answers a different question — who opened it — and getsockopt
// answers ENOTCONN once the writer is gone, which is the case that used to fall back to that
// accept read under an identitySource:"accept" label. Measured with a real inherited socket:
// a child that wrote and then closed was handed on as its parent, and the parent's identity
// carried the frame through core, milestone and code review to a delivered ACK and a passing
// review. A label does not separate identity strength, so the fallback is gone and there is
// one rule: the frame time read succeeds and the frame is that process' frame, or it fails
// and the frame is refused.
//
// The cost is deliberate. A third party that writes and closes in one breath — socat and
// anything shaped like it — has its frames refused. The shipped sender holds the connection
// open until the receiver closes it (transport.mjs), which is what keeps its writer nameable.
// That is a hold, not an exemption: when our own hold bound ends first, our frames meet this
// same rule. docs/known-issues.md carries it in those words.
//
// Refusals are not silence. Each one is reported with the connection it arrived on and why,
// so that "refused", "arrived and correlated to nothing" and "nothing arrived" are three
// different answers in the ledger rather than one absence. The middle answer is decided
// downstream, so the connection and the frame's ordinal travel with the frame and end up on
// that record too (core/peer-core.mjs frameObserver). The connection number is local to this
// receiver and counts from one: it is enough to group frames and it names nothing outside.
function accept(socket, token, onFrame, { peerIdentityReader, onFrameRefused, connectionId }) {
  let authenticated = false; let buffer = ""; let chain = Promise.resolve(); let ordinal = 0;
  socket.setEncoding("utf8");
  // A sender that closes hard delivers its bytes and then an ECONNRESET; without a listener
  // that reset is an unhandled error event and it takes the daemon down with it.
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) return refuse("frame_too_large");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      ordinal += 1; const frameOrdinal = ordinal;
      let frame; try { frame = JSON.parse(line); } catch { return refuse("unparsable_frame", frameOrdinal); }
      const read = identify();
      if (read.refused) return refuse(read.refused, frameOrdinal);
      if (!authenticated) {
        if (frame.type !== "auth" || !safeEqual(frame.token, token)) return refuse("authentication_failed", frameOrdinal);
        authenticated = true; continue;
      }
      chain = chain.then(() => onFrame(frame, read.peer, { connectionId, frameOrdinal })).catch(() => socket.destroy());
    }
  });

  // One read, taken with the frame that is being handled. It answers with the writer, or it
  // does not answer; there is no third result and nothing older stands in for it.
  function identify() {
    let read = null;
    try { read = peerIdentityReader(socket); } catch { return { refused: "identity_unavailable" }; }
    if (!read) return { refused: "identity_unavailable" };
    if (read.uid !== process.getuid()) return { refused: "identity_foreign_uid" };
    return { peer: { ...read, identitySource: "frame" } };
  }

  // The refusal goes on the same chain as the frames so it lands in the order it happened, and
  // a reporter that throws ends the report, never the connection handling. The ordinal is the
  // one the refused frame was read under, not whatever the counter says when the report runs.
  function refuse(reason, frameOrdinal = ordinal) {
    chain = chain.then(() => (onFrameRefused ? onFrameRefused({ connectionId, frameOrdinal, reason }) : null)).catch(() => {});
    socket.destroy();
  }
}

// The pid and the uid and start time behind it are read together, for the frame in hand, and
// nothing is held between frames. A held uid or start time is a claim about a process that was
// named earlier, and the pid it was held under is exactly the value that changes when the
// writer changes.
export function defaultPeerIdentity(socket) {
  const pid = localPeerPid(socket);
  const { uid, procStart } = processIdentity(pid);
  return { pid, uid, procStart };
}

async function assertOwnedPrivateDirectory(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Claude socket/registry directory is not private");
}
function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
