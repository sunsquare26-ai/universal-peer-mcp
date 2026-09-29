import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { atomicPrivateWrite } from "../../core/state-paths.mjs";
import { localPeerPid } from "./darwin-peerpid.mjs";
import { SENDER_PRODUCT_NAME } from "./protocol.mjs";
import { normalizeProcStart, processIdentity, processStart } from "./darwin-procargs.mjs";

export function receiverSocketPath(stateRoot, socketDir = "/tmp/cc-socks") {
  if (typeof stateRoot !== "string" || stateRoot.length === 0) throw new Error("receiver state root is required");
  const id = crypto.createHash("sha256").update(path.resolve(stateRoot)).digest("hex").slice(0, 24);
  return path.join(socketDir, `universal-peer-mcp-${id}.sock`);
}

// How long a close waits for frames that were already accepted to finish being recorded, and how
// often it looks. The bound exists because the shipped sender holds its connection open until the
// receiver closes it (transport.mjs), so a quiesced connection never reaches EOF on its own and
// "wait for the peer" would be "wait forever". Measured: the lost window was ~5 ms wide, so a
// bound three orders of magnitude above it is not the thing that decides the outcome.
export const DEFAULT_DRAIN_MILLIS = 2000;
const DRAIN_POLL_MILLIS = 5;

// How long the whole refusal-reporting phase of a close may spend waiting, across every stranded
// frame. It is a total and not a per-frame allowance so that N stranded frames cannot multiply the
// shutdown's length by N.
//
// The reporting is best effort by design and this bound is what makes "best effort" true rather
// than aspirational. The production reporter is an `EventStore.append` (src/daemon.mjs), which
// chains onto the ledger write chain: a stuck fsync makes it a promise that never settles, not one
// that rejects, and a `try/catch` does not catch a promise that never settles. 250 ms is two
// orders of magnitude above a healthy append and is not the thing that decides the outcome.
export const DEFAULT_REFUSAL_REPORT_MILLIS = 250;

// The options `src/daemon.mjs` starts its receiver with, in one named place. It lives here and not
// inline at the call site because the wiring is the mechanism: `stateRoot` is what makes the
// address stable, and a daemon that forgets to pass it is the stale-address defect coming back.
// A function can be imported and asserted; an object literal buried in a top-level-await script
// cannot be, which is how that one line came to have no test over it.
export function receiverOptionsForState(paths, { onFrameRefused = null, onReclaimSkipped = null } = {}) {
  return { stateRoot: paths.root, onFrameRefused, onReclaimSkipped };
}

