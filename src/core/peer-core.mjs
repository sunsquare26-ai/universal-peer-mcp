import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { canonicalSend, sha256 } from "./dedupe.mjs";
import { waitForEvent } from "./wait.mjs";
import { permissionRecord, publicTarget } from "./target-config.mjs";
import { resolveTarget, reverifyTarget } from "../adapters/claude-native-v1/registry.mjs";
import { normalizeProcStart, PROC_START_RENDERING } from "../adapters/claude-native-v1/darwin-procargs.mjs";
import { encodeJsonAngles, outboundFrames, parseMarker, senderEnvelope, unwrapEnvelope } from "../adapters/claude-native-v1/protocol.mjs";
import { directSend } from "../adapters/claude-native-v1/transport.mjs";

const INTERNAL_SEND = Symbol("universal-peer-mcp.internal-send");
export function milestoneSendOptions(options = {}) { return Object.freeze({ [INTERNAL_SEND]: true, ...options }); }

// The name of the one hook this core calls, and the version of its shape. A build that does not
// have it does not export this and does not list it below, so a caller that needs it can find out
// before it starts rather than by never being called: an `import { CORRELATED_REPLY_HOOK }` fails
// to link against an older build, and `PeerCore.capabilities.includes(...)` answers false at
// runtime. Both are fail-closed by construction; neither depends on this file being read.
export const CORRELATED_REPLY_HOOK = "onCorrelatedReply/v1";
export const CORE_CAPABILITIES = Object.freeze([CORRELATED_REPLY_HOOK]);

export class PeerCore extends EventEmitter {
  // The capabilities a caller can ask about without constructing anything.
  static capabilities = CORE_CAPABILITIES;

  constructor({ targets, store, address, resolver = resolveTarget, sender = directSend, resolverOptions = {}, onCorrelatedReply = null }) {
    super(); this.targets = targets; this.store = store; this.address = address; this.resolver = resolver; this.sender = sender; this.resolverOptions = resolverOptions; this.sendLocks = new Map(); this.sendContext = new AsyncLocalStorage();
    // A hook that is not callable is refused here rather than at the first reply. The frame that
    // would have found out is one that arrived correctly and was correlated correctly, and losing
    // it to a typo made months earlier is not a thing this should be capable of.
    if (onCorrelatedReply !== null && typeof onCorrelatedReply !== "function") throw codedError("INVALID_CORRELATED_REPLY_HOOK", "onCorrelatedReply must be a function");
    this.onCorrelatedReply = onCorrelatedReply;
  }

  // The list under a name rather than the bare list: an array root is not a legal
  // structuredContent on the 2025-06-18 wire, and one shape here is one shape at every layer
  // that carries it (src/mcp/tools.mjs).
  targetsList() { return { targets: Object.entries(this.targets).map(([alias, target]) => ({ alias, ...publicTarget(target) })) }; }

  async status(alias) {
    const expected = this.#target(alias); const target = await this.#resolve(expected);
    if (expected.expectedDisplayName && expected.expectedDisplayName !== target.observedDisplayName) {
      const event = await this.store.append("display_name_observed", { alias, expected: expected.expectedDisplayName, observed: target.observedDisplayName }); this.emit("event", event);
    }
    return { alias, connected: true, sessionId: target.sessionId, cwdMatches: true, permission: permissionRecord(target.permission), observedDisplayName: target.observedDisplayName, pid: target.pid, procStart: target.procStart };
  }

