import net from "node:net";
import { encodeFrames } from "./protocol.mjs";
import { localPeerPid } from "./darwin-peerpid.mjs";
import { processStart, processUid } from "./darwin-procargs.mjs";

export async function directSend(target, frames, { reverify, timeoutMs = 10_000, peerPidReader = localPeerPid } = {}) {
  const current = await reverify();
  if (current.pid !== target.pid || current.procStart !== target.procStart || current.socketPath !== target.socketPath || current.token !== target.token || current.permission.mode !== target.permission.mode) throw new Error("target identity changed before socket write");
  const wire = encodeFrames(frames);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.socketPath });
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve({ bytesWritten: Buffer.byteLength(wire) }); };
    const timer = setTimeout(() => finish(new Error("target socket write timed out")), timeoutMs);
    socket.once("error", finish);
    socket.once("connect", () => {
      try {
        const peerPid = peerPidReader(socket);
        if (peerPid !== target.pid || processUid(peerPid) !== process.getuid() || processStart(peerPid) !== target.procStart) return finish(new Error("connected target identity mismatch"));
        socket.end(wire, () => finish());
      } catch (error) { finish(error); }
    });
  });
}
