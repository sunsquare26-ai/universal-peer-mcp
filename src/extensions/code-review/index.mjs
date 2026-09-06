import { EventEmitter } from "node:events";
import { milestoneSendOptions as internalSendOptions } from "../../core/peer-core.mjs";
import { sha256 } from "../../core/dedupe.mjs";
import { waitForEvent } from "../../core/wait.mjs";
import { requireUuid } from "../../core/limits.mjs";
import { redactPublic } from "../../mcp/redact.mjs";

const RECEIPT_MARKER = /^CODE_REVIEW_RECEIPT v=1 message_id=([0-9a-f-]{36}) thread_id=([0-9a-f-]{36}) reply_to=([0-9a-f-]{36})$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVIEW_THREAD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_KINDS = ["design", "implementation"];
const VERDICTS = ["pass", "fail"];
const REQUEST_ARGS = ["alias", "reviewId", "requestMessageId", "threadId", "targetKind", "artifactHash", "scope", "nonGoals", "evidence"];
const REQUEST_KEYS = ["review_id", "target_kind", "artifact_hash", "scope", "non_goals", "evidence"];
const RECEIPT_KEYS = ["review_id", "verdict", "review_thread_id", "rounds", "reviewed_at", "artifact_hash", "mandatory_changes", "unresolved"];
const SNAPSHOT_KEYS = ["targetAlias", "targetSessionId", "targetCwd", "targetSocketPath", "targetPid", "targetProcStart", "targetPermissionMode", "targetPermissionVerifiedBy"];
// Bounds chosen by this implementation: the approved design requires schema bounds but does not fix these exact values (64 rounds, 32 KiB canonical payload, 64-hex SHA-256 hashes).
export const MAX_ROUNDS = 64;
export const MAX_PAYLOAD_BYTES = 32 * 1024;

export class CodeReviewExtension extends EventEmitter {
  constructor({ store, core }) { super(); this.store = store; this.core = core; this.chain = Promise.resolve(); }