  async send(args, internal = null) {
    if (this.sendContext.getStore() === args.messageId) throw codedError("INTERNAL_SEND_REENTRANT", "a send reservation callback cannot re-enter the same messageId");
    const preceding = this.sendLocks.get(args.messageId) ?? Promise.resolve();
    const current = preceding.catch(() => {}).then(() => this.sendContext.run(args.messageId, () => this.#sendOnce(args, internal)));
    this.sendLocks.set(args.messageId, current);
    try { return await current; }
    finally { if (this.sendLocks.get(args.messageId) === current) this.sendLocks.delete(args.messageId); }
  }

  async #sendOnce(args, internal) {
    const privileged = internal?.[INTERNAL_SEND] === true;
    if (internal !== null && !privileged) throw codedError("INTERNAL_SEND_FORBIDDEN", "internal send options are not available");
    const expected = this.#target(args.alias);
    const canonical = canonicalSend(args); const requestHash = sha256(canonical);
    const prior = this.store.request(args.messageId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw codedError("MESSAGE_ID_CONFLICT", "messageId reuse with different content");
      if (privileged && internal.recovery === true) return this.#recoverSend(args, canonical, requestHash, prior, internal);
      const events = this.store.list({ messageId: args.messageId });
      return { replay: true, messageId: args.messageId, requestHash, status: durableState(events), events };
    }
    const target = await this.#resolve(expected);
    const subscriptionId = crypto.randomUUID();
    const snapshot = targetSnapshot(args.alias, target);
    const reservation = await this.store.reserveRequest({ messageId: args.messageId, transportMessageId: args.messageId, threadId: args.threadId, replyTo: args.replyTo ?? null, kind: args.kind, alias: args.alias, requestHash, subscriptionId, ...snapshot });
    if (!reservation.created) {
      if (reservation.event.requestHash !== requestHash) throw codedError("MESSAGE_ID_CONFLICT", "messageId reuse with different content");
      const events = this.store.list({ messageId: args.messageId });
      return { replay: true, messageId: args.messageId, requestHash, status: durableState(events), events };
    }
    const requested = reservation.event; this.emit("event", requested);
    if (privileged && typeof internal.afterReservation === "function") await internal.afterReservation({ request: requested, transportMessageId: args.messageId, subscriptionId, targetSnapshot: snapshot, recovery: false });
    // The canonical form is the hash input and stays exactly as it was hashed; what goes on the
    // wire is that same document with its angle brackets written as JSON escapes, because the
    // envelope's shield would otherwise cut into a finished JSON line (see `encodeJsonAngles`).
    // A privileged wireBody is not JSON — it is a marker line and, for the extensions that have
    // one, a payload the extension serialized itself — so it arrives already encoded at its own
    // serialization boundary and is written as given.
    const body = privileged && typeof internal.wireBody === "string" ? internal.wireBody : encodeJsonAngles(canonical);
    // `target.permission` is a fact about the target, so it stays where it is true — the snapshot
    // above and `peer_status`. It is not sender metadata and it does not reach the wire: the two
    // builders below are handed our address and nothing about anyone's permission mode.
    const content = senderEnvelope({ from: this.address, body });
    const frames = outboundFrames({ token: target.token, targetSessionId: target.sessionId, senderAddress: this.address, messageId: args.messageId, subscriptionId, content });
    try {
      const result = await this.sender(target, frames, { reverify: () => reverifyTarget(target, expected, this.resolverOptions) });
      const sent = await this.store.append("socket_write_complete", { messageId: args.messageId, transportMessageId: args.messageId, subscriptionId, alias: args.alias, bytesWritten: result.bytesWritten }); this.emit("event", sent);
    } catch (error) {
      const failed = await this.store.append("send_failed", { messageId: args.messageId, subscriptionId, alias: args.alias, errorCode: error.code ?? "SEND_FAILED" }); this.emit("event", failed);
      throw codedError("DELIVERY_UNCERTAIN", "send failed; delivery is uncertain and was not retried");
    }
    return { replay: false, messageId: args.messageId, threadId: args.threadId, subscriptionId, requestHash, alias: args.alias, status: "written" };
  }

  async #recoverSend(args, canonical, requestHash, prior, internal) {
    const events = this.store.list({ messageId: args.messageId });
    if (events.some((event) => event.type === "peer_terminal_failure")) throw codedError("RECOVERY_FORBIDDEN", "terminal messages cannot be recovered");
    const expected = this.#target(args.alias); const target = await this.#resolve(expected); const snapshot = targetSnapshot(args.alias, target);
    assertSameSnapshot(prior, snapshot);
    const transportMessageId = crypto.randomUUID(); const subscriptionId = crypto.randomUUID();
    const reservation = await this.store.reserveRecovery({ messageId: args.messageId, transportMessageId, subscriptionId, requestHash, alias: args.alias, ...snapshot });
    if (!reservation.created) return { replay: true, messageId: args.messageId, requestHash, status: durableState(this.store.list({ messageId: args.messageId })), events: this.store.list({ messageId: args.messageId }) };
    this.emit("event", reservation.event);
    if (typeof internal.afterReservation === "function") await internal.afterReservation({ request: prior, transportMessageId, subscriptionId, targetSnapshot: snapshot, recovery: true });
    // The same encoding the first transport applied, for the same reason and at the same
    // boundary (`#sendOnce`). One message, two transports, and the way a body is written on the
    // wire is not one of the things that may differ between them: this branch built its line out
    // of the raw canonical form, so every spelling of the closing delimiter but the one JSON has
    // an escape for went out as an escape JSON does not have, and the far side could not parse
    // the body at all. The hash is still taken over the unencoded form above.
    const body = typeof internal.wireBody === "string" ? internal.wireBody : encodeJsonAngles(canonical);
    const content = senderEnvelope({ from: this.address, body });
    const frames = outboundFrames({ token: target.token, targetSessionId: target.sessionId, senderAddress: this.address, messageId: transportMessageId, subscriptionId, content });
    try {
      const result = await this.sender(target, frames, { reverify: () => reverifyTarget(target, expected, this.resolverOptions) });
      const sent = await this.store.append("socket_write_complete", { messageId: args.messageId, transportMessageId, subscriptionId, alias: args.alias, bytesWritten: result.bytesWritten }); this.emit("event", sent);
    } catch (error) {
      const failed = await this.store.append("send_failed", { messageId: args.messageId, transportMessageId, subscriptionId, alias: args.alias, errorCode: error.code ?? "SEND_FAILED" }); this.emit("event", failed);
      throw codedError("DELIVERY_UNCERTAIN", "send failed; delivery is uncertain and was not retried");
    }
    return { replay: false, recovered: true, messageId: args.messageId, threadId: args.threadId, subscriptionId, transportMessageId, requestHash, alias: args.alias, status: "written" };
  }

