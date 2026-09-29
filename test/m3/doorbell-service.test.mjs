import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DoorbellService, UNKNOWN_ALERT_AFTER_MS } from "../../src/core/doorbell-service.mjs";
import { EventStore } from "../../src/core/events.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { AlertSink } from "../../src/core/alerts.mjs";
import { CodexWake } from "../../src/extensions/codex-queue/index.mjs";
import { fakeConnect, writeCli } from "../m0/codex-fixture.mjs";

const roots = []; const servers = [];
afterEach(async () => { for (const s of servers.splice(0)) s.close(); for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
const T1 = "01a0ecc0-e498-7bc2-8bdc-da8e9ad2838c"; const T2 = "01a0ecc1-aaaa-7bbb-8ccc-dddddddddddd";

async function stand({ state = "idle", version = "0.159.0", serverVersion = version, peers = { "test-codex-1": { threadId: T1 } }, pin = null, wakeError = null } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm3d-"))); roots.push(root); await fs.chmod(root, 0o700);
  const sock = path.join(root, "as.sock"); const srv = net.createServer(() => {}); await new Promise((ok) => srv.listen(sock, ok)); await fs.chmod(sock, 0o600); servers.push(srv);
  const cli = await writeCli(root, { version });
  const store = new EventStore(statePaths(root)); await store.init();
  const calls = []; const directory = { ...peers };
  const settings = { codexCli: { value: cli }, codexAppServerSocket: { value: sock }, codexVersion: { value: pin } };
  const alerts = new AlertSink({ file: path.join(root, "alerts.jsonl") });
  let clock = Date.now();
  const service = new DoorbellService({ store, root, settings, codexPeers: () => directory, alerts, now: () => clock });
  service.wake = new CodexWake({ root, connect: wakeError ? () => ({ call: async () => { throw wakeError; }, notify() {}, close() {} }) : fakeConnect({ root, state, version: serverVersion, threadId: T1, calls }), authorize: (alias, id) => service.authorize(alias, id) });
  // thread/loaded/list must list whichever thread the target names.
  service.wake.connect = wakeError ? service.wake.connect : ((base) => (...a) => { const c = base(...a); const call = c.call; c.call = async (m, p) => (m === "thread/loaded/list" ? { data: [T1, T2] } : m === "thread/read" ? { thread: { id: p.threadId, cwd: root, status: { type: state }, turns: state === "active" ? [{ id: "turn-1", status: "inProgress" }] : [] } } : call(m, p)); return c; })(service.wake.connect);
  const postTo = async (alias = "test-codex-1", threadId = T1) => store.append("peer_post", { messageId: crypto.randomUUID(), recipient: alias, recipientKind: "codex", recipientThreadId: threadId, header: { verb: "PEER_POST" } });
  const rows = (t) => store.events.filter((e) => e.type === t);
  return { root, store, service, calls, directory, postTo, rows, cli, advance: (ms) => { clock += ms; }, alertLines: async () => (await fs.readFile(path.join(root, "alerts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean) };
}
const bell = (id) => `PEER_DOORBELL v=1 message_id=${id}`;

test("an accepted Codex post: intent first, then turn/start with the doorbell only, outcome sent", async () => {
  const s = await stand(); const post = await s.postTo();
  await s.service.onAppend(post);
  expect(s.rows("doorbell_intent")).toEqual([expect.objectContaining({ messageId: post.messageId, recipient: "test-codex-1", threadId: T1 })]);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "sent", mode: "started" });
  expect(s.rows("doorbell_intent")[0].seq).toBeLessThan(s.rows("doorbell_outcome")[0].seq);
  const start = s.calls.find(([m]) => m === "turn/start");
  expect(start[1].input).toEqual([{ type: "text", text: bell(post.messageId), text_elements: [] }]);
  expect(start[1].threadId).toBe(T1);
  await s.service.onAppend(post);                      // a second notice of the same row: no second intent
  expect(s.rows("doorbell_intent")).toHaveLength(1);
});

test("a running turn is steered", async () => {
  const s = await stand({ state: "active" }); const post = await s.postTo();
  await s.service.onAppend(post);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "sent", mode: "steered" });
  expect(s.calls.find(([m]) => m === "turn/steer")[1]).toMatchObject({ expectedTurnId: "turn-1", threadId: T1 });
});

test("a post to a Claude peer: one fixed line through the session socket, derived id, outcome sent; a retry is a replay", async () => {
  const S1 = crypto.randomUUID(); const sends = [];
  const s = await stand();
  s.service.claudePeers = () => ({ "test-claude-1": { sessionId: S1 } });
  s.service.sendClaude = async (args) => { sends.push(args); return { replay: sends.length > 1 }; };
  const row = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "test-claude-1", recipientKind: "claude", recipientSessionId: S1 });
  await s.service.onAppend(row);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ alias: "test-claude-1", threadId: row.messageId, line: bell(row.messageId) });
  expect(sends[0].messageId).not.toBe(row.messageId);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "sent", mode: "session_socket", recipientKind: "claude", threadId: S1 });
  // The same derived id on a retry: PeerCore answers it as a replay, nothing is written twice.
  const again = await s.service.ring(row.messageId, { retry: true });
  expect(sends[1].messageId).toBe(sends[0].messageId); expect(again).toMatchObject({ state: "sent", replay: true });
});

