import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_INBOUND_BODY_BYTES, utf8Bound } from "./inbound-spool.mjs";
import { sameUuid } from "./limits.mjs";

// Independent messages (PEER_POST) with an id the tool issues, processed once per id (M2).
//
//   peer_post            accepted: authenticated sender, first time this id is seen; body spooled
//   peer_post_duplicate  same id, same body digest: nothing new, points at the first row
//   peer_post_conflict   same id, different digest: kept as metadata + digest only, never delivered
//   peer_frame_quarantined  unauthenticated writer: size, digest, header, writer — no body
//   quarantine_linked    a later authenticated post whose digest equals a quarantined one
//   peer_post_processed  the receiver finished it; once per id, across restarts (it is a ledger row)
//
// Everything is decided from ledger rows, so a daemon restart reloads the same answers.
export const POST_NAMESPACE = "6f0b2d3e-3a47-5c1e-9d2f-8a1b7c4e5f60";
const ALIAS = /^[a-z][a-z0-9-]{1,47}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const refuse = (code, message) => Object.assign(new Error(message), { code });

// RFC 4122 version 5 (SHA-1, name-based): the same group and recipient give the same id every
// time, so a retried group send never mints a second id for a recipient that already got one.
export function uuidv5(name, namespace = POST_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function recipientMessageId(groupId, alias) {
  if (!UUID.test(groupId) || !ALIAS.test(alias)) throw refuse("INVALID_CONTROL_ARGUMENTS", "groupId must be a uuid and recipient an alias");
  return uuidv5(`${groupId}:${alias}`);
}

export function bodyDigest(body) {
  const full = Buffer.from(typeof body === "string" ? body : "", "utf8");
  const end = utf8Bound(full, MAX_INBOUND_BODY_BYTES);
  return { bodyBytes: full.byteLength, bodySha256: crypto.createHash("sha256").update(full.subarray(0, end)).digest("hex"), ...(end < full.byteLength ? { bodyCapped: true } : {}) };
}

const firstPost = (events, messageId) => events.find((row) => row.type === "peer_post" && sameUuid(row.messageId, messageId));

export async function quarantine(store, { reason, content, header = null, who = {} }) {
  return store.append("peer_frame_quarantined", { reason, ...bodyDigest(content), ...(header ? { header } : {}), ...who });
}

export async function acceptPost({ store, spool, messageId, recipient = "*", body, who, source }) {
  if (!UUID.test(messageId)) throw refuse("INVALID_CONTROL_ARGUMENTS", "messageId must be a lowercase uuid");
  if (recipient !== "*" && !ALIAS.test(recipient)) throw refuse("INVALID_CONTROL_ARGUMENTS", "recipient must be an alias");
  const digest = bodyDigest(body);
  const outcomeFor = async (prior) => {
    if (prior.bodySha256 === digest.bodySha256) { const row = await store.append("peer_post_duplicate", { messageId, firstSeq: prior.seq, bodySha256: digest.bodySha256, source, ...who }); return { state: "duplicate", firstSeq: prior.seq, seq: row.seq }; }
    const row = await store.append("peer_post_conflict", { messageId, firstSeq: prior.seq, ...digest, source, ...who }); return { state: "conflict", firstSeq: prior.seq, seq: row.seq };
  };
  const prior = firstPost(store.events, messageId);
  if (prior) return outcomeFor(prior);
  const spooled = spool ? await spool.write(body) : {};
  let row;
  try {
    row = await store.appendChecked("peer_post", { messageId, recipient, header: { verb: "PEER_POST", v: "1", messageId }, source, ...spooled, ...who }, (events) => (firstPost(events, messageId) ? refuse("POST_RACE", "lost the race") : null));
  } catch (error) {
    if (error.code !== "POST_RACE") throw error;
    if (spooled.bodyFile) await fsp.unlink(path.join(store.paths.root, spooled.bodyFile)).catch(() => {});
    return outcomeFor(firstPost(store.events, messageId));
  }
  for (const q of store.events.filter((e) => e.type === "peer_frame_quarantined" && e.bodySha256 === row.bodySha256)) {
    if (!store.events.some((e) => e.type === "quarantine_linked" && e.quarantineSeq === q.seq)) await store.append("quarantine_linked", { quarantineSeq: q.seq, seq: row.seq, messageId });
  }
  return { state: "accepted", seq: row.seq };
}

export function inbox(events, recipient, { afterSeq = 0 } = {}) {
  const processed = new Set(events.filter((e) => e.type === "peer_post_processed").map((e) => e.messageId.toLowerCase()));
  return events.filter((e) => e.type === "peer_post" && e.seq > afterSeq && (e.recipient === recipient || e.recipient === "*") && !processed.has(e.messageId.toLowerCase()));
}

// Exactly once per id: the first ack writes the row, every later ack (any process, any restart)
// is told it was already processed and by which row.
export async function ackInbox(store, { messageId, reader }) {
  if (!UUID.test(messageId ?? "")) throw refuse("INVALID_CONTROL_ARGUMENTS", "messageId must be a lowercase uuid");
  if (!firstPost(store.events, messageId)) throw refuse("POST_UNKNOWN", "no accepted post with that id");
  try {
    const row = await store.appendChecked("peer_post_processed", { messageId, ...reader }, (events) => (events.some((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, messageId)) ? refuse("ALREADY_PROCESSED", "already processed") : null));
    return { processed: true, seq: row.seq, already: false };
  } catch (error) {
    if (error.code !== "ALREADY_PROCESSED") throw error;
    const prior = store.events.find((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, messageId));
    return { processed: true, seq: prior.seq, already: true };
  }
}

// The only way an unmatched reply becomes an answer: a person names the row and the request.
// Never automatic, never by time or text. The row must be an authenticated unmatched frame with a
// kept body, the request must exist, and neither side may already be linked.
export async function linkUnmatched(store, { sourceSeq, messageId, as, verdict = null, by = {} }) {
  if (!Number.isInteger(sourceSeq) || !UUID.test(messageId ?? "") || !["ack", "reply"].includes(as) || (verdict !== null && !["pass", "fail"].includes(verdict)) || (as === "ack" && verdict !== null)) throw refuse("INVALID_CONTROL_ARGUMENTS", "sourceSeq, messageId, as=ack|reply and verdict=pass|fail (reply only)");
  const source = store.events.find((e) => e.seq === sourceSeq);
  if (!source || source.type !== "peer_frame_uncorrelated" || typeof source.bodyFile !== "string") throw refuse("LINK_REFUSED", "not an unmatched frame with a kept body");
  const request = store.request(messageId);
  if (!request) throw refuse("LINK_REFUSED", "no request with that id");
  const type = as === "ack" ? "peer_ack" : "peer_reply";
  const row = await store.appendChecked(type, { messageId: request.messageId, threadId: request.threadId, verdict, evidence: "manual_link", linkedFromSeq: sourceSeq, bodyFile: source.bodyFile, bodySha256: source.bodySha256, bodyBytes: source.bodyBytes, ...by }, (events) => {
    if (events.some((e) => e.linkedFromSeq === sourceSeq)) return refuse("LINK_REFUSED", "that frame is already linked");
    if (events.some((e) => e.type === type && sameUuid(e.messageId, request.messageId))) return refuse("LINK_REFUSED", `that request already has a ${as}`);
    return null;
  });
  return { linked: true, seq: row.seq, type };
}