  async wait({ messageId, require = "reply", timeoutMs = 30_000 }) {
    const wanted = { ack: "peer_ack", reply: "peer_reply", idle: "peer_idle_notice", delivery: "peer_message_status", terminal: "peer_terminal_failure" }[require];
    if (!wanted) throw new Error("invalid wait requirement");
    const find = () => {
      const events = this.store.list({ messageId });
      const event = events.find((entry) => entry.type === wanted && (require !== "delivery" || entry.status === "delivered"));
      return event ? { event, events, evidence: event.evidence ?? null } : null;
    };
    const timedOut = () => { const events = this.store.list({ messageId }); return { timedOut: true, messageId, require, state: durableState(events), events }; };
    return waitForEvent(this, find, timeoutMs, timedOut);
  }

  events(args) { return { cursor: this.store.events.at(-1)?.seq ?? 0, events: this.store.list(args) }; }

  // A frame ends in one of three places and the caller is told which: taken (null), arrived and
  // matched nothing this daemon is waiting for (a reason), or written by a process that is not
  // the one the message it answers was sent to (a throw). "Matched nothing" never carries a
  // messageId — there is none. The id such a frame names is an unverified claim about somebody
  // else's ledger, and recording it would make the claim look checked.
  async acceptFrame(frame, peer) {
    if (frame.type === "control" && frame.action === "peer_message_status" && typeof frame.orig_msg_id === "string") {
      const request = this.store.requestByTransport(frame.orig_msg_id); if (!request) return uncorrelated("unknown_message_status");
      this.#assertPeer(request, peer);
      if (!["held", "delivered", "denied", "expired", "refused", "dropped"].includes(frame.status)) throw new Error("invalid status");
      const terminal = ["denied", "expired", "refused", "dropped"].includes(frame.status);
      const event = await this.store.append(terminal ? "peer_terminal_failure" : "peer_message_status", { messageId: request.messageId, transportMessageId: frame.orig_msg_id, status: frame.status, evidence: "message_status", peerPid: peer.pid, peerProcStart: peer.procStart, sourceAddress: typeof frame.from === "string" ? frame.from : null }); this.emit("event", event); return null;
    }
    if (frame.type === "control" && frame.action === "peer_idle_notice" && typeof frame.orig_msg_id === "string") {
      const request = this.store.requestBySubscription(frame.orig_msg_id); if (!request) return uncorrelated("unknown_idle_notice");
      this.#assertPeer(request, peer);
      // The branch above checks its status against a closed list; this one wrote whatever came in
      // the frame. The published event contract says `state` is a string and forbids the rest, so
      // an object or a number here is a row the read tools cannot return — for that messageId, on
      // every call, with no cursor past it. The peer's own frame schema types this as a string, so
      // anything else is a malformed frame and is refused as one. The length bound is this
      // implementation's, not the contract's: a state is a word.
      if (typeof frame.state !== "string" || Buffer.byteLength(frame.state) > 256) throw new Error("invalid state");
      const event = await this.store.append("peer_idle_notice", { messageId: request.messageId, subscriptionId: frame.orig_msg_id, state: frame.state, evidence: "idle_notice", peerPid: peer.pid, peerProcStart: peer.procStart }); this.emit("event", event); return null;
    }
    // A peer running this package answers inside an envelope, and `parseMarker` is anchored at the
    // first byte of the first line — which, in a wrapped message, is `<`. So the envelope comes
    // off first, with the one reader the extensions use (`unwrapEnvelope`), and an unwrapped
    // message goes through unchanged.
    const content = unwrapEnvelope(frame?.message?.content, frame?.from);
    const marker = parseMarker(content); if (!marker) return uncorrelated("no_reply_marker");
    const request = this.store.request(marker.replyTo); if (!request || request.threadId !== marker.threadId) return uncorrelated("unknown_reply_target");
    this.#assertPeer(request, peer);
    const event = await this.store.append(marker.type === "ack" ? "peer_ack" : "peer_reply", { messageId: marker.replyTo, responseMessageId: marker.messageId, threadId: marker.threadId, verdict: marker.verdict, evidence: "application_ack", peerPid: peer.pid, peerProcStart: peer.procStart }); this.emit("event", event);
    await this.#correlatedReply(request, marker, peer, content);
    return null;
  }

