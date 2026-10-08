// M6 bridge: the acceptance cases from the design review (2026-10-08), on a real ledger and spool
// with a fake GitHub.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventStore } from "../../src/core/events.mjs";
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { acceptPost } from "../../src/core/posts.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { GithubBridge } from "../../src/github/bridge.mjs";
import { formatAck, formatMessage, parseLine } from "../../src/github/protocol.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
const ME = "10000000-0000-4000-8000-0000000000aa"; const OTHER = "20000000-0000-4000-8000-0000000000aa";
const ROOMS = { rooms: { egg: { host: "github.com", repo: "o/egg", repoId: 1, number: 5, kind: "pull", epoch: 1 } }, remotes: { "codex-cloud": { room: "egg", epoch: 1, wake: "@codex" }, "claude-cloud": { room: "egg", epoch: 1, wake: null } } };

async function stand({ visibility = "private", postFails = null, rooms = ROOMS, local: initialLocal = null, spoolFailsOnce = null, relayNeeded = null, loseAnswer = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm6-"))); roots.push(root); await fs.chmod(root, 0o700);
  const paths = statePaths(root); const store = new EventStore(paths); await store.init(); const spool = new InboundSpool(paths);
  const comments = []; let nextId = 100;
  const client = {
    repoInfo: async () => ({ id: 1, visibility }),
    comments: async ({ fromPage = 1, maxPages = 5 }) => {
      const out = []; let page = fromPage; let more = false;
      for (let n = 0; n < maxPages; n += 1, page += 1) { const rows = comments.slice((page - 1) * 100, page * 100); out.push(...rows.map((c) => ({ ...c }))); if (rows.length < 100) { more = false; break; } more = true; }
      return { comments: out, lastPage: Math.min(page, Math.max(1, Math.ceil(comments.length / 100))), more };
    },
    postComment: async ({ body }) => { if (postFails) throw Object.assign(new Error("x"), { code: postFails }); const c = { id: nextId++, author: "owner", createdAt: new Date().toISOString(), body }; comments.push(c); if (loseAnswer) throw Object.assign(new Error("lost"), { code: "GH_API_FAILED" }); return { id: c.id }; }
  };
  let local = initialLocal ?? { "dev-claude": { recipientKind: "claude", recipientSessionId: ME } };
  let table = rooms;
  if (spoolFailsOnce !== null) { const write = spool.write.bind(spool); let n = 0; spool.write = async (body) => { n += 1; if (n === spoolFailsOnce) throw Object.assign(new Error("disk"), { code: "EIO" }); return write(body); }; }
  const bridge = new GithubBridge({ store, spool, client, rooms: () => table, localRecipient: (a) => local[a] ?? null, isLocalAlias: (a) => Object.hasOwn(local, a), relayNeeded,
    readBody: async (post) => fs.readFile(path.join(root, post.bodyFile), "utf8") });
  store.onAppend = (row) => bridge.onAppend(row);
  const remoteSays = (text) => { comments.push({ id: nextId++, author: "codex-bot", createdAt: new Date().toISOString(), body: text }); };
  const sendLocal = async (to, body, extra = {}) => { const messageId = crypto.randomUUID(); await acceptPost({ store, spool, messageId, recipient: to, body, source: "control", who: { senderAlias: "dev-claude", senderSessionId: ME, recipientKind: "github", githubRoom: "egg", githubInstance: "1:5:1", githubEpoch: table.remotes[to]?.epoch ?? 1, ...extra } }); await bridge.send(messageId); return messageId; };
  return { root, store, bridge, comments, remoteSays, sendLocal, rows: (t) => store.events.filter((e) => e.type === t), move: (s) => { local = { "dev-claude": { recipientKind: "claude", recipientSessionId: s } }; }, setLocal: (l) => { local = l; }, setRooms: (t) => { table = t; } };
}

test("outbound: one comment with the message line and the wake; posted is recorded; the poll reconciles, not re-delivers", async () => {
  const s = await stand(); const id = await s.sendLocal("codex-cloud", "hello codex", { expectReply: true });
  expect(s.comments).toHaveLength(1);
  expect(parseLine(s.comments[0].body)).toMatchObject({ kind: "message", id, from: "dev-claude", to: ["codex-cloud"], expectReply: true });
  expect(s.comments[0].body.split("\n")[1]).toMatch(new RegExp(`^@codex Not a review request: .* re=${id}\``));
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "sent", wake: "requested" });
  const report = await s.bridge.poll("egg");
  expect(report).toMatchObject({ delivered: 0 });
  expect(s.rows("peer_post").filter((p) => p.source === "github")).toHaveLength(0);
});

