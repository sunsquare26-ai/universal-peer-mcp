import { EventEmitter } from "node:events";
import { assertSnapshotRendering, milestoneSendOptions } from "../../core/peer-core.mjs";
import { sha256 } from "../../core/dedupe.mjs";
import { waitForEvent } from "../../core/wait.mjs";
import { requireUuid } from "../../core/limits.mjs";
import { redactPublic } from "../../mcp/redact.mjs";
import { normalizeProcStart } from "../../adapters/claude-native-v1/darwin-procargs.mjs";
import { unwrapEnvelope } from "../../adapters/claude-native-v1/protocol.mjs";

const MARKER = /^MILESTONE_COMPLETED v=1 message_id=([0-9a-f-]{36}) thread_id=([0-9a-f-]{36}) reply_to=([0-9a-f-]{36})$/i;
const HASH = /^[0-9a-f]{64}$/;
const REQUIRED = ["instruction_id", "attempt_id", "milestone_id", "files", "tests", "blockers", "last_signal_at"];
const OPTIONAL = ["manifest_hash", "plan_hash", "preview_url"];

export class MilestoneExtension extends EventEmitter {
  constructor({ store, core }) { super(); this.store = store; this.core = core; this.chain = Promise.resolve(); }

  observeFrame(frame, peer) { const operation = this.chain.then(() => this.#observe(frame, peer)); this.chain = operation.catch(() => {}); return operation; }

  status({ completionMessageId = null, attemptId = null } = {}) {
    if ((completionMessageId === null) === (attemptId === null)) throw coded("MILESTONE_IDENTITY_REQUIRED", "provide exactly one milestone identity");
    if (completionMessageId !== null) requireUuid(completionMessageId, "completionMessageId");
    if (attemptId !== null) requireUuid(attemptId, "attemptId");
    const completion = completionMessageId ? this.#completion(completionMessageId) : this.#completionByAttempt(attemptId);
    return completion ? this.#view(completion) : { found: false, complete: false, state: "not_found", cursor: this.#cursor() };
  }

  list({ afterSeq = 0, milestoneId = null, attemptId = null } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const completions = this.store.events.filter((event) => event.type === "milestone_completion_accepted" && event.seq > afterSeq)
      .filter((event) => (!milestoneId || event.milestoneId === milestoneId) && (!attemptId || event.attemptId === attemptId));
    return { cursor: this.#cursor(), milestones: completions.map((event) => this.#view(event)) };
  }

  async wait({ afterSeq = 0, completionMessageId = null, attemptId = null, timeoutMs = 30_000 } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const find = () => {
      const events = this.store.events.filter((event) => event.seq > afterSeq && event.type.startsWith("milestone_") && (!completionMessageId || event.completionMessageId === completionMessageId) && (!attemptId || event.attemptId === attemptId));
      if (!events.length) return null;
      const completion = completionMessageId ? this.#completion(completionMessageId) : attemptId ? this.#completionByAttempt(attemptId) : this.#completion(events.find((event) => event.completionMessageId)?.completionMessageId);
      return { cursor: this.#cursor(), events: events.map(publicMilestoneEvent), milestone: completion ? this.#view(completion) : null };
    };
    return waitForEvent(this, find, Math.min(Math.max(timeoutMs, 1), 300_000), () => ({ cursor: this.#cursor(), events: [], milestone: null, timedOut: true }));
  }

  recover({ completionMessageId, payloadHash }) { const operation = this.chain.then(() => this.#recover(completionMessageId, payloadHash)); this.chain = operation.catch(() => {}); return operation; }

  reconcile() { const operation = this.chain.then(async () => { for (const completion of this.store.events.filter((event) => event.type === "milestone_completion_accepted")) await this.#reconcileDelivered(completion); }); this.chain = operation.catch(() => {}); return operation; }

  async #observe(frame, peer) {
    if (frame?.type === "control" && frame.action === "peer_message_status") return this.#observeAckStatus(frame, peer);
    const content = unwrapEnvelope(frame?.message?.content, frame?.from);
    if (typeof content !== "string" || !content.startsWith("MILESTONE_COMPLETED ")) return;
    const marker = parseCompletion(content); if (!marker) throw coded("INVALID_MILESTONE", "invalid milestone completion");
    return this.#acceptCompletion(frame, peer, marker);
  }

  async #acceptCompletion(frame, peer, marker) {
    const request = this.store.request(marker.replyTo);
    if (!request || request.threadId !== marker.threadId || marker.payload.instruction_id !== marker.replyTo) throw coded("MILESTONE_CORRELATION_MISMATCH", "milestone completion is not bound to its instruction");
    this.#assertExactIdentity(request, peer, frame.from);
    const payloadHash = sha256(marker.canonicalPayload); const prior = this.#completion(marker.messageId);
    if (prior) {
      if (prior.payloadHash === payloadHash && prior.threadId === marker.threadId && prior.instructionId === marker.replyTo) return this.#append("milestone_completion_duplicate", { completionMessageId: marker.messageId, attemptId: prior.attemptId, payloadHash, transportMessageId: frame.msg_id ?? null });
      await this.#append("milestone_completion_conflict", { incomingCompletionMessageId: marker.messageId, incomingAttemptId: marker.payload.attempt_id, existingCompletionMessageId: prior.completionMessageId, incomingPayloadHash: payloadHash, existingPayloadHash: prior.payloadHash });
      throw coded("MILESTONE_CONFLICT", "incoming completion conflicts with a recorded completion");
    }
    const attempt = this.#completionByAttempt(marker.payload.attempt_id);
    if (attempt) {
      await this.#append("milestone_completion_conflict", { incomingCompletionMessageId: marker.messageId, incomingAttemptId: marker.payload.attempt_id, existingCompletionMessageId: attempt.completionMessageId, incomingPayloadHash: payloadHash, existingPayloadHash: attempt.payloadHash });
      throw coded("MILESTONE_CONFLICT", "incoming attempt identifier is already used");
    }
    const accepted = await this.#append("milestone_completion_accepted", {
      completionMessageId: marker.messageId, attemptId: marker.payload.attempt_id, milestoneId: marker.payload.milestone_id,
      instructionId: marker.replyTo, threadId: marker.threadId, payloadHash, payload: marker.payload,
      targetAlias: request.targetAlias, targetSessionId: request.targetSessionId, targetCwd: request.targetCwd,
      targetSocketPath: request.targetSocketPath, targetPid: request.targetPid, targetProcStart: request.targetProcStart,
      targetProcStartRendering: request.targetProcStartRendering,
      targetPermissionMode: request.targetPermissionMode, targetPermissionVerifiedBy: request.targetPermissionVerifiedBy
    });
    const prepared = await this.#append("milestone_ack_prepared", { completionMessageId: marker.messageId, attemptId: accepted.attemptId, ackMessageId: deterministicUuid(marker.messageId), threadId: marker.threadId, payloadHash });
    return this.#sendAck(accepted, prepared, false);
  }

  async #sendAck(completion, prepared, recovery) {
    const body = ackBody(prepared.ackMessageId, completion.threadId, completion.completionMessageId, completion.payloadHash);
    const args = { alias: completion.targetAlias, messageId: prepared.ackMessageId, threadId: completion.threadId, replyTo: completion.completionMessageId, kind: "milestone_ack", body };
    const result = await this.core.send(args, milestoneSendOptions({ recovery, wireBody: body, afterReservation: async ({ transportMessageId, subscriptionId, targetSnapshot }) => {
      await this.#append("milestone_ack_send_reserved", { completionMessageId: completion.completionMessageId, attemptId: completion.attemptId, ackMessageId: prepared.ackMessageId, ackTransportMessageId: transportMessageId, ackSubscriptionId: subscriptionId, threadId: completion.threadId, payloadHash: completion.payloadHash, reason: recovery ? "explicit_recovery" : "initial", ...targetSnapshot });
    } }));
    return { completionMessageId: completion.completionMessageId, ackMessageId: prepared.ackMessageId, complete: false, state: result.replay ? "ack_reserved" : "ack_written" };
  }

  async #recover(completionMessageId, payloadHash) {
    requireUuid(completionMessageId, "completionMessageId"); if (!HASH.test(payloadHash)) throw coded("MILESTONE_IDENTITY_MISMATCH", "invalid milestone payload hash");
    const completion = this.#completion(completionMessageId); if (!completion || completion.payloadHash !== payloadHash) throw coded("MILESTONE_IDENTITY_MISMATCH", "milestone recovery identity mismatch");
    // A recovery arrives with no alias in it, so the allowlist check that stands in front of
    // every call that names one stands in front of nothing here. The alias it is aimed at is on
    // the completion, recorded when that completion arrived, and a binding recorded then is not a
    // licence to reach a target the operator has since taken off the table — the recording is
    // evidence about the past, and the allowlist is a decision about now. So the table is asked,
    // and it is asked before anything is appended: a recovery that will not be sent leaves no
    // prepared ACK behind it, and the completion stays exactly as recoverable as it was for
    // whenever the operator puts the target back.
    this.core.assertTarget(completion.targetAlias);
    await this.#reconcileDelivered(completion);
    const view = this.#view(completion); if (view.complete) return { ...view, alreadyDelivered: true }; if (view.state === "terminal") throw coded("MILESTONE_RECOVERY_FORBIDDEN", "terminal milestone ACK cannot be recovered");
    let prepared = this.#events(completionMessageId).find((event) => event.type === "milestone_ack_prepared");
    if (!prepared) prepared = await this.#append("milestone_ack_prepared", { completionMessageId, attemptId: completion.attemptId, ackMessageId: deterministicUuid(completionMessageId), threadId: completion.threadId, payloadHash });
    const reservations = this.#events(completionMessageId).filter((event) => event.type === "milestone_ack_send_reserved");
    if (reservations.some((event) => event.reason === "explicit_recovery")) return { ...view, alreadyRecovered: true };
    await this.#sendAck(completion, prepared, this.store.request(prepared.ackMessageId) !== null);
    return this.#view(completion);
  }

  async #reconcileDelivered(completion) {
    const milestoneEvents = this.#events(completion.completionMessageId);
    if (milestoneEvents.some((event) => event.type === "milestone_ack_delivered")) return;
    for (const reserved of milestoneEvents.filter((event) => event.type === "milestone_ack_send_reserved")) {
      const delivered = this.store.events.find((event) => event.type === "peer_message_status"
        && event.messageId === reserved.ackMessageId && event.transportMessageId === reserved.ackTransportMessageId
        && event.status === "delivered" && event.peerPid === reserved.targetPid && normalizeProcStart(event.peerProcStart) === normalizeProcStart(reserved.targetProcStart)
        && event.sourceAddress === `uds:${reserved.targetSocketPath}`);
      if (delivered) {
        await this.#append("milestone_ack_delivered", { completionMessageId: completion.completionMessageId, attemptId: completion.attemptId, ackMessageId: reserved.ackMessageId, ackTransportMessageId: reserved.ackTransportMessageId, ackSubscriptionId: reserved.ackSubscriptionId, evidence: "message_status" });
        return;
      }
    }
  }

  async #observeAckStatus(frame, peer) {
    if (typeof frame.orig_msg_id !== "string") return;
    const reserved = this.store.events.find((event) => event.type === "milestone_ack_send_reserved" && event.ackTransportMessageId === frame.orig_msg_id); if (!reserved) return;
    const completion = this.#completion(reserved.completionMessageId); if (!completion) return; this.#assertExactIdentity(reserved, peer, frame.from);
    const events = this.#events(completion.completionMessageId); if (events.some((event) => event.type === "milestone_ack_delivered")) return;
    if (frame.status === "delivered") return this.#append("milestone_ack_delivered", { completionMessageId: completion.completionMessageId, attemptId: completion.attemptId, ackMessageId: reserved.ackMessageId, ackTransportMessageId: reserved.ackTransportMessageId, ackSubscriptionId: reserved.ackSubscriptionId, evidence: "message_status" });
    if (frame.status === "held") return this.#append("milestone_ack_held", { completionMessageId: completion.completionMessageId, attemptId: completion.attemptId, ackMessageId: reserved.ackMessageId, ackTransportMessageId: reserved.ackTransportMessageId, ackSubscriptionId: reserved.ackSubscriptionId });
    if (["denied", "expired", "refused", "dropped"].includes(frame.status)) return this.#append("milestone_ack_terminal_failure", { completionMessageId: completion.completionMessageId, attemptId: completion.attemptId, ackMessageId: reserved.ackMessageId, ackTransportMessageId: reserved.ackTransportMessageId, status: frame.status });
  }

  #assertExactIdentity(snapshot, peer, from) {
    if (!snapshot.targetSessionId || !snapshot.targetCwd || !snapshot.targetSocketPath || !snapshot.targetPermissionMode || !snapshot.targetPermissionVerifiedBy) throw coded("MILESTONE_INELIGIBLE", "the original instruction has no durable identity snapshot");
    assertSnapshotRendering(snapshot, "MILESTONE_SNAPSHOT_RENDERING_UNVERSIONED");
    if (!peer || peer.pid !== snapshot.targetPid || normalizeProcStart(peer.procStart) !== normalizeProcStart(snapshot.targetProcStart) || from !== `uds:${snapshot.targetSocketPath}`) throw coded("MILESTONE_IDENTITY_MISMATCH", "milestone peer identity mismatch");
  }

  #view(completion) {
    const events = this.#events(completion.completionMessageId); const delivered = events.find((event) => event.type === "milestone_ack_delivered"); const terminal = events.find((event) => event.type === "milestone_ack_terminal_failure");
    const prepared = events.find((event) => event.type === "milestone_ack_prepared"); const reserved = [...events].reverse().find((event) => event.type === "milestone_ack_send_reserved"); const held = [...events].reverse().find((event) => event.type === "milestone_ack_held");
    const state = delivered ? "ack_delivered" : terminal ? "terminal" : held ? "held" : reserved ? "ack_reserved" : prepared ? "ack_prepared" : "accepted";
    return { found: true, complete: Boolean(delivered), state, cursor: this.#cursor(), completion: publicCompletion(completion), ack: prepared ? { messageId: prepared.ackMessageId, transportMessageId: reserved?.ackTransportMessageId ?? null, subscriptionId: reserved?.ackSubscriptionId ?? null } : null, lastEvent: publicMilestoneEvent(events.at(-1) ?? completion) };
  }
  #completion(id) { return this.store.events.find((event) => event.type === "milestone_completion_accepted" && event.completionMessageId === id) ?? null; }
  #completionByAttempt(id) { return this.store.events.find((event) => event.type === "milestone_completion_accepted" && event.attemptId === id) ?? null; }
  #events(id) { return this.store.events.filter((event) => event.completionMessageId === id); }
  #cursor() { return this.store.events.at(-1)?.seq ?? 0; }
  async #append(type, data) { const event = await this.store.append(type, data); this.emit("event", event); return event; }
}

export const milestoneExtension = Object.freeze({ enabled: false });

export function parseCompletion(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) return null; const newline = content.indexOf("\n"); if (newline < 0) return null;
  const match = MARKER.exec(content.slice(0, newline).trim()); if (!match) return null; let payload; try { payload = JSON.parse(content.slice(newline + 1)); } catch { return null; }
  try { const normalized = validatePayload(payload); return { messageId: requireUuid(match[1], "completionMessageId"), threadId: requireUuid(match[2], "threadId"), replyTo: requireUuid(match[3], "replyTo"), payload: normalized, canonicalPayload: canonicalJson(normalized) }; } catch { return null; }
}

function validatePayload(payload) {
  if (!plain(payload)) throw new Error("payload must be an object"); const keys = Object.keys(payload); if (REQUIRED.some((key) => !keys.includes(key)) || keys.some((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key))) throw new Error("unexpected payload keys");
  const instruction_id = requireUuid(payload.instruction_id, "instruction_id"); const attempt_id = requireUuid(payload.attempt_id, "attempt_id"); if (typeof payload.milestone_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(payload.milestone_id)) throw new Error("invalid milestone_id");
  for (const key of ["manifest_hash", "plan_hash"]) if (key in payload && !HASH.test(payload[key])) throw new Error(`invalid ${key}`);
  if (!Array.isArray(payload.files) || payload.files.length > 256) throw new Error("invalid files"); const files = payload.files.map((file) => { if (!text(file, 240) || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("invalid file"); return file; }); if (new Set(files).size !== files.length) throw new Error("duplicate file");
  if (!Array.isArray(payload.tests) || payload.tests.length > 64) throw new Error("invalid tests"); const tests = payload.tests.map((entry) => { exact(entry, ["command", "scope", "pass", "fail", "skip"]); if (!text(entry.command, 1024) || !text(entry.scope, 512)) throw new Error("invalid test"); for (const key of ["pass", "fail", "skip"]) if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) throw new Error("invalid test count"); return { ...entry }; });
  if (!Array.isArray(payload.blockers) || payload.blockers.length > 64) throw new Error("invalid blockers"); const blockers = payload.blockers.map((entry) => { exact(entry, ["code", "message"]); if (typeof entry.code !== "string" || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(entry.code) || !text(entry.message, 2048)) throw new Error("invalid blocker"); return { ...entry }; });
  if (!strictTime(payload.last_signal_at)) throw new Error("invalid last_signal_at"); if ("preview_url" in payload && payload.preview_url !== null) { const url = new URL(payload.preview_url); if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password) throw new Error("invalid preview_url"); }
  return { ...payload, instruction_id, attempt_id, files, tests, blockers };
}

function publicCompletion(event) { return { completionMessageId: event.completionMessageId, attemptId: event.attemptId, milestoneId: event.milestoneId, instructionId: event.instructionId, threadId: event.threadId, payloadHash: event.payloadHash, payload: redactPublic(event.payload) }; }
function publicMilestoneEvent(event) { const allowed = ["seq", "type", "at", "completionMessageId", "incomingCompletionMessageId", "attemptId", "incomingAttemptId", "milestoneId", "instructionId", "threadId", "payloadHash", "ackMessageId", "ackTransportMessageId", "ackSubscriptionId", "reason", "status", "evidence"]; return Object.fromEntries(allowed.filter((key) => event[key] !== undefined).map((key) => [key, event[key]])); }
function ackBody(messageId, threadId, replyTo, payloadHash) { return `MILESTONE_ACK v=1 message_id=${messageId} thread_id=${threadId} reply_to=${replyTo} payload_hash=${payloadHash}`; }
function deterministicUuid(value) { const hex = sha256(`milestone-ack:${value}`).slice(0, 32).split(""); hex[12] = "4"; hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4]; return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`; }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) { if (!plain(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error("unexpected keys"); }
function text(value, max) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value); }
function strictTime(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