  // Called for a reply that was authenticated and correlated, and for nothing else. That is the
  // whole reason it exists beside the frame observers: an observer is called for every frame that
  // arrives, correlated or not, so it cannot tell an answer to something we sent from anything
  // else that came down the socket.
  //
  // Two of the arguments are the point. `alias` is read off the request this reply is bound to —
  // the row the ledger wrote when the message went out — and never off the frame, which is an
  // unverified claim by the writer. `body` is the text the peer wrote, which the ledger does not
  // keep and must not: a message body is the caller's content, and the event log is read by tools
  // whose contract carries no room for it. It is handed to the hook and dropped.
  //
  // A hook that throws does not undo the reply, which is already durable and already correct, and
  // does not refuse the frame either — the peer did nothing wrong and would see its connection
  // destroyed for our consumer's fault. It is recorded, under the code the thrower set.
  async #correlatedReply(request, marker, peer, body) {
    if (!this.onCorrelatedReply) return;
    try {
      await this.onCorrelatedReply({
        requestMessageId: request.messageId, responseMessageId: marker.messageId, threadId: marker.threadId,
        alias: request.targetAlias, verdict: marker.verdict, body,
        peer: { pid: peer.pid, procStart: peer.procStart }, evidence: "application_ack"
      });
    } catch (error) {
      const failed = await this.store.append("peer_reply_hook_failed", { messageId: request.messageId, alias: request.targetAlias, errorCode: typeof error?.code === "string" ? error.code : "CORRELATED_REPLY_HOOK_FAILED" }).catch(() => null);
      if (failed) this.emit("event", failed);
    }
  }

  // The message this frame answers is ours, so its id is a checked fact and travels with the
  // refusal; that is what puts the refusal in front of a wait on that message.
  #assertPeer(request, peer) {
    try { assertSnapshotRendering(request, "SNAPSHOT_RENDERING_UNVERSIONED"); }
    catch (error) { throw Object.assign(error, { messageId: request.messageId }); }
    if (!peer || peer.pid !== request.targetPid || normalizeProcStart(peer.procStart) !== normalizeProcStart(request.targetProcStart)) throw Object.assign(codedError("INBOUND_IDENTITY_MISMATCH", "inbound peer identity mismatch"), { messageId: request.messageId });
  }

  // The allowlist question on its own, for a caller that has a target to send to but no alias in
  // its arguments to be checked on the way in. The table this holds is the table the caller
  // checked — a command whose digest is not this daemon's does not reach dispatch — so asking it
  // is asking the current allowlist, and asking it before anything is written is what keeps a
  // refused send from leaving a ledger row behind it.
  assertTarget(alias) { this.#target(alias); }

  async #resolve(expected) { try { return await this.resolver(expected, this.resolverOptions); } catch { throw codedError("TARGET_UNAVAILABLE", "target is unavailable"); } }

  #target(alias) { const target = this.targets[alias]; if (!target) throw codedError("TARGET_UNAVAILABLE", `target alias is not allowlisted: ${alias}`); return target; }
}