test("inbound answer with re= is bound to the asking session even after the alias moved (review d)", async () => {
  const s = await stand(); const q = await s.sendLocal("codex-cloud", "question");
  s.move(OTHER);
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "codex-cloud", to: ["dev-claude"], re: q, body: "answer" }));
  await s.bridge.poll("egg");
  const answer = s.rows("peer_post").find((p) => p.source === "github");
  expect(answer).toMatchObject({ recipient: "dev-claude", recipientSessionId: ME, replyTo: q, senderAlias: "codex-cloud", senderKind: "github" });
});

test("two questions answered in reverse order and an unrelated bot comment: nothing is misattributed (review b)", async () => {
  const s = await stand(); const q1 = await s.sendLocal("codex-cloud", "q1"); const q2 = await s.sendLocal("codex-cloud", "q2");
  s.remoteSays("Codex review: looks good.");   // no message line: observed only
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "codex-cloud", to: ["dev-claude"], re: q2, body: "a2" }));
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "codex-cloud", to: ["dev-claude"], re: q1, body: "a1" }));
  await s.bridge.poll("egg");
  const answers = s.rows("peer_post").filter((p) => p.source === "github").map((p) => p.replyTo);
  expect(answers).toEqual([q2, q1]);
  expect(s.rows("github_comment_observed").map((r) => r.reason)).toContain("no_message_line");
});

test("a repeated poll and a restart create one post only (review c)", async () => {
  const s = await stand();
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "claude-cloud", to: ["dev-claude"], body: "hi" }));
  await s.bridge.poll("egg"); await s.bridge.poll("egg");
  const store2 = new EventStore(statePaths(s.root)); await store2.init();
  const again = new GithubBridge({ store: store2, spool: new InboundSpool(statePaths(s.root)), client: s.bridge.client, rooms: () => ROOMS, localRecipient: () => ({ recipientKind: "claude", recipientSessionId: ME }), isLocalAlias: (a) => a === "dev-claude", readBody: async () => "" });
  await again.poll("egg");
  expect(store2.events.filter((e) => e.type === "peer_post" && e.source === "github")).toHaveLength(1);
});

test("forged ack, cross-sender ack, unknown re, local-alias claim and a public room are refused (review e)", async () => {
  const s = await stand(); const q = await s.sendLocal("codex-cloud", "q");
  s.remoteSays(formatAck({ ack: q, from: "claude-cloud" }));                                  // not the recipient
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "codex-cloud", to: ["dev-claude"], re: crypto.randomUUID(), body: "?" }));
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "dev-claude", to: ["dev-claude"], body: "spoof" }));
  await s.bridge.poll("egg");
  expect(s.rows("github_message_quarantined").map((r) => r.reason).sort()).toEqual(["ack_not_for_sender", "claims_local_alias", "unknown_re"]);
  expect(s.rows("peer_post_processed")).toHaveLength(0);
  s.remoteSays(formatAck({ ack: q, from: "codex-cloud" }));
  await s.bridge.poll("egg");
  expect(s.rows("peer_post_processed")).toMatchObject([{ messageId: q, readerAlias: "codex-cloud", via: "github" }]);
  const pub = await stand({ visibility: "public" });
  await expect(pub.bridge.poll("egg")).rejects.toMatchObject({ code: "ROOM_NOT_PRIVATE" });
  await pub.sendLocal("codex-cloud", "x");
  expect(pub.comments).toHaveLength(0); expect(pub.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "not_sent", errorCode: "ROOM_NOT_PRIVATE" });
});

test("a POST whose answer is lost is unknown, never posted again by itself; the poll reconciles it (review f)", async () => {
  const s = await stand({ postFails: "GH_API_FAILED" }); const id = await s.sendLocal("codex-cloud", "q");
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "unknown" });
  expect(await s.bridge.send(id)).toEqual({ state: "duplicate_intent" });
  // The comment had in fact been written:
  s.comments.push({ id: 999, author: "owner", createdAt: new Date().toISOString(), body: formatMessage({ id, from: "dev-claude", to: ["codex-cloud"], body: "q", wake: "@codex" }) });
  expect((await s.bridge.poll("egg")).reconciled).toBe(1);
  expect(s.rows("github_outbound_posted")).toMatchObject([{ messageId: id, commentId: 999, reconciled: true }]);
});

