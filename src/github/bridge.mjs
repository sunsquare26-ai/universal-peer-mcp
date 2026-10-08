import crypto from "node:crypto";
import { acceptPost, uuidv5 } from "../core/posts.mjs";
import { sameUuid } from "../core/limits.mjs";
import { formatAck, formatMessage, messageBody, parseLine } from "./protocol.mjs";
import { remoteOf, roomInstance } from "./rooms.mjs";

// M6: the GitHub bridge (docs/github-transport.md; MVP as reviewed 2026-10-08, revised after the code
// review of 612ff44).
//
// Room instance. Every durable row carries `instance` = repoId:number:roomEpoch, and every lookup is
// within one instance: re-linking a room name (to another repository or PR, or the same one again)
// starts a new instance with its own cursor, mail, acks and answers, and nothing from the old one is
// sent, acked or answered in the new one. Before each poll and each comment the repository's numeric
// id and visibility are read again: a renamed or reused name, or a repository that is no longer
// private, is refused.
//
// Endpoint epoch. An outbound message records the remote's epoch; an ack or an answer counts only
// from that same remote at that same epoch. A remote re-registered by the owner (epoch raised) cannot
// close or answer what was sent to the one before. `from=` itself stays a claim (weak identity).
//
// Inbound. Comments are read in creation order, page by page from a durable page cursor (no update-
// time `since`, which edits and busy seconds can starve), deduped by comment id, and each is decided
// once. A message is delivered to every local recipient under a deterministic id (instance, remote id,
// recipient), so a crash part-way is completed by the next poll and never doubled; the same remote id
// with a different envelope or body is quarantined, not hidden as a duplicate. A remote whose alias a
// local session also holds is quarantined. No answer is inferred from a comment without a message line.
//
// Outbound. A durable intent, then one comment; `unknown` when the answer is lost, reconciled by the
// next poll if the comment is there, never posted again by itself. The destination is re-checked right
// before the comment is written.
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const POLL_PAGES = 5;
export const BACKFILL_PAGES = 2;

export class GithubBridge {
  constructor({ store, spool, client, rooms, localRecipient, isLocalAlias, readBody, relayNeeded = null, now = () => Date.now() }) {
    Object.assign(this, { store, spool, client, rooms, localRecipient, isLocalAlias, readBody, relayNeeded, now });
    this.polling = new Map(); this.posting = new Map(); this.relaying = new Map();
  }

