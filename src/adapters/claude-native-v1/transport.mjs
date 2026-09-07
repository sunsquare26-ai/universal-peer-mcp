import net from "node:net";
import { encodeFrames } from "./protocol.mjs";
import { localPeerPid } from "./darwin-peerpid.mjs";
import { processStart, processUid } from "./darwin-procargs.mjs";

// This file is not a one line write because of what the other end does. The receiver reads the
// connected peer for every frame, and getsockopt(LOCAL_PEERPID) answers ENOTCONN the moment
// this side is gone — measured here, a sender that ends and destroys in the write callback has
// every frame refused, one sender at a time, with no error on either side. So the socket is
// written to and then kept, and the receiver is the side that closes it.
//
// HOLD_BOUND_MS is not a delivery guarantee and must not be read as one. It is the stop that
// keeps a hold from lasting forever when the other side never closes. Measured on this machine
// with this hold: end() fired at 1001.6 ms and the close landed at 1003.9 ms, so a receiver
// that gets to the bytes more than a second late still loses them — a 1500 ms delayed receiver
// saw ENOTCONN and zero frames. Nothing here closes that; docs/known-issues.md carries the
// residual. When the bound is what ends the hold, onHoldBound is called, so that case is an
// event rather than a silence.
const HOLD_BOUND_MS = 1_000;
const HOLD_CLOSE_GRACE_MS = 250;

export async function directSend(target, frames, { reverify, timeoutMs = 10_000, holdBoundMs = HOLD_BOUND_MS, peerPidReader = localPeerPid, onHoldBound = null } = {}) {
  const current = await reverify();
  if (current.pid !== target.pid || current.procStart !== target.procStart || current.socketPath !== target.socketPath || current.token !== target.token || current.permission.mode !== target.permission.mode) throw new Error("target identity changed before socket write");
  const wire = encodeFrames(frames);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.socketPath });
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); };
    const written = () => { if (settled) return; settled = true; clearTimeout(timer); hold(socket, { holdBoundMs, onHoldBound, target, bytesWritten: Buffer.byteLength(wire) }); resolve({ bytesWritten: Buffer.byteLength(wire) }); };
    const timer = setTimeout(() => fail(new Error("target socket write timed out")), timeoutMs);
    socket.on("error", fail);
    socket.once("connect", () => {
      try {
        const peerPid = peerPidReader(socket);
        if (peerPid !== target.pid || processUid(peerPid) !== process.getuid() || processStart(peerPid) !== target.procStart) return fail(new Error("connected target identity mismatch"));
        socket.write(wire, () => written());
      } catch (error) { fail(error); }
    });
  });
}

// Nothing is read back on this connection, so the hold ends on the receiver's own close, which
// is the normal end, or on the bound, which is the abnormal one and is reported. end first,
// destroy second: a reset would be a needless error in the other process' log. The wait is not
// charged to the caller — the promise settled when the bytes were flushed and the hold runs
// behind it — and a reporter that throws ends the report, never the socket.
function hold(socket, { holdBoundMs, onHoldBound, target, bytesWritten }) {
  socket.removeAllListeners("error");
  socket.on("error", () => socket.destroy());
  const since = Date.now();
  const closing = setTimeout(() => {
    socket.end();
    if (!onHoldBound) return;
    try { Promise.resolve(onHoldBound({ reason: "hold_bound_reached", holdBoundMs, heldMs: Date.now() - since, bytesWritten, targetPid: target.pid, targetProcStart: target.procStart })).catch(() => {}); } catch {}
  }, holdBoundMs);
  const gone = setTimeout(() => socket.destroy(), holdBoundMs + HOLD_CLOSE_GRACE_MS);
  socket.once("close", () => { clearTimeout(closing); clearTimeout(gone); });
}