export async function startReceiver(onFrame, { sessionsDir = path.join(os.homedir(), ".claude", "sessions"), socketDir = "/tmp/cc-socks", stateRoot, peerIdentityReader = defaultPeerIdentity, onFrameRefused = null, onReclaimSkipped = null, drainMillis = DEFAULT_DRAIN_MILLIS, refusalReportMillis = DEFAULT_REFUSAL_REPORT_MILLIS } = {}) {
  // A PID address becomes stale at every restart. The state root is the durable identity of one
  // daemon lane, so its hash gives that lane one short, private socket address across restarts.
  // The first rollout still needs one re-discovery from the former PID address; later clean
  // restarts do not invalidate a recipient already holding this address.
  //
  // There used to be a `stateRoot = null` default here that fell back to the PID address without
  // saying so. That default is the defect with a friendly face: drop the one wiring line in the
  // daemon and the process comes up healthy on an address that goes stale at the next restart,
  // which is the failure this whole repair exists to close. A missing root now ends the start,
  // before any directory is touched, so a wiring regression is a start that fails and not a
  // channel that quietly rots.
  if (typeof stateRoot !== "string" || stateRoot.length === 0) throw new Error("receiver state root is required");
  await assertOwnedPrivateDirectory(sessionsDir);
  await assertOwnedPrivateDirectory(socketDir);
  const socketPath = receiverSocketPath(stateRoot, socketDir);
  await reclaimStaleRegistrations({ sessionsDir, socketDir, stateRoot, onReclaimSkipped });
  // Any existing socket left after proven-dead, same-lane row reclamation has no sufficient
  // ownership/death proof. Preserve it even if a connection probe would be refused.
  try {
    await fsp.lstat(socketPath);
    throw Object.assign(new Error("receiver socket has no proven-dead owner or is still live"), { code: "EADDRINUSE" });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const token = crypto.randomBytes(16).toString("hex");
  const sessionId = crypto.randomUUID();
  const procStart = processStart();
  const sockets = new Set(); let connections = 0;
  // One entry per connection that has unfinished work. `close()` reads it, which is the whole
  // reason it exists: before this, the only record of an accepted frame lived in a promise chain
  // captured inside `accept`, so a shutdown had no way to ask what it was about to throw away.
  const inflight = new Set();
  const server = net.createServer((socket) => {
    connections += 1;
    const state = accept(socket, token, onFrame, { peerIdentityReader, onFrameRefused, connectionId: connections });
    sockets.add(socket); inflight.add(state);
    // Retired when the connection is gone and its chain has settled — at that point no further
    // frame can be added to it, so nothing is being forgotten. Without this the set would grow
    // once per connection for the life of the daemon.
    socket.once("close", () => { sockets.delete(socket); void retire(state); });
  });
  async function retire(state) {
    await state.chain.catch(() => {});
    if (state.pending === 0) inflight.delete(state);
  }

  // Let what was already accepted finish. Returns what is still unfinished when the bound ends,
  // by connection and frame ordinal, so the caller can name it instead of guessing at it.
  //
  // Two consecutive quiet observations, not one. The first poll is what lets bytes already sitting
  // in the kernel receive buffer surface as `data`, become frames and get onto a chain; a single
  // quiet reading taken before that has happened would call an arriving frame "nothing to wait
  // for". Residual bytes are an incomplete line — the data handler drains every complete line it
  // can see synchronously — so they are waited on while they are still moving and then reported,
  // never counted as a frame that was accepted.
  // Waits for `promise`, or for the time left, whichever comes first. The timer is always cleared:
  // a shutdown must not be held open by its own bookkeeping.
  function settleWithin(promise, millis) {
    if (millis <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, millis);
      promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
  }
  function sleepUpTo(millis) { return millis <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, millis)); }
  // Waits for `promise` and says how it ended, or says "timeout" when the time ran out first.
  // It returns rather than throws, because the one thing a shutdown's reporter must not decide is
  // whether the shutdown continues. The timer is always cleared.
  function outcomeWithin(promise, millis) {
    if (millis <= 0) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), millis);
      promise.then(() => { clearTimeout(timer); resolve("fulfilled"); }, () => { clearTimeout(timer); resolve("rejected"); });
    });
  }

  async function drainAccepted(deadline) {
    let quiet = 0;
    let lastConnections = connections;
    const lastResidual = new Map();
    while (quiet < 2 && Date.now() < deadline) {
      await sleepUpTo(Math.min(DRAIN_POLL_MILLIS, deadline - Date.now()));
      const states = [...inflight];
      // Bounded by what is left of the window, not by the chain. An unbounded await here reads as a
      // stronger promise — "an accepted frame is always recorded" — and it is really a shutdown that
      // a stuck ledger write can hold open for ever, which on this channel means a daemon that will
      // not die during an operator's swap. The bound is kept honest instead: whatever is still
      // unfinished when it ends is reported and makes the exit non-zero, which is the trade this
      // repair is built on. Losing a frame loudly is recoverable; hanging the swap is not.
      await settleWithin(Promise.allSettled(states.map((state) => state.chain)), deadline - Date.now());
      // A connection accepted since the last look is work that did not exist to be waited on then,
      // so this poll is not a quiet one however empty the rest of it looks. Measured: without this,
      // a connection sitting in the listen backlog at signal time was dropped 2 of 3 times under a
      // clean exit, because it had no entry anywhere until the process accepted it.
      let busy = connections !== lastConnections;
      lastConnections = connections;
      for (const state of states) {
        const residual = state.residual;
        if (state.pending > 0 || lastResidual.get(state) !== residual) busy = true;
        lastResidual.set(state, residual);
      }
      quiet = busy ? 0 : quiet + 1;
    }
    const stranded = []; let unreadBytes = 0;
    for (const state of inflight) {
      unreadBytes += state.residual;
      for (const frameOrdinal of state.strandedOrdinals()) stranded.push({ connectionId: state.connectionId, frameOrdinal });
    }
    return { stranded, unreadBytes };
  }
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await fsp.chmod(socketPath, 0o600);
  const registryPath = path.join(sessionsDir, `${process.pid}.json`);
  const keyPath = path.join(sessionsDir, `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await atomicPrivateWrite(keyPath, `${JSON.stringify({ peerToken: token, procStart, pidDomain: "darwin" })}\n`);
  const startedAt = Date.now();
  await atomicPrivateWrite(registryPath, `${JSON.stringify({
    pid: process.pid, sessionId, cwd: process.cwd(), procStart, peerProtocol: 1,
    peerFeatures: ["notify_idle", "reply_across_default_dirs"], pidDomain: "darwin",
    // The daemon's own name in the session registry. It used to read "Claude MCP", which is a
    // claim about a client this process cannot see; what this row describes is this process, and
    // the one name it can state about itself is the program's. Taken from the same constant the
    // envelope is written with so the two cannot drift apart.
    messagingSocketPath: socketPath, name: SENDER_PRODUCT_NAME, status: "idle", startedAt, updatedAt: startedAt
  })}\n`);
  const ownedArtifacts = await Promise.all([socketPath, registryPath, keyPath].map(async (file) => ({ file, stat: await fsp.lstat(file) })));
  return {
    address: `uds:${socketPath}`, sessionId,
    // A message that was accepted is either durably recorded or the shutdown says it was not.
    //
    // The old order was: stop listening, destroy every live connection, exit. The frame handling
    // lives on a promise chain inside `accept`, and nothing waited for it, so a reply that had
    // already been authenticated and correlated could be cut off before its ledger row was
    // written — and the exit code was still 0. Measured at the window: frames sent 0 ms and 2 ms
    // after the signal were lost 3 of 3, present in neither the ledger nor the sidecar store,
    // under a clean exit. A lost reply is indistinguishable from "the peer never answered", which
    // is the one confusion this channel cannot afford.
    //
    // So: stop accepting, drain what was accepted, and only then destroy. Whatever the drain bound
    // does not reach is reported frame by frame through the same refusal channel the ledger
    // already has — so "arrived and was not recorded" is a row and not an absence — and then makes
    // this close reject, which is what turns the daemon's exit code non-zero. Silent loss is worse
    // than a loud failure; if delivery cannot be guaranteed, finding out is.
    async close({ drainMillis: drainOverride, refusalReportMillis: refusalOverride } = {}) {
      const bound = Number.isFinite(drainOverride) ? drainOverride : drainMillis;
      const refusalBound = Number.isFinite(refusalOverride) ? refusalOverride : refusalReportMillis;
      // The listening socket stays open for the length of the drain, and this order is the measured
      // half of the repair. Closing it first — which is what a shutdown naturally reaches for —
      // discards the listen backlog, and a connection the kernel had already accepted with a
      // complete frame inside it lives in that backlog until this process calls accept. Nothing in
      // `sockets` or `inflight` names it yet, so nothing can wait for it: measured at 0 ms delay,
      // 2 of 3 replies were still lost under a clean exit with the drain in place but the close
      // first. Draining first costs one bounded window during which a new sender can still be
      // served, which is the right way round: serving a late frame is not a failure, losing one is.
      const drained = await drainAccepted(Date.now() + Math.max(0, bound));
      let closeError = null;
      // Resolve-and-capture rather than reject, so the error is still propagated below but cannot
      // sit unhandled while the connections are torn down.
      const closed = new Promise((resolve) => server.close((error) => { closeError = error ?? null; resolve(); }));
      // Reported before anything is destroyed, bounded and best effort. Two things can go wrong in
      // a reporter and only one of them used to be handled here: one that *throws* was caught, but
      // one that never settles held this loop open for ever. The production reporter is an
      // `EventStore.append` (src/daemon.mjs), which chains onto the ledger write chain, so a stuck
      // fsync is exactly the second shape — and `try/catch` cannot catch it. Measured on the
      // unfixed code with a real EventStore stalled on a readerless FIFO: `close({drainMillis:0})`
      // had not settled after 8 s, so the socket cleanup, the named `RECEIVER_DRAIN_INCOMPLETE`
      // refusal, the daemon's stderr line and its exit 1 were all unreachable. That trades a loud,
      // recoverable loss for a shutdown an operator cannot complete, which is the worse half.
      //
      // So the wait gets a total bound and the rest of the close runs regardless of how reporting
      // ended. Each report is still *started* — an append that is queued may yet land — and what
      // could not be confirmed is counted onto the rejection below rather than passed over:
      // skipping the cleanup because reporting failed would swap the hang for a leaked socket, and
      // going quiet about it is the original defect this repair exists to close.
      let refusalsReported = 0;
      const refusalDeadline = Date.now() + Math.max(0, refusalBound);
      for (const frame of drained.stranded) {
        if (!onFrameRefused) break;
        const reporting = Promise.resolve().then(() => onFrameRefused({ ...frame, reason: "shutdown_before_record" }));
        // Attached now: this promise is abandoned when the bound ends, and an abandoned rejection
        // must not surface as an unhandled one on the way out.
        reporting.catch(() => {});
        if (await outcomeWithin(reporting, refusalDeadline - Date.now()) === "fulfilled") refusalsReported += 1;
      }
      for (const socket of sockets) socket.destroy();
      await closed;
      if (closeError) throw closeError;
      // A successful close means the discoverable row, its authentication key and the socket are
      // all gone. Do not turn a partial cleanup into a reported success: that is how a dead socket
      // remains selectable after a clean SIGTERM.
      const results = await Promise.allSettled(ownedArtifacts.map(unlinkOwnedArtifact));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      if (drained.stranded.length > 0) {
        throw Object.assign(new Error(`${drained.stranded.length} accepted frame(s) were not recorded before shutdown`), {
          code: "RECEIVER_DRAIN_INCOMPLETE", stranded: drained.stranded.length, unreadBytes: drained.unreadBytes,
          // Named separately because "arrived and was not recorded" and "arrived, was not recorded,
          // and the refusal could not be written down either" are two different amounts of trouble.
          refusalsReported, refusalsUnreported: drained.stranded.length - refusalsReported
        });
      }
      return { stranded: 0, unreadBytes: drained.unreadBytes };
    }
  };
}

// Remove only rows written by this product and only after their recorded process identity has
// stopped matching. Claude Code rows and live universal-peer-mcp rows are left untouched. This is
// the startup repair for a crash or hard kill, where the SIGTERM close above never ran.
export async function reclaimStaleRegistrations({ sessionsDir, socketDir = "/tmp/cc-socks", stateRoot, onReclaimSkipped = null }) {
  const laneSocket = receiverSocketPath(stateRoot, socketDir);
  await assertOwnedPrivateDirectory(sessionsDir);
  const skipped = [];
  for (const name of await fsp.readdir(sessionsDir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const registryPath = path.join(sessionsDir, name);
    let raw; let row;
    try {
      const stat = await fsp.lstat(registryPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) continue;
      raw = await fsp.readFile(registryPath, "utf8"); row = JSON.parse(raw);
    } catch { continue; }
    if (row?.name !== SENDER_PRODUCT_NAME || row.pid !== Number(name.slice(0, -5)) || typeof row.procStart !== "string") continue;
    if (!recordedProcessIsDead(row)) continue;
    // A matching product name does not establish ownership of another state lane. Old PID-only
    // addresses cannot be tied to this state root and are deliberately left for inventory.
    if (row.messagingSocketPath !== laneSocket) continue;

    // One leftover row is one lane's problem. The deletion helpers below fail closed — a key that
    // is not JSON, a key whose identity moved under them, a dead row pointing at a socket a live
    // process is serving — and that is right about the row in hand and wrong about every other row
    // in this directory. `~/.claude/sessions` is shared: the rows here were written by other lanes,
    // by older versions and by hand. Letting one of them throw out of this loop meant a lane whose
    // own socket was free could not start at all, which is a worse outcome than the leftover.
    //
    // Validation failures already skipped with `continue` above; this makes the deletion steps
    // agree with them. What is skipped is reported, so a row nobody can clean up is visible in the
    // ledger instead of being silently stepped over every start.
    try {
      await reclaimRow({ sessionsDir, socketDir, registryPath, raw, row });
    } catch (error) {
      const detail = { pid: row.pid, code: typeof error?.code === "string" ? error.code : "RECEIVER_RECLAIM_SKIPPED", reason: error?.message ?? "stale receiver row could not be reclaimed" };
      skipped.push(detail);
      try { if (onReclaimSkipped) await onReclaimSkipped(detail); } catch { /* a reporter that throws is not a reason to refuse the start */ }
    }
  }
  return { skipped };
}

// The part that deletes, split out so the loop above has one place to contain. Nothing here is
// looser than it was: the socket still has to be an owned private non-symlink socket that refuses
// connections, the key still has to match the row's `procStart`, and the row still has to be
// byte-identical to what was read. All of those still throw — they are just caught per row now.
async function reclaimRow({ sessionsDir, socketDir, registryPath, raw, row }) {
  if (!recordedProcessIsDead(row)) throw new Error("receiver process is live or unverifiable during cleanup");
  const socketPath = typeof row.messagingSocketPath === "string" ? path.resolve(row.messagingSocketPath) : null;
  const insideSocketDir = socketPath !== null && path.dirname(socketPath) === path.resolve(socketDir) && socketPath.endsWith(".sock");
  if (insideSocketDir) await reclaimStaleSocket(socketPath);
  // Re-read before unlinking. A newly published row for a recycled PID must win this race.
  let current;
  try { current = await fsp.readFile(registryPath, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (current !== raw) throw new Error("stale receiver registry changed during cleanup");
  await fsp.unlink(registryPath);
  if (socketPath !== null) {
    const keyPath = path.join(sessionsDir, `${row.pid}.${crypto.createHash("sha256").update(socketPath).digest("hex")}.key`);
    await unlinkOwnedPrivateFileIfPresent(keyPath, row.procStart);
  }
}

async function reclaimStaleSocket(socketPath) {
  let stat;
  try { stat = await fsp.lstat(socketPath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("receiver socket path is not an owned private socket");
  const listening = await socketAcceptsConnections(socketPath);
  if (listening) throw Object.assign(new Error("receiver socket is already served by a live process"), { code: "EADDRINUSE" });
  // One last identity check on the inode avoids unlinking a replacement made after the probe.
  const current = await fsp.lstat(socketPath);
  if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("receiver socket changed during cleanup");
  await fsp.unlink(socketPath);
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once("connect", () => finish(null, true));
    socket.once("error", (error) => error.code === "ECONNREFUSED" || error.code === "ENOENT" ? finish(null, false) : finish(error));
  });
}

// A failed identity lookup is not proof of death. Keep every live or ambiguous PID,
// including a recycled/foreign UID PID; only ESRCH permits stale-row reclamation.
function recordedProcessIsDead(row) {
  if (!Number.isSafeInteger(row.pid) || row.pid <= 1) return false;
  try { process.kill(row.pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function unlinkOwnedPrivateFileIfPresent(file, expectedProcStart) {
  let stat;
  try { stat = await fsp.lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("stale receiver key is not an owned private file");
  let key;
  try { key = JSON.parse(await fsp.readFile(file, "utf8")); } catch { throw new Error("stale receiver key is malformed"); }
  // A replacement daemon for a recycled PID writes a new procStart. Its key must survive even if
  // it appeared after the old registry row was read.
  if (normalizeProcStart(key?.procStart) !== normalizeProcStart(expectedProcStart)) throw new Error("stale receiver key identity changed during cleanup");
  const current = await fsp.lstat(file);
  if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("stale receiver key changed during cleanup");
  await fsp.unlink(file);
}

async function unlinkOwnedArtifact({ file, stat: expected }) {
  let current;
  try { current = await fsp.lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (current.uid !== process.getuid() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || (current.mode & 0o077) !== 0) {
    throw new Error("receiver artifact changed during cleanup");
  }
  await fsp.unlink(file);
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
  // Frames handed to `onFrame` and not yet settled, by ordinal. "Accepted" and "recorded" were the
  // same thing only by assumption before; this is the difference, readable from outside, which is
  // what lets a shutdown name what it is about to lose.
  const pendingOrdinals = new Set();
  const state = {
    connectionId,
    get chain() { return chain; },
    get pending() { return pendingOrdinals.size; },
    // Bytes read off the wire that are not yet a complete line. The loop below consumes every
    // complete line it can see before it returns, so this is never a whole frame in hiding.
    get residual() { return Buffer.byteLength(buffer); },
    strandedOrdinals() { return [...pendingOrdinals]; }
  };
  socket.setEncoding("utf8");
  // A sender that closes hard delivers its bytes and then an ECONNRESET; without a listener
  // that reset is an unhandled error event and it takes the daemon down with it.
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    buffer += chunk;
    // The ordinal of the frame being refused, which is the next one — this runs before the loop
    // has counted it. The default was the counter's current value, so an oversize first frame was
    // recorded under ordinal 0, a number that names no frame; every other refusal below passes the
    // ordinal of the frame it refused.
    if (Buffer.byteLength(buffer) > 1024 * 1024) return refuse("frame_too_large", ordinal + 1);
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
      pendingOrdinals.add(frameOrdinal);
      chain = chain.then(() => onFrame(frame, read.peer, { connectionId, frameOrdinal }))
        .then(() => { pendingOrdinals.delete(frameOrdinal); }, () => { pendingOrdinals.delete(frameOrdinal); socket.destroy(); });
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

  return state;
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
