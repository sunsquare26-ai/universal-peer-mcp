import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { canonicalSend, sha256 } from "./dedupe.mjs";
import { waitForEvent } from "./wait.mjs";
import { publicTarget } from "./target-config.mjs";
import { resolveTarget, reverifyTarget } from "../adapters/claude-native-v1/registry.mjs";
import { outboundFrames, parseMarker, senderEnvelope } from "../adapters/claude-native-v1/protocol.mjs";
import { directSend } from "../adapters/claude-native-v1/transport.mjs";

const INTERNAL_SEND = Symbol("claude-peer-mcp.internal-send");
export function milestoneSendOptions(options = {}) { return Object.freeze({ [INTERNAL_SEND]: true, ...options }); }

export class PeerCore extends EventEmitter {
  constructor({ targets, store, address, resolver = resolveTarget, sender = directSend, resolverOptions = {} }) {
    super(); this.targets = targets; this.store = store; this.address = address; this.resolver = resolver; this.sender = sender; this.resolverOptions = resolverOptions; this.sendLocks = new Map(); this.sendContext = new AsyncLocalStorage();
  }

  targetsList() { return Object.entries(this.targets).map(([alias, target]) => ({ alias, ...publicTarget(target) })); }

  async status(alias) {
    const expected = this.#target(alias); const target = await this.#resolve(expected);
    if (expected.expectedDisplayName && expected.expectedDisplayName !== target.observedDisplayName) {
      const event = await this.store.append("display_name_observed", { alias, expected: expected.expectedDisplayName, observed: target.observedDisplayName }); this.emit("event", event);
    }
    return { alias, connected: true, sessionId: target.sessionId, cwdMatches: true, permission: target.permission, observedDisplayName: target.observedDisplayName, pid: target.pid, procStart: target.procStart };
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
    const body = privileged && typeof internal.wireBody === "string" ? internal.wireBody : canonical;
    const content = senderEnvelope({ from: this.address, body, permissionMode: target.permission.mode });
    const frames = outboundFrames({ token: target.token, targetSessionId: target.sessionId, senderAddress: this.address, permissionMode: target.permission.mode, messageId: args.messageId, subscriptionId, content });
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
    const body = typeof internal.wireBody === "string" ? internal.wireBody : canonical;
    const content = senderEnvelope({ from: this.address, body, permissionMode: target.permission.mode });
    const frames = outboundFrames({ token: target.token, targetSessionId: target.sessionId, senderAddress: this.address, permissionMode: target.permission.mode, messageId: transportMessageId, subscriptionId, content });
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
      const event = await this.store.append("peer_idle_notice", { messageId: request.messageId, subscriptionId: frame.orig_msg_id, state: frame.state, evidence: "idle_notice", peerPid: peer.pid, peerProcStart: peer.procStart }); this.emit("event", event); return null;
    }
    const content = frame?.message?.content;
    const marker = parseMarker(content); if (!marker) return uncorrelated("no_reply_marker");
    const request = this.store.request(marker.replyTo); if (!request || request.threadId !== marker.threadId) return uncorrelated("unknown_reply_target");
    this.#assertPeer(request, peer);
    const event = await this.store.append(marker.type === "ack" ? "peer_ack" : "peer_reply", { messageId: marker.replyTo, responseMessageId: marker.messageId, threadId: marker.threadId, verdict: marker.verdict, evidence: "application_ack", peerPid: peer.pid, peerProcStart: peer.procStart }); this.emit("event", event); return null;
  }

  // The message this frame answers is ours, so its id is a checked fact and travels with the
  // refusal; that is what puts the refusal in front of a wait on that message.
  #assertPeer(request, peer) {
    if (!peer || peer.pid !== request.targetPid || peer.procStart !== request.targetProcStart) throw Object.assign(codedError("INBOUND_IDENTITY_MISMATCH", "inbound peer identity mismatch"), { messageId: request.messageId });
  }

  async #resolve(expected) { try { return await this.resolver(expected, this.resolverOptions); } catch { throw codedError("TARGET_UNAVAILABLE", "target is unavailable"); } }

  #target(alias) { const target = this.targets[alias]; if (!target) throw codedError("TARGET_UNAVAILABLE", `target alias is not allowlisted: ${alias}`); return target; }
}

function targetSnapshot(alias, target) {
  return { targetAlias: alias, targetSessionId: target.sessionId, targetCwd: target.cwd, targetSocketPath: target.socketPath, targetPid: target.pid, targetProcStart: target.procStart, targetPermissionMode: target.permission.mode, targetPermissionVerifiedBy: target.permission.verifiedBy };
}
function assertSameSnapshot(request, snapshot) {
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
function uncorrelated(reason) { return { correlated: false, reason }; }

// The daemon's frame handler, exported so that what the daemon runs is what a test can run.
// core first and then the observers, in that order, and the ledger gets a line for every frame
// that did not end where it was aimed: a refusal when the writer was the wrong process or a
// handler rejected the frame, an uncorrelated note when nothing was waiting for it. An observer
// that took the frame answers truthily and that answer outranks core's "matched nothing", which
// is how a milestone completion — not a core reply marker — stays off the uncorrelated list.
// Recording never replaces the failure it is recording: the original error is what propagates,
// and the connection ends on it exactly as before.
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

// The cause travels as the code the thrower already set, lowercased. A message is free text and
// free text does not belong in a field the façade publishes, so anything without a code is one
// word.
function refusalReason(error) { return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code.toLowerCase() : "frame_handler_failed"; }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