test("a local inbox-ack of a GitHub message posts one ack line; our own ack coming back is not a message", async () => {
  const s = await stand(); const rid = crypto.randomUUID();
  s.remoteSays(formatMessage({ id: rid, from: "claude-cloud", to: ["dev-claude"], body: "hi" }));
  await s.bridge.poll("egg");
  const post = s.rows("peer_post").find((p) => p.source === "github");
  await s.store.append("peer_post_processed", { messageId: post.messageId, readerAlias: "dev-claude" });
  await Bun.sleep(20);
  expect(parseLine(s.comments.at(-1).body)).toEqual({ kind: "ack", ack: rid, from: "dev-claude" });
  await s.bridge.poll("egg");
  expect(s.rows("github_comment_observed").map((r) => r.reason)).toContain("own_ack");
  expect(s.rows("github_message_quarantined")).toHaveLength(0);
});

// ---- review of 612ff44: one regression per finding
const clone = (t) => JSON.parse(JSON.stringify(t));

test("1: a room re-linked elsewhere never receives the old room's mail, and the old cursor is not reused", async () => {
  const s = await stand();
  const moved = clone(ROOMS); moved.rooms.egg = { ...moved.rooms.egg, repoId: 1, number: 9, epoch: 2 };
  const messageId = crypto.randomUUID();
  await acceptPost({ store: s.store, spool: s.bridge.spool, messageId, recipient: "codex-cloud", body: "secret body", source: "control", who: { senderAlias: "dev-claude", senderSessionId: ME, recipientKind: "github", githubRoom: "egg", githubInstance: "1:5:1", githubEpoch: 1 } });
  s.setRooms(moved);
  await Bun.sleep(30);
  expect(s.comments).toHaveLength(0);
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "not_sent", errorCode: "REMOTE_CHANGED" });
});

test("2: a crash between two recipients is completed by the next poll, without a second copy", async () => {
  const two = { "dev-one": { recipientKind: "claude", recipientSessionId: ME }, "dev-two": { recipientKind: "claude", recipientSessionId: OTHER } };
  const s = await stand({ local: two, spoolFailsOnce: 2 });
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "claude-cloud", to: ["dev-one", "dev-two"], body: "to both" }));
  await expect(s.bridge.poll("egg")).rejects.toMatchObject({ code: "EIO" });
  expect(s.rows("github_comment_seen")).toHaveLength(0);
  await s.bridge.poll("egg");
  expect(s.rows("peer_post").filter((p) => p.source === "github").map((p) => p.recipient).sort()).toEqual(["dev-one", "dev-two"]);
});

test("3: a remote name a local session holds is quarantined, not delivered as that session", async () => {
  const s = await stand(); s.setLocal({ "dev-claude": { recipientKind: "claude", recipientSessionId: ME }, "claude-cloud": { recipientKind: "claude", recipientSessionId: OTHER } });
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "claude-cloud", to: ["dev-claude"], body: "who am i" }));
  await s.bridge.poll("egg");
  expect(s.rows("github_message_quarantined").map((r) => r.reason)).toEqual(["alias_collision"]);
  expect(s.rows("peer_post").filter((p) => p.source === "github")).toHaveLength(0);
});

test("4: a remote re-registered (epoch raised) cannot ack or answer what was sent to the one before", async () => {
  const s = await stand(); const q = await s.sendLocal("codex-cloud", "q");
  const bumped = clone(ROOMS); bumped.remotes["codex-cloud"].epoch = 2; s.setRooms(bumped);
  s.remoteSays(formatAck({ ack: q, from: "codex-cloud" }));
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "codex-cloud", to: ["dev-claude"], re: q, body: "late" }));
  await s.bridge.poll("egg");
  expect(s.rows("github_message_quarantined").map((r) => r.reason).sort()).toEqual(["ack_not_for_sender", "unknown_re"]);
  expect(s.rows("peer_post_processed")).toHaveLength(0);
});

