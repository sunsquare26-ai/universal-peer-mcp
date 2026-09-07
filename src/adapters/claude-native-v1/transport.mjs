import net from "node:net";
import { encodeFrames } from "./protocol.mjs";
import { localPeerPid } from "./darwin-peerpid.mjs";
import { normalizeProcStart, processStart, processUid } from "./darwin-procargs.mjs";
import { samePermission } from "../../core/target-config.mjs";

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
  // The permission is compared as a pair. A target that was proved when the send was reserved
  // and is merely declared now has changed in the way that matters most, and comparing modes
  // alone would have called those two the same permission.
  if (current.pid !== target.pid || normalizeProcStart(current.procStart) !== normalizeProcStart(target.procStart) || current.socketPath !== target.socketPath || current.token !== target.token || !samePermission(current.permission, target.permission)) throw new Error("target identity changed before socket write");
  const wire = encodeFrames(frames);
  const intended = Buffer.byteLength(wire);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.socketPath });
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); };
    // What the write callback says, and what the socket says, and both have to agree before this
    // is a write. The callback's first argument is the error and it used to be dropped: a write
    // to a stream the receiver had already destroyed called back with ERR_STREAM_DESTROYED, this
    // resolved, and `settled` then swallowed the error event that followed — so `send` recorded
    // `socket_write_complete`, `durableState` read it back as "written", and a message that never
    // left the machine was on the ledger as one that had. Measured on Bun 1.3.11: that shape, a
    // write after `end()`, and a write to a socket whose peer has gone all call back with an
    // error and with `bytesWritten` at 0.
    //
    // The socket's own count is the second half, and it is here because the argument is a
    // promise the runtime makes and the count is a fact about this connection. A callback that
    // returns clean while the socket carried less than the wire is a failure whatever the
    // argument said. It is also the number that goes on the ledger now: what was recorded before
    // was `Buffer.byteLength(wire)`, the length we meant to write, which is the one number that
    // cannot tell a write from a refusal.
    //
    // It is not a delivery receipt and must not be read as one. A unix socket acknowledges
    // nothing; this is what this side handed to the kernel for this connection. What happens to
    // the bytes after that is docs/known-issues.md §2.
    const flushed = (error) => {
      if (settled) return;
      if (error) return fail(error);
      const carried = socket.bytesWritten;
      if (socket.destroyed || socket.errored || !(carried >= intended)) return fail(Object.assign(new Error("target socket write did not complete"), { code: "SOCKET_WRITE_INCOMPLETE" }));
      settled = true; clearTimeout(timer);
      hold(socket, { holdBoundMs, onHoldBound, target, bytesWritten: carried });
      resolve({ bytesWritten: carried, bytesIntended: intended });
    };
    const timer = setTimeout(() => fail(new Error("target socket write timed out")), timeoutMs);
    socket.on("error", fail);
    socket.once("connect", () => {
      try {
        const peerPid = peerPidReader(socket);
        if (peerPid !== target.pid || processUid(peerPid) !== process.getuid() || normalizeProcStart(processStart(peerPid)) !== normalizeProcStart(target.procStart)) return fail(new Error("connected target identity mismatch"));
        socket.write(wire, flushed);
      } catch (error) { fail(error); }
    });
  });
}

// Nothing is read back on this connection, so the hold ends on the receiver's own close, which
// is the normal end, or on the bound, which is the abnormal one and is reported. end first,
// destroy second: a reset would be a needless error in the other process' log. The wait is not
// charged to the caller — the promise settled when the bytes were flushed and the hold runs
// behind it — and a reporter that throws ends the report, never the socket.
//
// `bytesWritten` here is the socket's own count, read at the flush by the caller above, and it is
// the same number that connection's ledger row carries. A hold is only ever entered after a write
// this side could account for, so there is no shape in which this reports bytes for a write that
// did not happen.
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