  #seen(instance, commentId) { return this.store.events.some((e) => e.type === "github_comment_seen" && e.instance === instance && e.commentId === commentId); }
  #intent(instance, githubMessageId) { return this.store.events.find((e) => e.type === "github_outbound_intent" && e.instance === instance && sameUuid(e.githubMessageId, githubMessageId)) ?? null; }
  #post(messageId) { return this.store.events.find((e) => e.type === "peer_post" && sameUuid(e.messageId, messageId)) ?? null; }
  async #verifyRepo(room) {
    const info = await this.client.repoInfo({ repo: room.repo });
    if (info.visibility !== "private") return "ROOM_NOT_PRIVATE";
    if (info.id !== room.repoId) return "ROOM_REPO_CHANGED";
    return null;
  }

  // ---- inbound
  async poll(roomName) {
    if (this.polling.has(roomName)) return this.polling.get(roomName);
    const job = this.#poll(roomName).finally(() => this.polling.delete(roomName));
    this.polling.set(roomName, job); return job;
  }
  async #poll(roomName) {
    const first = this.rooms(); const room = first.rooms?.[roomName]; if (!room) throw fail("UNKNOWN_ROOM", `no room ${roomName}`);
    const instance = roomInstance(room);
    const refused = await this.#verifyRepo(room);
    if (refused) { await this.store.append("github_room_refused", { room: roomName, instance, reason: refused }); throw fail(refused, `${room.repo}: ${refused}`); }
    // Watermark: the highest comment id decided so far. It only picks where the forward read starts
    // (the cursor page, walked back while that page begins above it); it never marks a comment as
    // decided — only that comment's own seen row does. A comment the forward read cannot reach (moved
    // by a deletion between two page requests) is found by the backfill below.
    const watermark = this.store.events.reduce((max, e) => (e.type === "github_comment_seen" && e.instance === instance && e.commentId > max ? e.commentId : max), 0);
    // The search for a safe starting page (one that begins at or below the watermark, or page 1) is
    // its own durable state: a poll whose budget runs out mid-search records where it got to and reads
    // nothing forward, and the next poll continues the search. Nothing is decided — and the watermark
    // does not move — until the start is known to be safe.
    const cursor = [...this.store.events].reverse().find((e) => e.type === "github_poll_cursor" && e.instance === instance);
    const probing = [...this.store.events].reverse().find((e) => e.type === "github_poll_probe" && e.instance === instance && e.seq > (cursor?.seq ?? 0));
    let page = Math.max(1, probing?.page ?? cursor?.page ?? 1); let budget = POLL_PAGES; let safe = page === 1;
    while (!safe && budget > 0) {
      const probe = await this.client.comments({ repo: room.repo, issue: room.number, fromPage: page, maxPages: 1 }); budget -= 1;
      const head = probe.comments[0];
      if (head && head.id <= watermark) { safe = true; break; }
      page -= 1; if (page === 1) safe = true;
    }
    if (!safe) { await this.store.append("github_poll_probe", { room: roomName, instance, page }); return { read: 0, delivered: 0, acked: 0, observed: 0, quarantined: 0, reconciled: 0, backlog: true, probing: page }; }
    const { comments, lastPage, more } = await this.client.comments({ repo: room.repo, issue: room.number, fromPage: page, maxPages: Math.max(1, budget) });
    const report = { read: comments.length, delivered: 0, acked: 0, observed: 0, quarantined: 0, reconciled: 0, backlog: more };
    let decidedAll = true;
    for (const c of comments.sort((a, b) => a.id - b.id)) {
      if (this.#seen(instance, c.id)) continue;
      // Decided against the table as it is now: a room re-linked, or a remote re-registered, while
      // this poll was reading stops it here; the rest is decided by the next poll.
      const table = this.rooms(); const current = table.rooms?.[roomName];
      if (!current || roomInstance(current) !== instance) { decidedAll = false; report.stoppedFor = "room_changed"; break; }
      const outcome = await this.#decide(roomName, instance, table, c);
      report[outcome] = (report[outcome] ?? 0) + 1;
      await this.store.append("github_comment_seen", { room: roomName, instance, commentId: c.id, outcome });
    }
    if (decidedAll && (lastPage !== (cursor?.page ?? 1) || more !== (cursor?.more ?? false))) await this.store.append("github_poll_cursor", { room: roomName, instance, page: lastPage, more });
    // Backfill. The list is not a snapshot: a deletion between two page requests can move unread
    // comments below the watermark, where the forward read skips them. So every poll also sweeps a few
    // pages of the whole room, from page 1 to the end and round again, deciding any comment that has no
    // seen row — whatever its id. Bounded per poll and durable across restarts; a comment a round misses
    // (the list kept shifting under it) is picked up by a later round.
    if (decidedAll) await this.#backfill(roomName, instance, room, report);
    return report;
  }

  async #backfill(roomName, instance, room, report) {
    const at = [...this.store.events].reverse().find((e) => e.type === "github_backfill_cursor" && e.instance === instance);
    const page = Math.max(1, at?.next ?? 1);
    const { comments, lastPage, more } = await this.client.comments({ repo: room.repo, issue: room.number, fromPage: page, maxPages: BACKFILL_PAGES });
    for (const c of comments.sort((a, b) => a.id - b.id)) {
      if (this.#seen(instance, c.id)) continue;
      const table = this.rooms(); const current = table.rooms?.[roomName];
      if (!current || roomInstance(current) !== instance) return;
      const outcome = await this.#decide(roomName, instance, table, c);
      report[outcome] = (report[outcome] ?? 0) + 1; report.backfilled = (report.backfilled ?? 0) + 1;
      await this.store.append("github_comment_seen", { room: roomName, instance, commentId: c.id, outcome, backfill: true });
    }
    await this.store.append("github_backfill_cursor", { room: roomName, instance, next: more ? lastPage + 1 : 1 });
  }

  async #decide(roomName, instance, table, c) {
    const line = parseLine(c.body);
    const observed = async (reason) => { await this.store.append("github_comment_observed", { room: roomName, instance, commentId: c.id, author: c.author, reason }); return "observed"; };
    const quarantine = async (reason, extra = {}) => { await this.store.append("github_message_quarantined", { room: roomName, instance, commentId: c.id, author: c.author, reason, ...extra }); return "quarantined"; };
    if (!line) return observed("no_message_line");
    if (line.kind === "notice") return observed("notice");
    // Our own comments coming back on a later poll.
    if (line.kind === "message") {
      const intent = this.#intent(instance, line.id);
      if (intent) {
        // Only the exact comment this Mac rendered reconciles an attempt; anything else under that id
        // is a conflict, and the attempt stays unknown.
        const posted = this.store.events.find((e) => e.type === "github_outbound_posted" && sameUuid(e.messageId, intent.messageId));
        if (posted) return posted.commentId === c.id ? observed("own_comment") : quarantine("own_id_conflict", { id: line.id, from: line.from });
        if (intent.commentDigest !== digest(c.body)) return quarantine("own_id_conflict", { id: line.id, from: line.from });
        await this.store.append("github_outbound_posted", { messageId: intent.messageId, room: roomName, instance, commentId: c.id, reconciled: true });
        return "reconciled";
      }
    }
    if (line.kind === "ack" && this.store.events.some((e) => e.type === "github_ack_intent" && e.instance === instance && sameUuid(e.githubMessageId ?? "", line.ack) && e.from === line.from)) return observed("own_ack");
    // The sender: a remote of this room instance, and never an alias a local session also holds.
    const remote = remoteOf(table, line.from);
    if (this.isLocalAlias(line.from)) return quarantine(remote ? "alias_collision" : "claims_local_alias", { from: line.from });
    if (!remote || remote.instance !== instance) return quarantine("unknown_sender", { from: line.from });
    // What this Mac sent to that remote, at its current epoch, in this instance.
    const sentToSender = (githubMessageId) => {
      const intent = this.#intent(instance, githubMessageId);
      return intent && intent.recipient === line.from && intent.remoteEpoch === remote.epoch ? this.#post(intent.messageId) : null;
    };
    if (line.kind === "ack") {
      const post = sentToSender(line.ack);
      if (!post) return quarantine("ack_not_for_sender", { ack: line.ack, from: line.from });
      if (this.store.events.some((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, post.messageId))) return observed("ack_duplicate");
      await this.store.append("peer_post_processed", { messageId: post.messageId, readerAlias: line.from, via: "github", room: roomName, instance, commentId: c.id });
      return "acked";
    }
    let answering = null;
    if (line.re) { answering = sentToSender(line.re); if (!answering) return quarantine("unknown_re", { re: line.re, from: line.from }); }
    const body = messageBody(c.body);
    const envelope = digest({ from: line.from, to: line.to, re: line.re, expectReply: line.expectReply, body });
    // The same remote id again: an exact repeat completes any recipient a crash left out; anything else
    // under that id is a conflict, kept visible.
    const prior = this.store.events.find((e) => e.type === "peer_post" && e.source === "github" && e.githubInstance === instance && sameUuid(e.githubMessageId ?? "", line.id));
    if (prior && prior.githubEnvelope !== envelope) return quarantine("id_conflict", { id: line.id, from: line.from });
    const recipients = answering ? [answering.senderAlias] : line.to.filter((a) => this.isLocalAlias(a));
    if (recipients.length === 0) return observed("not_for_this_mac");
    let delivered = 0;
    for (const recipient of recipients) {
      const binding = answering ? (answering.senderSessionId ? { recipientKind: "claude", recipientSessionId: answering.senderSessionId } : answering.senderThreadId ? { recipientKind: "codex", recipientThreadId: answering.senderThreadId } : null) : this.localRecipient(recipient);
      if (!binding) { await quarantine("no_local_binding", { to: recipient }); continue; }
      const messageId = uuidv5(`github:${instance}:${line.id}:${recipient}`);
      const result = await acceptPost({ store: this.store, spool: this.spool, messageId, recipient, body, source: "github",
        who: { senderAlias: line.from, senderKind: "github", githubRoom: roomName, githubInstance: instance, githubEpoch: remote.epoch, githubMessageId: line.id, githubCommentId: c.id, githubAuthor: c.author, githubEnvelope: envelope, ...binding, ...(answering ? { replyTo: answering.messageId } : {}), ...(line.expectReply ? { expectReply: true } : {}) } });
      if (result.state === "accepted" || result.state === "duplicate") delivered += 1;
    }
    return delivered ? "delivered" : "quarantined";
  }

  // ---- outbound
  async onAppend(row) {
    if (row?.type === "peer_post" && row.recipientKind === "github") return this.send(row.messageId);
    if (row?.type === "peer_post_processed" && row.via !== "github") {
      const post = this.#post(row.messageId);
      if (post?.source === "github") return this.#ack(post);
    }
    return null;
  }

  // Start-up and after each poll: a GitHub post that never got its intent (a crash between the post row
  // and the intent) is sent now — no comment can exist for it. One with an intent and no outcome is left
  // to the poll's reconciliation; nothing is posted twice.
  async sweep() {
    const intents = new Set(this.store.events.filter((e) => e.type === "github_outbound_intent").map((e) => e.messageId.toLowerCase()));
    const ackIntents = new Set(this.store.events.filter((e) => e.type === "github_ack_intent").map((e) => e.messageId.toLowerCase()));
    const processedLocally = new Set(this.store.events.filter((e) => e.type === "peer_post_processed" && e.via !== "github").map((e) => e.messageId.toLowerCase()));
    const out = [];
    // A relay comment that exists (posted, or reconciled after a lost answer) but whose owner alert was
    // never recorded — the process stopped in between — is alerted now. The comment is never re-posted.
    for (const intent of this.store.events.filter((e) => e.type === "github_outbound_intent" && e.relay === true)) await this.#relay(intent.messageId).catch(() => {});
    for (const post of this.store.events.filter((e) => e.type === "peer_post")) {
      const id = post.messageId.toLowerCase();
      if (post.recipientKind === "github" && !intents.has(id)) out.push(await this.send(post.messageId));
      // An inbound message processed here whose ack hook never ran (a crash right after the processed
      // row): no ack comment can exist without its intent, so it is posted now — once.
      else if (post.source === "github" && processedLocally.has(id) && !ackIntents.has(id)) out.push(await this.#ack(post));
    }
    return out;
  }

  // The owner is told, once per message, that a comment waits for a remote nobody can wake. Only for a
  // comment known to exist; not when the remote already acked or answered it. The alert carries the
  // room, the alias and the id — never the body. Recorded after the alert, so a stop in between alerts
  // again on the next sweep, and the alert sink drops that duplicate by its key.
  // One check-alert-record job per message at a time (send, a sweep after a poll and the startup sweep
  // can overlap); a failed job is dropped from the map, so a later sweep tries again.
  #relay(messageId) {
    const key = String(messageId).toLowerCase();
    if (this.relaying.has(key)) return this.relaying.get(key);
    const job = this.#relayOnce(messageId).finally(() => this.relaying.delete(key));
    this.relaying.set(key, job); return job;
  }
  async #relayOnce(messageId) {
    if (!this.relayNeeded) return null;
    const is = (e) => sameUuid(e.messageId, messageId);
    const intent = this.store.events.find((e) => e.type === "github_outbound_intent" && e.relay === true && is(e));
    if (!intent || !this.store.events.some((e) => e.type === "github_outbound_posted" && is(e))) return null;
    if (this.store.events.some((e) => e.type === "github_relay_alerted" && is(e))) return null;
    if (this.store.events.some((e) => (e.type === "peer_post_processed" && e.via === "github" && is(e)) || (e.type === "peer_post" && e.source === "github" && e.replyTo && sameUuid(e.replyTo, messageId)))) return null;
    const info = { room: intent.room, alias: intent.recipient, messageId: intent.messageId };
    await Promise.resolve().then(() => this.relayNeeded(info));   // a sync throw is a rejection here
    return this.store.append("github_relay_alerted", { messageId: intent.messageId, room: intent.room, instance: intent.instance, recipient: intent.recipient });
  }

  async send(messageId) {
    if (this.posting.has(messageId)) return this.posting.get(messageId);
    const job = this.#send(messageId).finally(() => this.posting.delete(messageId));
    this.posting.set(messageId, job); return job;
  }
  async #send(messageId) {
    const post = this.#post(messageId);
    if (!post || post.recipientKind !== "github") return null;
    if (this.store.events.some((e) => e.type === "github_outbound_intent" && sameUuid(e.messageId, post.messageId))) return { state: "duplicate_intent" };
    const record = (state, extra = {}) => this.store.append("doorbell_outcome", { messageId: post.messageId, recipient: post.recipient, recipientKind: "github", state, mode: "github_comment", ...extra });
    // The destination the post was bound to must still be the remote's, in the same room instance.
    const same = () => { const r = remoteOf(this.rooms(), post.recipient); return r && r.instance === post.githubInstance && r.epoch === post.githubEpoch && !this.isLocalAlias(post.recipient) ? r : null; };
    let remote = same();
    let re = null; let text = null; let early = null;
    if (!remote) early = "REMOTE_CHANGED";
    else if (post.replyTo) { const original = this.#post(post.replyTo); re = original?.githubInstance === post.githubInstance ? original.githubMessageId ?? null : null; if (!re) early = "REPLY_ROOM_CHANGED"; }
    if (!early) { try { text = formatMessage({ id: post.messageId, from: post.senderAlias, to: [post.recipient], re, expectReply: post.expectReply === true, body: await this.readBody(post), wake: remote.wake }); } catch (error) { early = error.code ?? "INVALID_MESSAGE_LINE"; } }
    // Once: the intent is the claim, and it records the exact comment, so only that comment can
    // reconcile it later.
    try { await this.store.appendChecked("github_outbound_intent", { messageId: post.messageId, room: post.githubRoom, instance: post.githubInstance, githubMessageId: post.messageId, recipient: post.recipient, remoteEpoch: post.githubEpoch, ...(remote?.wake === "relay" ? { relay: true } : {}), ...(text ? { commentDigest: digest(text) } : {}) }, (events) => (events.some((e) => e.type === "github_outbound_intent" && sameUuid(e.messageId, post.messageId)) ? fail("DUP", "intent exists") : null)); }
    catch (error) { if (error.code === "DUP") return { state: "duplicate_intent" }; throw error; }
    if (early) return record("not_sent", { errorCode: early });
    let refused; try { refused = await this.#verifyRepo(remote); } catch (error) { return record("not_sent", { errorCode: error.code ?? "GH_API_FAILED" }); }
    if (refused) return record("not_sent", { errorCode: refused });
    remote = same(); if (!remote) return record("not_sent", { errorCode: "REMOTE_CHANGED" });   // re-checked right before the write
    try {
      const posted = await this.client.postComment({ repo: remote.repo, issue: remote.number, body: text });
      await this.store.append("github_outbound_posted", { messageId: post.messageId, room: post.githubRoom, instance: post.githubInstance, commentId: posted.id });
      if (remote.wake === "relay") { await this.#relay(post.messageId).catch(() => {}); return record("sent", { wake: "relay_requested" }); }
      return record("sent", { ...(remote.wake ? { wake: "requested" } : {}) });
    } catch (error) {
      return record(error.code === "GH_NOT_FOUND" || error.code === "INVALID_ROOM" || error.code === "INVALID_COMMENT" ? "not_sent" : "unknown", { errorCode: error.code ?? "GH_API_FAILED" });
    }
  }

  // A local session processed a message that came from GitHub: the remote is told, once, in the room
  // instance the message came from — never in a room re-linked since.
  async #ack(post) {
    try { await this.store.appendChecked("github_ack_intent", { messageId: post.messageId, room: post.githubRoom, instance: post.githubInstance, githubMessageId: post.githubMessageId, from: post.recipient, to: post.senderAlias, remoteEpoch: post.githubEpoch }, (events) => (events.some((e) => e.type === "github_ack_intent" && sameUuid(e.messageId, post.messageId)) ? fail("DUP", "ack intent exists") : null)); }
    catch (error) { if (error.code === "DUP") return null; throw error; }
    const outcome = (state, extra = {}) => this.store.append("github_ack_outcome", { messageId: post.messageId, instance: post.githubInstance, state, ...extra });
    // The sender endpoint the message came from must still be there: same room instance, same epoch.
    const same = () => { const r = remoteOf(this.rooms(), post.senderAlias); return r && r.instance === post.githubInstance && r.epoch === post.githubEpoch ? r : null; };
    if (!same()) return outcome("not_sent", { errorCode: "REMOTE_CHANGED" });
    try {
      const room = this.rooms().rooms[post.githubRoom];
      const refused = await this.#verifyRepo(room); if (refused) return outcome("not_sent", { errorCode: refused });
      const remote = same(); if (!remote) return outcome("not_sent", { errorCode: "REMOTE_CHANGED" });
      const posted = await this.client.postComment({ repo: remote.repo, issue: remote.number, body: formatAck({ ack: post.githubMessageId, from: post.recipient }) });
      return outcome("sent", { commentId: posted.id });
    } catch (error) { return outcome("unknown", { errorCode: error.code ?? "GH_API_FAILED" }); }
  }
}