// The two permission fields are taken in one statement from the one accessor, so a snapshot
// that records a mode without recording how the mode was known is not a shape this function
// can produce. A snapshot is what a recovery is compared against later, and a mode that was
// proved then and is declared now has to read as a different snapshot.
function targetSnapshot(alias, target) {
  const { mode: targetPermissionMode, verifiedBy: targetPermissionVerifiedBy } = permissionRecord(target.permission);
  return { targetAlias: alias, targetSessionId: target.sessionId, targetCwd: target.cwd, targetSocketPath: target.socketPath, targetPid: target.pid, targetProcStart: target.procStart, targetProcStartRendering: PROC_START_RENDERING, targetPermissionMode, targetPermissionVerifiedBy };
}

// A start time on disk is a string, and the string does not say who rendered it. Pinning the
// rendering fixed the values this build produces and did nothing for the ones already written: a
// snapshot from an earlier build holds the reader's local zone and the reader's locale, so two
// strings that differ may name one instant and two that match may name two. Neither answer from
// such a comparison is worth anything, and the one that matches is worse, because it is the one
// that gets recorded as proof. So a snapshot now names its rendering, and a snapshot that does not
// name one is not compared — it stops here, under its own reason, for a person to clear.
export function assertSnapshotRendering(snapshot, code) {
  if (snapshot?.targetProcStartRendering !== PROC_START_RENDERING) {
    throw codedError(code, "the recorded target identity was rendered by an earlier build and cannot be compared");
  }
}

function assertSameSnapshot(request, snapshot) {
  assertSnapshotRendering(request, "SNAPSHOT_RENDERING_UNVERSIONED");
  for (const key of Object.keys(snapshot)) if (request[key] !== snapshot[key]) throw codedError("RECOVERY_FORBIDDEN", "target identity changed since the original send");
}

function durableState(events) {
  if (events.some((event) => event.type === "peer_terminal_failure")) return "terminal";
  if (events.some((event) => event.type === "peer_reply")) return "replied";
  if (events.some((event) => event.type === "peer_ack")) return "acknowledged";
  if (events.some((event) => event.type === "peer_idle_notice")) return "idle";
  if (events.some((event) => event.type === "peer_message_status" && event.status === "delivered")) return "delivered";
  if (events.some((event) => event.type === "peer_message_status" && event.status === "held")) return "held";
  if (events.some((event) => event.type === "send_failed")) return "uncertain_failure";
  if (events.some((event) => event.type === "socket_write_complete")) return "written";
  if (events.some((event) => event.type === "send_requested")) return "requested";
  return "unknown";
}
function uncorrelated(reason) { return { reason }; }

// The daemon's frame handler, exported so that what the daemon runs is what a test can run.
// core first and then the observers, and the ledger gets a line for every frame that did not end
// where it was aimed: a refusal when the writer was the wrong process or a handler rejected the
// frame, an uncorrelated note when nothing was waiting for it. An observer that took the frame
// answers truthily and that answer outranks core's "matched nothing", which is how a milestone
// completion — not a core reply marker — stays off the uncorrelated list. Recording never
// replaces the failure it is recording: the original error is what propagates, and the
// connection ends on it exactly as before. These records are the ledger's, not the façade's: the
// public event contract does not carry them (docs/known-issues.md).
export function frameObserver({ core, store, observers = [] }) {
  return async (frame, peer, context = {}) => {
    let outcome;
    try {
      outcome = await core.acceptFrame(frame, peer);
      for (const observe of observers) if (await observe(frame, peer)) outcome = null;
    } catch (error) {
      await store.append("peer_frame_refused", { ...context, reason: refusalReason(error), ...(typeof error?.messageId === "string" ? { messageId: error.messageId } : {}) }).catch(() => {});
      throw error;
    }
    if (outcome?.reason) await store.append("peer_frame_uncorrelated", { ...context, reason: outcome.reason });
  };
}

// The cause travels as the code the thrower already set, lowercased. An error message is free
// text and free text is not a cause, so anything without a code is one word.
function refusalReason(error) { return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code.toLowerCase() : "frame_handler_failed"; }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
