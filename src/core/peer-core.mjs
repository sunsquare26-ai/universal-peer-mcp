import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { canonicalSend, sha256 } from "./dedupe.mjs";
import { referenceMatches, requireUuid, sameUuid } from "./limits.mjs";
import { waitForEvent } from "./wait.mjs";
import { permissionRecord, publicTarget } from "./target-config.mjs";
import { satisfies, waitEvidence } from "./wait-requirements.mjs";
import { targetDiagnostic } from "./target-diagnostics.mjs";
import { resolveTarget, reverifyTarget } from "../adapters/claude-native-v1/registry.mjs";
import { normalizeProcStart, PROC_START_RENDERING } from "../adapters/claude-native-v1/darwin-procargs.mjs";
import { encodeJsonAngles, outboundFrames, parseMarker, parseReplyHeader, senderEnvelope, unwrapEnvelope } from "../adapters/claude-native-v1/protocol.mjs";
import { directSend } from "../adapters/claude-native-v1/transport.mjs";
import { protocolHeader } from "./protocol-header.mjs";
import { senderFields } from "./sender-auth.mjs";
import { acceptPost, bodyDigest, quarantine } from "./posts.mjs";

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

  constructor({ targets, store, address, resolver = resolveTarget, sender = directSend, resolverOptions = {}, onCorrelatedReply = null, inboundSpool = null, rebind = null, senderResolver = null }) {
    super(); this.targets = targets; this.store = store; this.address = address; this.resolver = resolver; this.sender = sender; this.resolverOptions = resolverOptions; this.sendLocks = new Map(); this.sendContext = new AsyncLocalStorage();
    // Succession is opt-in at construction and there is no default. A core built without it resolves
    // exactly as it always did — one id, one live row, or a refusal — because the half of succession
    // that cannot live in here is the half that rewrites the operator's table, and a core that was
    // handed no way to do that must not pretend a session moved.
    if (rebind !== null && typeof rebind !== "function") throw codedError("INVALID_REBINDER", "rebind must be a function");
    this.rebind = rebind;
    // Where an inbound body is kept. It is not the hook below and does not replace it: the hook is
    // called for a correlated reply only, and a body has to survive the frames that correlate to
    // nothing as well, which is most of them (src/core/inbound-spool.mjs).
    this.inboundSpool = inboundSpool;
    // A hook that is not callable is refused here rather than at the first reply. The frame that
    // would have found out is one that arrived correctly and was correlated correctly, and losing
    // it to a typo made months earlier is not a thing this should be capable of.
    if (onCorrelatedReply !== null && typeof onCorrelatedReply !== "function") throw codedError("INVALID_CORRELATED_REPLY_HOOK", "onCorrelatedReply must be a function");
    this.onCorrelatedReply = onCorrelatedReply;
    // M2: who wrote an inbound frame (src/core/sender-auth.mjs). The shipped daemon always passes
    // one; a core built without it records the writer's pid and treats nothing as authenticated
    // or unauthenticated, which is the pre-M2 behaviour the older tests describe.
    if (senderResolver !== null && typeof senderResolver !== "function") throw codedError("INVALID_SENDER_RESOLVER", "senderResolver must be a function");
    this.senderResolver = senderResolver;
  }

  // The list under a name rather than the bare list: an array root is not a legal
  // structuredContent on the 2025-06-18 wire, and one shape here is one shape at every layer
  // that carries it (src/mcp/tools.mjs).
  targetsList() { return { targets: Object.entries(this.targets).map(([alias, target]) => ({ alias, ...publicTarget(target) })) }; }

  async status(alias) {
    const expected = this.#target(alias); const target = await this.#resolve(expected, alias);
    if (expected.expectedDisplayName && expected.expectedDisplayName !== target.observedDisplayName) {
      const event = await this.store.append("display_name_observed", { alias, expected: expected.expectedDisplayName, observed: target.observedDisplayName }); this.emit("event", event);
    }
    return { alias, connected: true, sessionId: target.sessionId, cwdMatches: true, permission: permissionRecord(target.permission), observedDisplayName: target.observedDisplayName, pid: target.pid, procStart: target.procStart };
  }

  async send(args, internal = null) {
    // Normalize before locking, reserving or emitting; canonicalSend already hashes these IDs
    // in lowercase. Preserve the caller's object and read historic rows without migrating them.
    args = { ...args, messageId: requireUuid(args.messageId, "messageId"), threadId: requireUuid(args.threadId, "threadId"), replyTo: args.replyTo == null ? null : requireUuid(args.replyTo, "replyTo") };
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
    const target = await this.#resolve(expected, args.alias);
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
      const result = await this.sender(target, frames, { reverify: () => reverifyTarget(target, boundExpectation(expected, target), this.resolverOptions) });
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
    const expected = this.#target(args.alias); const target = await this.#resolve(expected, args.alias); const snapshot = targetSnapshot(args.alias, target);
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
      const result = await this.sender(target, frames, { reverify: () => reverifyTarget(target, boundExpectation(expected, target), this.resolverOptions) });
      const sent = await this.store.append("socket_write_complete", { messageId: args.messageId, transportMessageId, subscriptionId, alias: args.alias, bytesWritten: result.bytesWritten }); this.emit("event", sent);
    } catch (error) {
      const failed = await this.store.append("send_failed", { messageId: args.messageId, transportMessageId, subscriptionId, alias: args.alias, errorCode: error.code ?? "SEND_FAILED" }); this.emit("event", failed);
      throw codedError("DELIVERY_UNCERTAIN", "send failed; delivery is uncertain and was not retried");
    }
    return { replay: false, recovered: true, messageId: args.messageId, threadId: args.threadId, subscriptionId, transportMessageId, requestHash, alias: args.alias, status: "written" };
  }

  async wait({ messageId, require = "reply", timeoutMs = 30_000 }) {
    // What satisfies this requirement is read from one table (src/core/wait-requirements.mjs) rather
    // than named here as one event type. A reply is stronger evidence than an ACK and now answers a
    // wait for one; the reverse does not, and the reason both halves are true is written there.
    const accepted = waitEvidence(require);
    if (!accepted) throw new Error("invalid wait requirement");
    const find = () => {
      const events = this.store.list({ messageId });
      const event = events.find((entry) => satisfies(accepted, entry));
      return event ? { event, events, evidence: event.evidence ?? null } : null;
    };
    const startedAt = Date.now();
    // An expiry is a diagnosis and it used to be told to the caller and to nobody else: this
    // function returned a timeout object and never appended anything, so the ledger — the thing a
    // person reads afterwards to find out what happened — showed zero timeouts while 34 of them had
    // occurred across two days (20 distinct message ids, 2026-09-10/11). A silent expiry is
    // indistinguishable from a wait that was never made.
    //
    // The rows the answer carries are read before the line is written, so the expiry does not appear
    // inside the evidence it is reporting on, and the append cannot fail the wait: a caller told
    // nothing because the ledger is wedged is the failure this line exists to end.
    const timedOut = async () => {
      const events = this.store.list({ messageId });
      const state = durableState(events);
      await this.store.append("peer_wait_timed_out", { messageId, require, state, waitedMs: Date.now() - startedAt, timeoutMs })
        .then((event) => this.emit("event", event)).catch(() => {});
      return { timedOut: true, timeoutScope: "application_wait", nextAction: "wait_same_message_id", messageId, require, state, events };
    };
    return waitForEvent(this, find, timeoutMs, timedOut);
  }

  events(args = {}) {
    const limit = args.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("event page limit must be between 1 and 1000");
    const matching = this.store.list(args); const events = []; let bytes = 0;
    for (const event of matching) {
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (events.length >= limit || bytes + size > 512 * 1024) break;
      events.push(event); bytes += size;
    }
    const hasMore = events.length < matching.length;
    const cursor = hasMore ? (events.at(-1)?.seq ?? args.afterSeq ?? 0) : (this.store.events.at(-1)?.seq ?? 0);
    return { cursor, hasMore, events };
  }

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
    // Two readers, strict first, so a frame that parses today parses identically today. The
    // second one is for a sender with no correlation parameter to fill in
    // (`parseReplyHeader`); a line that satisfies neither is still not thrown away, because the
    // body is spooled before the outcome is decided.
    const marker = parseMarker(content) ?? parseReplyHeader(content);
    // M2: every row names its writer, and a writer that is not one of our sessions keeps no body.
    const auth = this.senderResolver ? await this.senderResolver(peer) : null;
    const who = senderFields(peer, auth);
    const unauthenticated = auth !== null && !auth.authenticated;
    if (!marker) {
      const header = protocolHeader(content);
      if (header?.verb === "PEER_POST" && header.messageId) {
        if (unauthenticated) { await quarantine(this.store, { reason: "sender_unauthenticated", content, header, who }); return null; }
        await acceptPost({ store: this.store, spool: this.inboundSpool, messageId: header.messageId, body: content, who, source: "frame" });
        return null;
      }
      if (unauthenticated) { await quarantine(this.store, { reason: "sender_unauthenticated", content, header, who }); return null; }
      return uncorrelated("no_reply_marker", { ...await this.#spool(content), ...who });
    }
    const resolved = this.#replyRequest(marker);
    if (resolved.reason) {
      if (unauthenticated) { await quarantine(this.store, { reason: resolved.reason, content, header: protocolHeader(content), who }); return null; }
      return uncorrelated(resolved.reason, { ...await this.#spool(content), ...who });
    }
    const request = resolved.request;
    this.#assertPeer(request, peer);
    // A response that names the request's own id as its id is not an answer to it (d7e3473e,
    // 2026-09-29): it is a copied line, and binding it would let any echo of a request ACK itself.
    // Checked after the writer is proven to be the target, so a wrong writer is still refused first.
    if (selfReferencing(marker)) return uncorrelated("self_referencing_response", { ...await this.#spool(content), ...who });
    const body = await this.#spool(content);
    // `messageId` is the id of the message being answered and is a uuid. The strict path records
    // the marker's own spelling of it, exactly as before; the in-band path records the row's,
    // because what that path carried was a reference and a reference is not an id.
    const event = await this.store.append(marker.type === "ack" ? "peer_ack" : "peer_reply", {
      messageId: marker.style === "inband_header" ? request.messageId : marker.replyTo,
      // An id the sender did not state is not written. `responseMessageId` is the peer's own id
      // for its reply (docs/correlated-reply-hook.md), so minting one here and recording it under
      // that name would be this daemon's number wearing the peer's label.
      ...(marker.messageId === null || marker.messageId === undefined ? {} : { responseMessageId: marker.messageId }),
      threadId: request.threadId, verdict: marker.verdict,
      evidence: marker.style === "inband_header" ? "inband_header" : "application_ack",
      peerPid: peer.pid, peerProcStart: peer.procStart, ...body
    }); this.emit("event", event);
    await this.#correlatedReply(request, { ...marker, messageId: marker.messageId ?? null, threadId: request.threadId }, peer, content);
    return null;
  }

  // The two correlations, kept apart on purpose. The strict marker names a full id and a full
  // thread and both are checked exactly as they were before this existed. The in-band header names
  // a reference, which is resolved against this ledger's own rows, and names a thread only if it
  // chose to — an absent thread is not a failed check, because the reference already bound the
  // request and the request carries the thread.
  #replyRequest(marker) {
    if (marker.style !== "inband_header") {
      const request = this.store.request(marker.replyTo);
      if (!request || !sameUuid(request.threadId, marker.threadId)) return { reason: "unknown_reply_target" };
      return { request };
    }
    const resolved = this.store.requestByReference(marker.replyTo);
    if (resolved.ambiguous) return { reason: "ambiguous_reply_reference" };
    if (!resolved.request) return { reason: "unknown_reply_target" };
    if (marker.threadId !== null && !referenceMatches(resolved.request.threadId, marker.threadId)) return { reason: "reply_thread_mismatch" };
    return { request: resolved.request };
  }

  // Called on the reply branch, where a body exists, and before the frame's fate is decided, so
  // the text is kept whether or not it correlates. A spool that fails does not cost the frame: the
  // row is written with no body reference on it and therefore claims none.
  async #spool(content) {
    if (!this.inboundSpool || typeof content !== "string" || content.length === 0) return {};
    try { return await this.inboundSpool.write(content); } catch { return { bodyStorageOmitted: "write_failed" }; }
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

  // The refusal was always loud and still is — this throws, and it throws before anything is
  // reserved, so a send against a target that is gone leaves no row to replay from. What it was
  // not is named: every way a target can fail to resolve arrived as one TARGET_UNAVAILABLE, so
  // "the session id in targets.json is not running any more" read exactly like "the cwd moved"
  // and like "the argv proof failed". Which check failed is recorded here, from a closed list and
  // with no path or message in it. The row carries no messageId: it is a diagnosis and not a
  // send, and nothing replays from it.
  async #resolve(expected, alias = null) {
    try { return await this.resolver(expected, this.resolverOptions); }
    catch (error) {
      const diagnostic = resolveReason(error);
      // One failure gets a second question asked about it, and only one: nothing live is advertising
      // the id the table holds. That is what a resumed session looks like from here, and it is the
      // only failure where a *different* live session can be the right answer. Every other one —
      // the directory moved, the socket is not private, the permission mode cannot be proven — is
      // about the session that is there, and looking at another session answers none of them.
      if (diagnostic === "no_live_session_for_session_id" && alias !== null && this.rebind) {
        try { return await this.rebind({ alias, expected, options: this.resolverOptions }); }
        catch (rebound) { throw await this.#unavailable(alias, rebindReason(rebound, diagnostic), rebound?.rebindFailedSeq); }
      }
      throw await this.#unavailable(alias, diagnostic);
    }
  }

  async #unavailable(alias, diagnostic, rebindFailedSeq = null) {
    await this.store.append("target_resolve_failed", { ...(alias === null ? {} : { alias }), reason: diagnostic, ...(Number.isInteger(rebindFailedSeq) ? { rebindFailedSeq } : {}) })
      .then((event) => this.emit("event", event)).catch(() => {});
    return Object.assign(codedError("TARGET_UNAVAILABLE", "target is unavailable"), { diagnostic });
  }

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
function uncorrelated(reason, detail = {}) { return { reason, ...detail }; }

// The expectation a re-verify is held against. A send resolves its target once and checks it again
// immediately before the socket write, and that second check re-runs the resolver against what the
// operator's table said. When a succession happened in between, the table said an id that is no
// longer live and the re-verify would refuse the very target the send just proved. So the second
// check is made against the id that answered, and against the identical expectation object when
// nothing moved — the frozen row itself, not a copy of it.
function boundExpectation(expected, target) {
  return expected.sessionId === target.sessionId ? expected : Object.freeze({ ...expected, sessionId: target.sessionId });
}

// Why a succession attempt did not produce a target. A refusal that path recognises names itself;
// anything else is an ordinary resolver failure and is read from the same closed list every other
// one is read from. A failure nothing recognises keeps the diagnosis the caller already had, which
// is the true one: the id in the table is not live.
function rebindReason(error, fallback) {
  const named = targetDiagnostic(error?.diagnostic);
  if (named) return named;
  const read = resolveReason(error);
  return read === "unrecognised_resolver_failure" ? fallback : read;
}

// The resolver's own messages, read down to a closed list. They are never republished as they
// are: `realpath` names a directory in its ENOENT, so the message is not always a string this
// package wrote. What is published is which check failed, and a failure this list does not know is
// published as exactly that rather than as one of the ones it does.
const RESOLVE_REASONS = [
  [/resolved to 0 live candidates/, "no_live_session_for_session_id"],
  [/resolved to \d+ live candidates/, "multiple_live_sessions_for_session_id"],
  [/target cwd mismatch/, "cwd_mismatch"],
  [/unsupported Claude peer protocol/, "unsupported_peer_protocol"],
  [/target process identity changed/, "process_identity_changed"],
  [/target socket is not private/, "socket_not_private"],
  [/target key is not private/, "key_not_private"],
  [/target key identity mismatch/, "key_identity_mismatch"],
  [/target argv executable mismatch/, "argv_executable_mismatch"],
  [/permission mode argv cannot be proven/, "permission_mode_unproven"],
  [/Claude sessions directory is not private/, "sessions_directory_not_private"]
];
function resolveReason(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  for (const [pattern, reason] of RESOLVE_REASONS) if (pattern.test(message)) return reason;
  return "unrecognised_resolver_failure";
}

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
      // M2: a refused frame keeps no body but keeps its digest, length and writer, so a later
      // authenticated copy can be matched to it.
      let digest = {};
      try { const content = unwrapEnvelope(frame?.message?.content, frame?.from); if (typeof content === "string" && content.length > 0) digest = bodyDigest(content); } catch {}
      await store.append("peer_frame_refused", { ...context, reason: refusalReason(error), ...(typeof error?.messageId === "string" ? { messageId: error.messageId } : {}), ...digest, ...(Number.isInteger(peer?.pid) ? { peerPid: peer.pid } : {}) }).catch(() => {});
      throw error;
    }
    // The body reference travels with the reason. Without it the row says a frame arrived and
    // matched nothing, and the text it arrived with is gone — which is the whole defect.
    if (outcome?.reason) { const { reason, ...detail } = outcome; await store.append("peer_frame_uncorrelated", { ...context, reason, ...detail }); }
  };
}

// The cause travels as the code the thrower already set, lowercased. An error message is free
// text and free text is not a cause, so anything without a code is one word.
function refusalReason(error) { return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code.toLowerCase() : "frame_handler_failed"; }
function selfReferencing(marker) {
  const own = typeof marker?.messageId === "string" ? marker.messageId.toLowerCase().replace(/-/g, "") : "";
  const target = typeof marker?.replyTo === "string" ? marker.replyTo.toLowerCase().replace(/-/g, "") : "";
  return own.length > 0 && target.length >= 8 && own.startsWith(target);
}
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