  observeFrame(frame, peer) { const operation = this.chain.then(() => this.#observe(frame, peer)); this.chain = operation.catch(() => {}); return operation; }

  request(args) { const operation = this.chain.then(() => this.#request(args)); this.chain = operation.catch(() => {}); return operation; }

  status({ reviewId = null, requestMessageId = null } = {}) {
    if ((reviewId === null) === (requestMessageId === null)) throw coded("CODE_REVIEW_IDENTITY_REQUIRED", "provide exactly one code review identity");
    const round = reviewId !== null ? this.#rounds(requireUuid(reviewId, "reviewId")).at(-1) ?? null : this.#round(requireUuid(requestMessageId, "requestMessageId"));
    return round ? this.#view(round) : { found: false, passed: false, state: "not_found", cursor: this.#cursor() };
  }

  list({ afterSeq = 0, reviewId = null } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const review = reviewId === null ? null : requireUuid(reviewId, "reviewId");
    const rounds = this.store.events.filter((event) => event.type === "code_review_requested" && event.seq > afterSeq && (!review || event.reviewId === review));
    return { cursor: this.#cursor(), rounds: rounds.map((event) => this.#view(event)) };
  }

  async wait({ afterSeq = 0, reviewId = null, requestMessageId = null, timeoutMs = 30_000 } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const review = reviewId === null ? null : requireUuid(reviewId, "reviewId"); const request = requestMessageId === null ? null : requireUuid(requestMessageId, "requestMessageId");
    const find = () => {
      const events = this.store.events.filter((event) => event.seq > afterSeq && event.type.startsWith("code_review_") && (!review || event.reviewId === review) && (!request || event.requestMessageId === request));
      if (!events.length) return null;
      const round = request ? this.#round(request) : review ? this.#rounds(review).at(-1) ?? null : this.#round(events.find((event) => event.requestMessageId)?.requestMessageId);
      return { cursor: this.#cursor(), events: events.map(publicCodeReviewEvent), review: round ? this.#view(round) : null };
    };
    return waitForEvent(this, find, Math.min(Math.max(timeoutMs, 1), 300_000), () => ({ cursor: this.#cursor(), events: [], review: null, timedOut: true }));
  }

  async #request(args) {
    const normalized = validateRequestArgs(args); const payloadHash = sha256(normalized.canonicalPayload);
    const prior = this.#round(normalized.requestMessageId);
    if (prior) {
      if (prior.payloadHash !== payloadHash || prior.reviewId !== normalized.reviewId || prior.threadId !== normalized.threadId || prior.targetAlias !== normalized.alias) throw coded("MESSAGE_ID_CONFLICT", "requestMessageId reuse with different content");
      const request = this.store.request(prior.requestMessageId); const reserved = this.#reservation(prior.requestMessageId);
      if (request === null && reserved === null) { await this.#send(prior); return { ...this.#view(prior), replay: false }; }
      if (!this.#ownReservation(prior, request, reserved)) throw coded("MESSAGE_ID_CONFLICT", "requestMessageId is reserved by a send this code review did not record");
      return { ...this.#view(prior), replay: true };
    }
    if (this.store.request(normalized.requestMessageId)) throw coded("MESSAGE_ID_CONFLICT", "requestMessageId is already used by another message");
    if (!this.core.targetsList().some((target) => target.alias === normalized.alias)) throw coded("TARGET_UNAVAILABLE", `target alias is not allowlisted: ${normalized.alias}`);
    const rounds = this.#rounds(normalized.reviewId); if (rounds.length >= MAX_ROUNDS) throw coded("CODE_REVIEW_ROUND_LIMIT", `a code review cannot open more than ${MAX_ROUNDS} rounds`);
    const round = await this.#append("code_review_requested", {
      reviewId: normalized.reviewId, round: rounds.length + 1, requestMessageId: normalized.requestMessageId, threadId: normalized.threadId, targetAlias: normalized.alias,
      targetKind: normalized.payload.target_kind, artifactHash: normalized.payload.artifact_hash, payloadHash, payload: normalized.payload
    });
    await this.#send(round);
    return { ...this.#view(round), replay: false };
  }

  async #send(round) {
    const body = requestBody(round);
    const args = { alias: round.targetAlias, messageId: round.requestMessageId, threadId: round.threadId, replyTo: null, kind: "code_review_request", body };
    const result = await this.core.send(args, internalSendOptions({ wireBody: body, afterReservation: async ({ transportMessageId, subscriptionId, targetSnapshot }) => {
      await this.#append("code_review_request_send_reserved", { reviewId: round.reviewId, round: round.round, requestMessageId: round.requestMessageId, transportMessageId, subscriptionId, threadId: round.threadId, artifactHash: round.artifactHash, payloadHash: round.payloadHash, ...targetSnapshot });
    } }));
    if (result.replay) throw coded("MESSAGE_ID_CONFLICT", "requestMessageId is reserved by a send this code review did not record");
    return result;
  }

  async #observe(frame, peer) {
    if (frame?.type === "control") return;
    const content = unwrap(frame?.message?.content, frame?.from);
    if (typeof content !== "string" || !content.startsWith("CODE_REVIEW_RECEIPT ")) return;
    const marker = parseReceipt(content); if (!marker) throw coded("INVALID_CODE_REVIEW_RECEIPT", "invalid code review receipt");
    return this.#acceptReceipt(frame, peer, marker);
  }

  async #acceptReceipt(frame, peer, marker) {
    const round = this.#round(marker.replyTo); const request = this.store.request(marker.replyTo);
    if (!round || !request || request.threadId !== marker.threadId || round.threadId !== marker.threadId || marker.payload.review_id !== round.reviewId) throw coded("CODE_REVIEW_CORRELATION_MISMATCH", "code review receipt is not bound to its request");
    this.#assertSnapshot(request);
    const reserved = this.#reservation(marker.replyTo);
    if (!this.#ownReservation(round, request, reserved)) throw coded("CODE_REVIEW_IDENTITY_MISMATCH", "code review receipt is not bound to the reservation its request recorded");
    this.#assertExactIdentity(reserved, peer, frame.from);
    const payloadHash = sha256(marker.canonicalPayload);
    if (marker.payload.artifact_hash !== round.artifactHash) {
      await this.#append("code_review_receipt_rejected", { reviewId: round.reviewId, round: round.round, requestMessageId: round.requestMessageId, incomingReceiptMessageId: marker.messageId, threadId: round.threadId, artifactHash: round.artifactHash, incomingArtifactHash: marker.payload.artifact_hash, incomingPayloadHash: payloadHash, receiptVerdict: marker.payload.verdict, reason: "artifact_hash_mismatch" });
      throw coded("CODE_REVIEW_HASH_MISMATCH", "code review receipt artifact hash does not match its request");
    }
    const prior = this.#receipt(marker.messageId);
    if (prior) {
      if (prior.payloadHash === payloadHash && prior.requestMessageId === marker.replyTo) return this.#append("code_review_receipt_duplicate", { reviewId: round.reviewId, round: round.round, requestMessageId: round.requestMessageId, receiptMessageId: marker.messageId, payloadHash, transportMessageId: frame.msg_id ?? null });
      await this.#append("code_review_receipt_conflict", { reviewId: round.reviewId, round: round.round, requestMessageId: round.requestMessageId, incomingReceiptMessageId: marker.messageId, existingReceiptMessageId: prior.receiptMessageId, incomingPayloadHash: payloadHash, existingPayloadHash: prior.payloadHash });
      throw coded("CODE_REVIEW_CONFLICT", "incoming receipt conflicts with a recorded receipt");
    }
    const existing = this.#receiptByRequest(marker.replyTo);
    if (existing) {
      await this.#append("code_review_receipt_conflict", { reviewId: round.reviewId, round: round.round, requestMessageId: round.requestMessageId, incomingReceiptMessageId: marker.messageId, existingReceiptMessageId: existing.receiptMessageId, incomingPayloadHash: payloadHash, existingPayloadHash: existing.payloadHash });
      throw coded("CODE_REVIEW_CONFLICT", "the request already has a recorded receipt");
    }
    return this.#append("code_review_receipt_accepted", {
      reviewId: round.reviewId, round: round.round, requestMessageId: round.requestMessageId, receiptMessageId: marker.messageId, threadId: round.threadId,
      receiptVerdict: marker.payload.verdict, reviewThreadId: marker.payload.review_thread_id, rounds: marker.payload.rounds, reviewedAt: marker.payload.reviewed_at, artifactHash: marker.payload.artifact_hash,
      payloadHash, payload: marker.payload, transportMessageId: frame.msg_id ?? null, peerPid: peer.pid, peerProcStart: peer.procStart, sourceAddress: typeof frame.from === "string" ? frame.from : null
    });
  }

  #assertSnapshot(snapshot) {
    if (!snapshot.targetSessionId || !snapshot.targetCwd || !snapshot.targetSocketPath || !snapshot.targetPermissionMode || !snapshot.targetPermissionVerifiedBy) throw coded("CODE_REVIEW_INELIGIBLE", "the original request has no durable identity snapshot");
  }
  #assertExactIdentity(snapshot, peer, from) {
    this.#assertSnapshot(snapshot);
    if (!peer || peer.pid !== snapshot.targetPid || peer.procStart !== snapshot.targetProcStart || from !== `uds:${snapshot.targetSocketPath}`) throw coded("CODE_REVIEW_IDENTITY_MISMATCH", "code review peer identity mismatch");
  }
  #ownReservation(round, request, reserved) {
    if (!request || !reserved) return false;
    return reserved.reviewId === round.reviewId && reserved.round === round.round && reserved.requestMessageId === round.requestMessageId && reserved.threadId === round.threadId && reserved.artifactHash === round.artifactHash && reserved.payloadHash === round.payloadHash
      && reserved.transportMessageId === request.transportMessageId && reserved.subscriptionId === request.subscriptionId && SNAPSHOT_KEYS.every((key) => reserved[key] === request[key]);
  }

  #view(round) {
    const rounds = this.#rounds(round.reviewId); const current = rounds.at(-1); const stale = current.requestMessageId !== round.requestMessageId;
    const events = this.#events(round.requestMessageId); const receipt = events.find((event) => event.type === "code_review_receipt_accepted") ?? null;
    const state = stale ? "superseded" : receipt ? (receiptVerdictOf(receipt) === "pass" ? "passed" : "failed") : "awaiting_receipt";
    return { found: true, passed: state === "passed", state, stale, cursor: this.#cursor(), review: publicRound(round), request: this.#requestView(round, events), receipt: receipt ? publicReceipt(receipt) : null, history: rounds.map((entry) => this.#historyEntry(entry, current)), lastEvent: publicCodeReviewEvent(events.at(-1) ?? round) };
  }
  #historyEntry(entry, current) { const receipt = this.#receiptByRequest(entry.requestMessageId); return { round: entry.round, requestMessageId: entry.requestMessageId, artifactHash: entry.artifactHash, verdict: receipt ? receiptVerdictOf(receipt) : null, receiptMessageId: receipt?.receiptMessageId ?? null, stale: entry.requestMessageId !== current.requestMessageId }; }
  #requestView(round, events) {
    const reserved = this.#reservation(round.requestMessageId); const own = this.#ownReservation(round, this.store.request(round.requestMessageId), reserved);
    const core = own ? this.store.events.filter((event) => event.messageId === round.requestMessageId) : [];
    const delivered = own && core.some((event) => event.type === "peer_message_status" && event.status === "delivered" && event.transportMessageId === reserved.transportMessageId && event.peerPid === reserved.targetPid && event.peerProcStart === reserved.targetProcStart && event.sourceAddress === `uds:${reserved.targetSocketPath}`);
    const delivery = core.some((event) => event.type === "peer_terminal_failure") ? "terminal" : delivered ? "delivered" : core.some((event) => event.type === "send_failed") ? "failed" : core.some((event) => event.type === "socket_write_complete") ? "written" : core.some((event) => event.type === "send_requested") ? "reserved" : "unsent";
    return { messageId: round.requestMessageId, transportMessageId: own ? reserved.transportMessageId : null, subscriptionId: own ? reserved.subscriptionId : null, delivery };
  }
  #round(id) { return id ? this.store.events.find((event) => event.type === "code_review_requested" && event.requestMessageId === id) ?? null : null; }
  #reservation(id) { return this.store.events.find((event) => event.type === "code_review_request_send_reserved" && event.requestMessageId === id) ?? null; }
  #rounds(reviewId) { return this.store.events.filter((event) => event.type === "code_review_requested" && event.reviewId === reviewId); }
  #receipt(id) { return this.store.events.find((event) => event.type === "code_review_receipt_accepted" && event.receiptMessageId === id) ?? null; }
  #receiptByRequest(id) { return this.store.events.find((event) => event.type === "code_review_receipt_accepted" && event.requestMessageId === id) ?? null; }
  #events(id) { return this.store.events.filter((event) => event.type.startsWith("code_review_") && event.requestMessageId === id); }
  #cursor() { return this.store.events.at(-1)?.seq ?? 0; }
  async #append(type, data) { const event = await this.store.append(type, data); this.emit("event", event); return event; }
}

export const codeReviewExtension = Object.freeze({ enabled: false });

export function parseReceipt(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) return null; const newline = content.indexOf("\n"); if (newline < 0) return null;
  const match = RECEIPT_MARKER.exec(content.slice(0, newline).trim()); if (!match) return null; let payload; try { payload = JSON.parse(content.slice(newline + 1)); } catch { return null; }
  try { const normalized = validateReceipt(payload); const canonicalPayload = canonicalJson(normalized); if (Buffer.byteLength(canonicalPayload) > MAX_PAYLOAD_BYTES) return null; return { messageId: requireUuid(match[1], "receiptMessageId"), threadId: requireUuid(match[2], "threadId"), replyTo: requireUuid(match[3], "replyTo"), payload: normalized, canonicalPayload }; } catch { return null; }
}

export function requestBody(round) { return `CODE_REVIEW_REQUEST v=1 message_id=${round.requestMessageId} thread_id=${round.threadId} review_id=${round.reviewId} round=${round.round} artifact_hash=${round.artifactHash}\n${canonicalJson(round.payload)}`; }

function validateRequestArgs(args) {
  try {
    if (!plain(args)) throw new Error("arguments must be an object"); exact(args, REQUEST_ARGS);
    if (typeof args.alias !== "string" || !/^[a-z][a-z0-9-]{1,47}$/.test(args.alias)) throw new Error("invalid alias");
    const reviewId = requireUuid(args.reviewId, "reviewId"); const requestMessageId = requireUuid(args.requestMessageId, "requestMessageId"); const threadId = requireUuid(args.threadId, "threadId");
    if (!TARGET_KINDS.includes(args.targetKind)) throw new Error("invalid targetKind"); if (typeof args.artifactHash !== "string" || !HASH.test(args.artifactHash)) throw new Error("invalid artifactHash");
    const scope = texts(args.scope, 1, 32, 256); const non_goals = texts(args.nonGoals, 0, 32, 256);
    const evidence = entries(args.evidence, 16, ["command", "summary"], { command: 512, summary: 1024 });
    const payload = { review_id: reviewId, target_kind: args.targetKind, artifact_hash: args.artifactHash, scope, non_goals, evidence };
    if (Object.keys(payload).length !== REQUEST_KEYS.length) throw new Error("invalid payload"); const canonicalPayload = canonicalJson(payload); if (Buffer.byteLength(canonicalPayload) > MAX_PAYLOAD_BYTES) throw new Error("payload exceeds 32 KiB");
    return { alias: args.alias, reviewId, requestMessageId, threadId, payload, canonicalPayload };
  } catch (error) { throw coded("CODE_REVIEW_INVALID_ARGUMENTS", `invalid code review request: ${error.message}`); }
}

function validateReceipt(payload) {
  if (!plain(payload)) throw new Error("payload must be an object"); exact(payload, RECEIPT_KEYS);
  const review_id = requireUuid(payload.review_id, "review_id"); if (!VERDICTS.includes(payload.verdict)) throw new Error("invalid verdict");
  if (typeof payload.review_thread_id !== "string" || !REVIEW_THREAD.test(payload.review_thread_id)) throw new Error("invalid review_thread_id");
  if (!Number.isSafeInteger(payload.rounds) || payload.rounds < 1 || payload.rounds > MAX_ROUNDS) throw new Error("invalid rounds");
  if (!strictTime(payload.reviewed_at)) throw new Error("invalid reviewed_at"); if (typeof payload.artifact_hash !== "string" || !HASH.test(payload.artifact_hash)) throw new Error("invalid artifact_hash");
  const mandatory_changes = entries(payload.mandatory_changes, 32, ["location", "message"], { location: 256, message: 1024 }); const unresolved = entries(payload.unresolved, 32, ["topic", "message"], { topic: 256, message: 1024 });
  if (payload.verdict === "pass" && (mandatory_changes.length > 0 || unresolved.length > 0)) throw new Error("a pass receipt cannot carry mandatory changes or unresolved items");
  return { review_id, verdict: payload.verdict, review_thread_id: payload.review_thread_id, rounds: payload.rounds, reviewed_at: payload.reviewed_at, artifact_hash: payload.artifact_hash, mandatory_changes, unresolved };
}

function publicRound(event) { return { reviewId: event.reviewId, round: event.round, requestMessageId: event.requestMessageId, threadId: event.threadId, alias: event.targetAlias, targetKind: event.targetKind, artifactHash: event.artifactHash, payloadHash: event.payloadHash, payload: redactPublic(event.payload) }; }
// Ledger compatibility: the first writer recorded a receipt verdict under `verdict`; the current writer records `receiptVerdict`, a key the core event schema does not carry. Reads accept both keys so recorded receipts replay unchanged.
function receiptVerdictOf(event) { const verdict = event.receiptVerdict ?? event.verdict ?? null; return VERDICTS.includes(verdict) ? verdict : null; }
// Core listing projection. The daemon applies it to every ledger event whether or not this extension is enabled: a code review verdict is readable only through code_review_* tools, whose contract binds it to the artifact hash, and the core event schema carries no hash, so no verdict key may reach it.
export function publicLedgerEvent(event) { if (typeof event?.type !== "string" || !event.type.startsWith("code_review_")) return event; const { verdict, receiptVerdict, ...rest } = event; return rest; }
function publicReceipt(event) { return { receiptMessageId: event.receiptMessageId, verdict: receiptVerdictOf(event), reviewThreadId: event.reviewThreadId, rounds: event.rounds, reviewedAt: event.reviewedAt, artifactHash: event.artifactHash, payloadHash: event.payloadHash, payload: redactPublic(event.payload) }; }
function publicCodeReviewEvent(event) { const verdict = receiptVerdictOf(event); const source = { ...event, verdict: verdict !== null && typeof event.artifactHash === "string" ? verdict : undefined }; const allowed = ["seq", "type", "at", "reviewId", "round", "requestMessageId", "receiptMessageId", "incomingReceiptMessageId", "existingReceiptMessageId", "threadId", "targetKind", "artifactHash", "incomingArtifactHash", "payloadHash", "incomingPayloadHash", "existingPayloadHash", "transportMessageId", "subscriptionId", "verdict", "reason"]; return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])); }
function texts(value, min, max, bytes) { if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error("invalid text list"); return value.map((item) => { if (!text(item, bytes)) throw new Error("invalid text item"); return item; }); }
function entries(value, max, keys, limits) { if (!Array.isArray(value) || value.length > max) throw new Error("invalid entry list"); return value.map((entry) => { exact(entry, keys); for (const key of keys) if (!text(entry[key], limits[key])) throw new Error(`invalid ${key}`); return Object.fromEntries(keys.map((key) => [key, entry[key]])); }); }
function unwrap(content, from) { if (typeof content !== "string") return null; if (!content.startsWith("<cross-session-message ")) return content; const match = /^<cross-session-message from="([^"]+)" from-name="[^"]+" from-mode="(?:prompting|bypass)">\n([\s\S]+)\n<\/cross-session-message>$/.exec(content); return match && match[1] === from ? match[2] : null; }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) { if (!plain(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error("unexpected keys"); }
function text(value, max) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value); }
function strictTime(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