test("5: more than five pages of comments: later polls continue from the page cursor until the message arrives", async () => {
  const s = await stand();
  for (let i = 0; i < 500; i += 1) s.remoteSays("chatter");
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "claude-cloud", to: ["dev-claude"], body: "after the chatter" }));
  const first = await s.bridge.poll("egg");
  expect(first).toMatchObject({ backlog: true });
  await s.bridge.poll("egg");
  expect(s.rows("peer_post").filter((p) => p.source === "github")).toHaveLength(1);
  expect(new Set(s.rows("github_comment_seen").map((r) => r.commentId)).size).toBe(501);
});

test("6: the same remote id with a different body is a conflict, quarantined; an exact repeat is not", async () => {
  const s = await stand(); const id = crypto.randomUUID();
  s.remoteSays(formatMessage({ id, from: "claude-cloud", to: ["dev-claude"], body: "first" }));
  s.remoteSays(formatMessage({ id, from: "claude-cloud", to: ["dev-claude"], body: "first" }));
  s.remoteSays(formatMessage({ id, from: "claude-cloud", to: ["dev-claude"], body: "different" }));
  await s.bridge.poll("egg");
  expect(s.rows("peer_post").filter((p) => p.source === "github")).toHaveLength(1);
  expect(s.rows("github_message_quarantined").map((r) => r.reason)).toEqual(["id_conflict"]);
});

// ---- review of e099c91
test("r2-1: a remote re-registered while a poll is reading: its ack is judged against the table as it is now", async () => {
  const s = await stand(); const q = await s.sendLocal("codex-cloud", "q");
  s.remoteSays(formatAck({ ack: q, from: "codex-cloud" }));
  const read = s.bridge.client.comments;
  s.bridge.client.comments = async (a) => { const r = await read(a); const bumped = clone(ROOMS); bumped.remotes["codex-cloud"].epoch = 2; s.setRooms(bumped); return r; };
  await s.bridge.poll("egg");
  expect(s.rows("peer_post_processed")).toHaveLength(0);
  expect(s.rows("github_message_quarantined").map((r) => r.reason)).toEqual(["ack_not_for_sender"]);
});

test("r2-2: a local ack of a message from a remote re-registered since is not posted", async () => {
  const s = await stand();
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "claude-cloud", to: ["dev-claude"], body: "hi" }));
  await s.bridge.poll("egg");
  const bumped = clone(ROOMS); bumped.remotes["claude-cloud"].epoch = 2; s.setRooms(bumped);
  const post = s.rows("peer_post").find((p) => p.source === "github"); const before = s.comments.length;
  await s.store.append("peer_post_processed", { messageId: post.messageId, readerAlias: "dev-claude" });
  await Bun.sleep(20);
  expect(s.comments).toHaveLength(before);
  expect(s.rows("github_ack_outcome").at(-1)).toMatchObject({ state: "not_sent", errorCode: "REMOTE_CHANGED" });
});

test("r2-3: comments deleted across pages never hide an unread message", async () => {
  const s = await stand();
  for (let i = 0; i < 500; i += 1) s.remoteSays("chatter");
  const target = crypto.randomUUID(); s.remoteSays(formatMessage({ id: target, from: "claude-cloud", to: ["dev-claude"], body: "the one" }));
  for (let i = 0; i < 1000; i += 1) s.remoteSays("more chatter");
  await s.bridge.poll("egg");                 // reads the first window
  s.comments.splice(0, 250);                  // the room loses 250 early comments
  for (let i = 0; i < 6; i += 1) await s.bridge.poll("egg");
  expect(s.rows("peer_post").filter((p) => p.source === "github").map((p) => p.githubMessageId)).toEqual([target]);
});

test("r2-4: only the exact comment this Mac rendered reconciles a lost answer; another body under the id is a conflict", async () => {
  const s = await stand({ postFails: "GH_API_FAILED" }); const id = await s.sendLocal("codex-cloud", "q");
  s.comments.push({ id: 77, author: "someone", createdAt: new Date().toISOString(), body: formatMessage({ id, from: "claude-cloud", to: ["dev-claude"], body: "not the outbound text" }) });
  await s.bridge.poll("egg");
  expect(s.rows("github_outbound_posted")).toHaveLength(0);
  expect(s.rows("github_message_quarantined").map((r) => r.reason)).toEqual(["own_id_conflict"]);
});