test("Claude: the alias moved to another session after the post -> wake_target_mismatch; an uncertain write -> unknown", async () => {
  const S1 = crypto.randomUUID(); const S2 = crypto.randomUUID(); const sends = [];
  const s = await stand(); const table = { "test-claude-1": { sessionId: S1 } };
  s.service.claudePeers = () => table;
  s.service.sendClaude = async (args) => { sends.push(args); throw Object.assign(new Error("x"), { code: "DELIVERY_UNCERTAIN" }); };
  const old = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "test-claude-1", recipientKind: "claude", recipientSessionId: S1 });
  table["test-claude-1"] = { sessionId: S2 };
  await s.service.ring(old.messageId, { first: true });
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "not_sent", reason: "wake_target_mismatch", boundThreadId: S2 });
  const fresh = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "test-claude-1", recipientKind: "claude", recipientSessionId: S2 });
  await s.service.ring(fresh.messageId, { first: true });
  expect(s.rows("doorbell_outcome")[1]).toMatchObject({ state: "unknown", errorCode: "DELIVERY_UNCERTAIN" });
  expect(sends).toHaveLength(1);
});

test("wake is refused for an unknown id, someone else's id, and a processed id", async () => {
  const s = await stand({ peers: { "test-codex-1": { threadId: T1 }, "test-codex-2": { threadId: T2 } } });
  await expect(s.service.wake.wake({ codexAlias: "test-codex-1", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "WAKE_UNKNOWN_MESSAGE" });
  const other = await s.postTo("test-codex-2", T2);
  await expect(s.service.wake.wake({ codexAlias: "test-codex-1", messageId: other.messageId, target: s.service.targetFor(other) })).rejects.toMatchObject({ code: "WAKE_NOT_RECIPIENT" });
  expect(s.service.authorize("test-codex-1", other.messageId)).toBe("WAKE_NOT_RECIPIENT");
  const mine = await s.postTo();
  await s.store.append("peer_post_processed", { messageId: mine.messageId });
  expect(s.service.authorize("test-codex-1", mine.messageId)).toBe("WAKE_ALREADY_PROCESSED");
  expect(s.calls.filter(([m]) => m === "turn/start" || m === "turn/steer")).toEqual([]);
});

test("after register --replace: the old thread's post is refused as wake_target_mismatch, the new one rings the new thread", async () => {
  const s = await stand();
  const old = await s.postTo("test-codex-1", T1);
  s.directory["test-codex-1"] = { threadId: T2 };                 // register --replace moved the alias
  await s.service.ring(old.messageId, { first: true });
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ messageId: old.messageId, state: "not_sent", errorCode: "WAKE_TARGET_MISMATCH", reason: "wake_target_mismatch", boundThreadId: T2 });
  const fresh = await s.postTo("test-codex-1", T2);
  await s.service.ring(fresh.messageId, { first: true });
  expect(s.rows("doorbell_outcome")[1]).toMatchObject({ messageId: fresh.messageId, state: "sent" });
  const starts = s.calls.filter(([m]) => m === "turn/start");
  expect(starts.map(([, p]) => p.threadId)).toEqual([T2]);        // nothing ever went to T1 or to T2 for the old message
});

