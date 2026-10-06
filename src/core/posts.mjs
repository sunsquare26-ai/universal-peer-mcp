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
    // No row names the file, so nothing else will ever find it: it goes now, or onto the recovery
    // list that startup and maintenance sweep (src/core/orphans.mjs).
    if (spooled.bodyFile) await discardSpooled(store.paths.root, spooled.bodyFile, error.code === "POST_RACE" ? "post_race" : "append_failed");
    if (error.code !== "POST_RACE") throw error;
    return outcomeFor(firstPost(store.events, messageId));
  }
  for (const q of store.events.filter((e) => e.type === "peer_frame_quarantined" && e.bodySha256 === row.bodySha256)) {
    if (!store.events.some((e) => e.type === "quarantine_linked" && e.quarantineSeq === q.seq)) await store.append("quarantine_linked", { quarantineSeq: q.seq, seq: row.seq, messageId });
  }
  return { state: "accepted", seq: row.seq };
}

// M4: an inbox holds only posts addressed to that alias. A post with no recipient ("*", a frame
// without `to=`) is held unaddressed and shown to no session: with several sessions reading, "anyone"
// would mean "whoever acks first" and a second reader processing it too.
//
// M4 (review [상]1): an alias is a name, a post is for a *session*. Each post is bound to the session
// the alias named when it was accepted (recipientSessionId / recipientThreadId). A reader sees it only
// when that session is in its lineage: itself, or a session it succeeded by a proven resume
// (target_rebound / peer_session_rebound rows). `register --replace` is not a succession, so a
// different session taking the alias never reads what was waiting for the one before; those posts
// are held (counted in `peers`) until the Owner re-addresses one by hand (`relinkPost`).
export function inbox(events, recipient, { afterSeq = 0, lineage = null } = {}) {
  const processed = new Set(events.filter((e) => e.type === "peer_post_processed").map((e) => e.messageId.toLowerCase()));
  const bindings = lineage ? postBindings(events) : null;
  return events.filter((e) => e.type === "peer_post" && e.seq > afterSeq && e.recipient === recipient && !processed.has(e.messageId.toLowerCase())
    && (lineage === null || lineage.has(bindings.get(e.messageId.toLowerCase()) ?? "")));
}

export function bindingKey(kind, id) { return typeof id === "string" && id ? `${kind}:${id.toLowerCase()}` : null; }
function rowBinding(row) {
  if (typeof row.recipientSessionId === "string") return bindingKey("claude", row.recipientSessionId);
  if (typeof row.recipientThreadId === "string") return bindingKey("codex", row.recipientThreadId);
  return null;
}
// messageId → the session key it is bound to now (the accepted row, or the Owner's last relink).
export function postBindings(events) {
  const out = new Map();
  for (const e of events) {
    if (e.type === "peer_post" && typeof e.messageId === "string") out.set(e.messageId.toLowerCase(), rowBinding(e));
    else if (e.type === "peer_post_relinked" && typeof e.messageId === "string") out.set(e.messageId.toLowerCase(), rowBinding(e));
  }
  return out;
}
// The sessions whose mail `identity` inherits under `alias`: itself and every predecessor it (or a
// predecessor) proved it resumed. Codex has no resume proof, so a thread's lineage is the thread.
export function sessionLineage(events, alias, identity) {
  const start = identity.kind === "claude" ? bindingKey("claude", identity.sessionId) : bindingKey("codex", identity.threadId);
  const lineage = new Set(start ? [start] : []);
  if (identity.kind !== "claude") return lineage;
  const edges = [];
  for (const e of events) {
    if (e.type === "target_rebound" && e.alias === alias && typeof e.observedSessionId === "string" && typeof e.expectedSessionId === "string") edges.push([e.observedSessionId.toLowerCase(), e.expectedSessionId.toLowerCase()]);
    if (e.type === "peer_session_rebound" && e.alias === alias && typeof e.sessionId === "string" && typeof e.previousSessionId === "string") edges.push([e.sessionId.toLowerCase(), e.previousSessionId.toLowerCase()]);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [to, from] of edges) if (lineage.has(`claude:${to}`) && !lineage.has(`claude:${from}`)) { lineage.add(`claude:${from}`); grew = true; }
  }
  return lineage;
}
// Unprocessed posts addressed to `alias` that its current session may not read.
export function heldPosts(events, alias, lineage) {
  const processed = new Set(events.filter((e) => e.type === "peer_post_processed").map((e) => e.messageId.toLowerCase()));
  const bindings = postBindings(events);
  return events.filter((e) => e.type === "peer_post" && e.recipient === alias && !processed.has(e.messageId.toLowerCase()) && !lineage.has(bindings.get(e.messageId.toLowerCase()) ?? ""));
}
// The Owner's hand: bind one held post to the session that holds its alias now. Never automatic.
export async function relinkPost(store, { messageId, identity, by = {} }) {
  if (!UUID.test(messageId ?? "")) throw refuse("INVALID_CONTROL_ARGUMENTS", "messageId must be a lowercase uuid");
  const post = firstPost(store.events, messageId);
  if (!post) throw refuse("POST_UNKNOWN", "no accepted post with that id");
  if (store.events.some((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, messageId))) throw refuse("ALREADY_PROCESSED", "already processed");
  const fields = identity.kind === "claude" ? { recipientSessionId: identity.sessionId } : { recipientThreadId: identity.threadId };
  // Moving a message to the session it is already bound to is not a move (M5): refused, so a relink
  // row always means a new session and its doorbell is rung exactly once.
  const target = bindingKey(identity.kind, identity.kind === "claude" ? identity.sessionId : identity.threadId);
  // Decided inside the append (appendChecked), so two identical moves at once land as one relink and
  // one ALREADY_BOUND, and a message processed meanwhile is not moved.
  const row = await store.appendChecked("peer_post_relinked", { messageId, recipient: post.recipient, previous: postBindings(store.events).get(messageId) ?? null, ...fields, ...by }, (events) => {
    if (events.some((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, messageId))) return refuse("ALREADY_PROCESSED", "already processed");
    const current = postBindings(events).get(messageId);
    return current && current === target ? refuse("ALREADY_BOUND", "the message is already bound to that session") : null;
  });
  return { relinked: true, seq: row.seq, recipient: post.recipient };
}

async function discardSpooled(root, bodyFile, reason) {
  try { await fsp.unlink(path.join(root, bodyFile)); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    await fsp.appendFile(path.join(root, ORPHAN_LIST), `${JSON.stringify({ bodyFile, reason, at: new Date().toISOString() })}\n`, { mode: 0o600 }).catch(() => {});
  }
}
export const ORPHAN_LIST = "inbound-orphans.jsonl";
export function unaddressed(events) {
  return events.filter((e) => e.type === "peer_post" && e.recipient === "*");
}

// The recipient a frame names on its first line (`PEER_POST v=1 message_id=… to=<alias>`), or "*".
export function postRecipient(content) {
  if (typeof content !== "string") return "*";
  const line = content.split(/\r?\n/, 1)[0].slice(0, 1024);
  const matches = line.split(/[ \t|]+/).filter((t) => t.toLowerCase().startsWith("to=")).map((t) => t.slice(3));
  return matches.length === 1 && ALIAS.test(matches[0]) ? matches[0] : "*";
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