test("r2-5: an inbound message processed right before a crash still gets its ack, once", async () => {
  const s = await stand();
  s.remoteSays(formatMessage({ id: crypto.randomUUID(), from: "claude-cloud", to: ["dev-claude"], body: "hi" }));
  await s.bridge.poll("egg");
  const post = s.rows("peer_post").find((p) => p.source === "github");
  s.store.onAppend = null;                    // the hook never runs: the process stops here
  await s.store.append("peer_post_processed", { messageId: post.messageId, readerAlias: "dev-claude" });
  const before = s.comments.length;
  await s.bridge.sweep(); await s.bridge.sweep();
  expect(s.comments.length).toBe(before + 1);
  expect(parseLine(s.comments.at(-1).body)).toMatchObject({ kind: "ack", from: "dev-claude" });
});

test("r3: deletions beyond one poll's search budget: the search continues across polls and nothing is skipped", async () => {
  const s = await stand();
  for (let i = 0; i < 800; i += 1) s.remoteSays("chatter");
  const target = crypto.randomUUID(); s.remoteSays(formatMessage({ id: target, from: "claude-cloud", to: ["dev-claude"], body: "id 801" }));
  for (let i = 0; i < 1200; i += 1) s.remoteSays("more chatter");
  await s.bridge.poll("egg"); await s.bridge.poll("egg");          // decided up to about 800, cursor page 8
  const watermarkBefore = Math.max(...s.rows("github_comment_seen").map((r) => r.commentId));
  s.comments.splice(0, 750);                                       // the unread message moves to page 1
  for (let i = 0; i < 8; i += 1) await s.bridge.poll("egg");
  expect(s.rows("peer_post").filter((p) => p.source === "github").map((p) => p.githubMessageId)).toEqual([target]);
  expect(s.rows("github_poll_probe").length).toBeGreaterThan(0);
  expect(watermarkBefore).toBeLessThan(s.comments.find((c) => c.body.includes(target)).id);
});

// Review r4: the comment list is not a snapshot. Through the real client (pages of 100, read one
// request at a time), 50 comments deleted between page 1 and page 2 move ids 101..150 onto page 1 after
// it was read; the forward read never sees them and its watermark passes them. The backfill finds them —
// in the same poll, or after a restart if that poll was cut short — and each is decided exactly once.
test("deletion between two page requests of one read: the skipped message is delivered once, also across a restart (review r4)", async () => {
  const { createGithubClient } = await import("../../src/github/client.mjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm6-"))); roots.push(root); await fs.chmod(root, 0o700);
  const msgId = crypto.randomUUID();
  let list = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, user: { login: "someone", type: "User" }, created_at: "2026-10-08T00:00:00Z",
    body: i + 1 === 101 ? formatMessage({ id: msgId, from: "claude-cloud", to: ["dev-claude"], body: "the one in the gap" }) : `note ${i + 1}` }));
  let pageRequests = 0; let failBackfill = true;
  const exec = async (_gh, args) => {
    const url = args[1];
    if (/^repos\/[^/]+\/[^/]+$/.test(url)) return { stdout: JSON.stringify({ id: 1, private: true }) };
    const page = Number(/[?&]page=(\d+)/.exec(url)[1]); pageRequests += 1;
    if (pageRequests === 2) list = list.filter((c) => c.id <= 50 || c.id > 100);   // deleted after page 1 was served
    if (pageRequests === 3 && failBackfill) { failBackfill = false; throw Object.assign(new Error("network"), { stderr: "timeout" }); }
    return { stdout: JSON.stringify(list.slice((page - 1) * 100, page * 100)) };
  };
  const client = createGithubClient({ exec });
  const open = async () => {
    const paths = statePaths(root); const store = new EventStore(paths); await store.init();
    const bridge = new GithubBridge({ store, spool: new InboundSpool(paths), client, rooms: () => ROOMS, localRecipient: (a) => (a === "dev-claude" ? { recipientKind: "claude", recipientSessionId: ME } : null), isLocalAlias: (a) => a === "dev-claude", readBody: async () => "" });
    store.onAppend = (row) => bridge.onAppend(row);
    return { store, bridge };
  };
  const first = await open();
  await expect(first.bridge.poll("egg")).rejects.toThrow();   // the forward read finished; the backfill was cut short
  expect(first.store.events.some((e) => e.type === "peer_post" && e.githubMessageId === msgId)).toBe(false);
  const second = await open();                                // restart
  for (let n = 0; n < 3; n += 1) await second.bridge.poll("egg");
  const delivered = second.store.events.filter((e) => e.type === "peer_post" && e.githubMessageId === msgId);
  expect(delivered).toHaveLength(1);
  const seen = second.store.events.filter((e) => e.type === "github_comment_seen").map((e) => e.commentId);
  expect(new Set(seen).size).toBe(seen.length);               // no comment decided twice
  expect(list.filter((c) => !seen.includes(c.id))).toEqual([]);   // every comment still there is decided
});