test("restart with an open intent: rung once more with the same id; a second restart does not ring again", async () => {
  const s = await stand(); const post = await s.postTo();
  await s.store.append("doorbell_intent", { messageId: post.messageId, recipient: "test-codex-1", threadId: T1 });   // crashed before ringing
  await s.service.resumeOpenIntents();
  expect(s.rows("doorbell_retry")).toHaveLength(1);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "sent" });
  expect(s.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
  // A crash after the retry but before its outcome: the next restart reports unknown, rings nothing.
  const post2 = await s.postTo();
  await s.store.append("doorbell_intent", { messageId: post2.messageId, recipient: "test-codex-1", threadId: T1 });
  await s.store.append("doorbell_retry", { messageId: post2.messageId });
  await s.service.resumeOpenIntents();
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ messageId: post2.messageId, state: "unknown", errorCode: "RETRY_EXHAUSTED" });
  expect(s.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
});

test("a retry after an attempt that reserved but never answered is unknown, never a second send", async () => {
  const s = await stand(); const post = await s.postTo();
  const dir = path.join(s.root, "codex-wake"); await fs.mkdir(dir, { mode: 0o700 }); await fs.chmod(dir, 0o700);
  await fs.writeFile(path.join(dir, `${post.messageId}.json`), JSON.stringify({ hash: crypto.createHash("sha256").update(JSON.stringify(["test-codex-1", post.messageId])).digest("hex"), state: "reserved" }), { mode: 0o600 });
  await s.store.append("doorbell_intent", { messageId: post.messageId, recipient: "test-codex-1", threadId: T1 });
  await s.service.resumeOpenIntents();
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "unknown", errorCode: "DELIVERY_UNCERTAIN" });
  expect(s.calls.filter(([m]) => m === "turn/start")).toEqual([]);
});

test("unknown past 30 minutes: one alarm, no resend", async () => {
  const s = await stand(); const post = await s.postTo();
  await s.store.append("doorbell_intent", { messageId: post.messageId, recipient: "test-codex-1", threadId: T1 });
  await s.store.append("doorbell_outcome", { messageId: post.messageId, recipient: "test-codex-1", threadId: T1, state: "unknown", errorCode: "DELIVERY_UNCERTAIN" });
  expect(await s.service.sweep()).toMatchObject({ alerted: 0 });
  s.advance(UNKNOWN_ALERT_AFTER_MS + 1000);
  expect(await s.service.sweep()).toMatchObject({ alerted: 1 });
  expect(await s.service.sweep()).toMatchObject({ alerted: 0 });
  expect((await s.alertLines()).map((l) => JSON.parse(l).kind)).toEqual(["doorbell_unknown"]);
  expect(s.calls.filter(([m]) => m === "turn/start")).toEqual([]);
});

test("the server cannot say the thread state: the CLI queue gets the doorbell, recorded as held; without a release pin it is not sent", async () => {
  const unavailable = Object.assign(new Error("x"), { code: "TARGET_UNAVAILABLE" });
  const s = await stand({ wakeError: unavailable, pin: "0.159.0" }); const post = await s.postTo();
  await s.service.onAppend(post);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "held", mode: "held_behind_running_turn", via: "queue" });
  expect(JSON.parse(await fs.readFile(path.join(s.root, "argv.json"), "utf8"))).toEqual(["queue", "--thread", T1, "--message", bell(post.messageId)]);
  const u = await stand({ wakeError: unavailable }); const p2 = await u.postTo();
  await u.service.onAppend(p2);
  expect(u.rows("doorbell_outcome")[0]).toMatchObject({ state: "not_sent", errorCode: "VERSION_UNKNOWN" });
});