test("a relay remote: one comment without a wake line, the owner alerted with room/alias/id only, outcome relay_requested", async () => {
  const calls = [];
  const rooms = { ...ROOMS, remotes: { ...ROOMS.remotes, "codex-cloud": { room: "egg", epoch: 1, wake: "relay" } } };
  const s = await stand({ rooms, relayNeeded: async (info) => { calls.push(info); } });
  const id = await s.sendLocal("codex-cloud", "secret body", { expectReply: true });
  expect(s.comments).toHaveLength(1);
  expect(s.comments[0].body.split("\n")[1]).toBe("");
  expect(calls).toEqual([{ room: "egg", alias: "codex-cloud", messageId: id }]);
  expect(JSON.stringify(calls)).not.toContain("secret");
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "sent", wake: "relay_requested" });
});

const RELAY_ROOMS = { ...ROOMS, remotes: { ...ROOMS.remotes, "codex-cloud": { room: "egg", epoch: 1, wake: "relay" } } };

test("relay: a comment whose answer was lost is reconciled by the poll, then the sweep alerts the owner once (review r8 P1)", async () => {
  const calls = [];
  const s = await stand({ rooms: RELAY_ROOMS, loseAnswer: true, relayNeeded: async (info) => { calls.push(info); } });
  const id = await s.sendLocal("codex-cloud", "q");
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "unknown" });
  expect(calls).toHaveLength(0);
  await s.bridge.poll("egg");
  expect(s.rows("github_outbound_posted").at(-1)).toMatchObject({ reconciled: true });
  await s.bridge.sweep(); await s.bridge.sweep();
  expect(calls).toEqual([{ room: "egg", alias: "codex-cloud", messageId: id }]);
  expect(s.comments).toHaveLength(1);   // never re-posted
});

test("relay: an alert that throws synchronously or rejects leaves the send 'sent'; the next sweep alerts again until recorded (review r8 P1/P2)", async () => {
  for (const fail of [() => { throw new Error("sync"); }, async () => { throw new Error("async"); }]) {
    let n = 0; const s = await stand({ rooms: RELAY_ROOMS, relayNeeded: (info) => { n += 1; if (n === 1) return fail(); return undefined; } });
    await s.sendLocal("codex-cloud", "q");
    expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "sent", wake: "relay_requested" });
    expect(s.rows("github_relay_alerted")).toHaveLength(0);
    await s.bridge.sweep(); await s.bridge.sweep();
    expect(n).toBe(2); expect(s.rows("github_relay_alerted")).toHaveLength(1);
  }
});

test("relay: no alert for a message the remote already acked", async () => {
  let n = 0; const s = await stand({ rooms: RELAY_ROOMS, loseAnswer: true, relayNeeded: () => { n += 1; } });
  const id = await s.sendLocal("codex-cloud", "q");
  s.remoteSays(formatAck({ ack: id, from: "codex-cloud" }));
  await s.bridge.poll("egg"); await s.bridge.sweep();
  expect(n).toBe(0);
});

test("relay: send and two sweeps overlapping on one message alert once; a failed alert is retried by a later sweep (review r9)", async () => {
  let n = 0; let release; const gate = new Promise((r) => { release = r; });
  const s = await stand({ rooms: RELAY_ROOMS, loseAnswer: true, relayNeeded: async () => { n += 1; await gate; } });
  await s.sendLocal("codex-cloud", "q"); await s.bridge.poll("egg");   // posted by reconciliation, not yet alerted
  const all = Promise.all([s.bridge.sweep(), s.bridge.sweep(), s.bridge.sweep()]);
  await new Promise((r) => setTimeout(r, 20)); release(); await all;
  expect(n).toBe(1); expect(s.rows("github_relay_alerted")).toHaveLength(1);
  let m = 0; const t = await stand({ rooms: RELAY_ROOMS, relayNeeded: async () => { m += 1; if (m === 1) throw new Error("x"); } });
  await t.sendLocal("codex-cloud", "q");
  await Promise.all([t.bridge.sweep(), t.bridge.sweep()]);
  expect(m).toBe(2); expect(t.rows("github_relay_alerted")).toHaveLength(1);
});