test("two rings at the same moment for two aliases/threads: each reaches its own thread", async () => {
  const s = await stand({ peers: { "test-codex-1": { threadId: T1 }, "test-codex-2": { threadId: T2 } } });
  // A barrier: both calls are inside the app-server conversation before either reaches turn/start.
  let arrived = 0; let open; const gate = new Promise((r) => { open = r; });
  const base = s.service.wake.connect;
  s.service.wake.connect = (...a) => { const c = base(...a); const call = c.call; c.call = async (m, p) => { if (m === "thread/read") { arrived += 1; if (arrived === 2) open(); await gate; } return call(m, p); }; return c; };
  // A second barrier earlier: both rings leave their intent write together, so any state shared
  // between them after that point would be overwritten before it is used.
  let intents = 0; let release; const together = new Promise((r) => { release = r; });
  const realChecked = s.store.appendChecked.bind(s.store);
  s.store.appendChecked = async (type, data, conflict) => { const row = await realChecked(type, data, conflict); if (type === "doorbell_intent") { intents += 1; if (intents === 2) release(); await together; } return row; };
  const a = await s.postTo("test-codex-1", T1); const b = await s.postTo("test-codex-2", T2);
  await Promise.all([s.service.ring(a.messageId, { first: true }), s.service.ring(b.messageId, { first: true })]);
  const starts = s.calls.filter(([m]) => m === "turn/start").map(([, p]) => [p.threadId, p.input[0].text]);
  expect(starts.sort()).toEqual([[T1, bell(a.messageId)], [T2, bell(b.messageId)]].sort());
  expect(s.rows("doorbell_outcome").map((r) => [r.messageId, r.threadId, r.state]).sort()).toEqual([[a.messageId, T1, "sent"], [b.messageId, T2, "sent"]].sort());
});

test("the intent write fails right after the post is durable: the hook failure is reported and the sweep recovers (intent + one ring)", async () => {
  const s = await stand(); const failures = [];
  const realChecked = s.store.appendChecked.bind(s.store); let broken = true;
  s.store.appendChecked = (type, data, conflict) => (broken && type === "doorbell_intent" ? Promise.reject(Object.assign(new Error("disk"), { code: "ENOSPC" })) : realChecked(type, data, conflict));
  s.store.onAppend = (row) => s.service.onAppend(row);
  s.store.onAppendFailed = (row, error) => failures.push([row.type, error.code]);
  const post = await s.postTo();
  await Bun.sleep(50);
  expect(failures).toEqual([["peer_post", "ENOSPC"]]);
  expect(s.rows("doorbell_intent")).toEqual([]);
  broken = false;
  expect(await s.service.sweep()).toMatchObject({ intentsCreated: 1 });
  expect(s.rows("doorbell_intent")).toHaveLength(1);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ messageId: post.messageId, state: "sent" });
  expect(await s.service.sweep()).toMatchObject({ intentsCreated: 0, retried: 0 });
  expect(s.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
});

test("not_sent (settings or release): one alarm with its code, no automatic retry", async () => {
  const s = await stand({ version: "0.157.0", serverVersion: "0.159.0" });   // CLI and server releases differ
  const post = await s.postTo();
  await s.service.onAppend(post);
  expect(s.rows("doorbell_outcome")[0]).toMatchObject({ state: "not_sent", errorCode: "VERSION_MISMATCH" });
  expect(await s.service.sweep()).toMatchObject({ alerted: 1 });
  expect(await s.service.sweep()).toMatchObject({ alerted: 0, retried: 0, intentsCreated: 0 });
  expect((await s.alertLines()).map((l) => { const a = JSON.parse(l); return [a.kind, a.code]; })).toEqual([["doorbell_not_sent", "VERSION_MISMATCH"]]);
  expect(s.calls.filter(([m]) => m === "turn/start" || m === "turn/steer")).toEqual([]);
});

test("a processed message is never swept", async () => {
  const s = await stand(); const post = await s.postTo();
  await s.store.append("peer_post_processed", { messageId: post.messageId });
  expect(await s.service.sweep()).toEqual({ intentsCreated: 0, retried: 0, exhausted: 0, alerted: 0 });
});
