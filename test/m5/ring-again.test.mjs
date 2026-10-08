// M5 F2: a doorbell refused while the recipient was away is rung once more when it comes back.
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DoorbellService } from "../../src/core/doorbell-service.mjs";
import { EventStore } from "../../src/core/events.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
const S1 = "10000000-0000-4000-8000-0000000000aa"; const S2 = "20000000-0000-4000-8000-0000000000aa";

async function stand() {
  const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm5r-"))); roots.push(root); await fs.chmod(root, 0o700);
  const store = new EventStore(statePaths(root)); await store.init();
  const sent = []; let away = true;
  const service = new DoorbellService({ store, root, settings: { codexCli: { value: null }, codexAppServerSocket: { value: null } }, codexPeers: () => ({}), claudePeers: () => ({ "c-1": { sessionId: S1 } }),
    sendClaude: async ({ line }) => { if (away) throw Object.assign(new Error("gone"), { code: "TARGET_UNAVAILABLE" }); sent.push(line); return {}; } });
  const post = async (sessionId = S1) => { const row = await store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: sessionId }); await service.ring(row.messageId, { first: true }); return row; };
  return { store, service, sent, post, back: () => { away = false; }, rows: (t) => store.events.filter((e) => e.type === t) };
}

test("not_sent while away → rung once when the recipient is back; never twice", async () => {
  const s = await stand(); const p = await s.post();
  expect(s.rows("doorbell_outcome").map((e) => e.state)).toEqual(["not_sent"]);
  s.back();
  const first = await s.service.ringAgain("c-1", { binding: S1, trigger: "activity" });
  expect(first.map((r) => r.state)).toEqual(["sent"]);
  expect(s.sent).toHaveLength(1); expect(s.sent[0].split("\n")[0]).toBe(`PEER_DOORBELL v=1 message_id=${p.messageId}`); expect(s.sent[0]).toContain(`inbox --message-id ${p.messageId}`);
  expect(await s.service.ringAgain("c-1", { binding: S1, trigger: "activity" })).toEqual([]);
  expect(s.rows("doorbell_rering")).toHaveLength(1);
});

test("nothing for a processed message, another session's message, or a doorbell that was sent", async () => {
  const s = await stand();
  const done = await s.post(); await s.store.append("peer_post_processed", { messageId: done.messageId });
  await s.post(S2);
  s.back(); await s.post();   // sent the first time
  expect(await s.service.ringAgain("c-1", { binding: S1, trigger: "activity" })).toEqual([]);
});

test("registry return: only when the session is live again", async () => {
  const s = await stand(); await s.post(); s.back();
  expect(await s.service.ringReturnedClaude(async () => "not_running")).toEqual([]);
  expect(await s.service.ringReturnedClaude(async () => "unknown")).toEqual([]);
  expect((await s.service.ringReturnedClaude(async (id) => (id === S1 ? "running" : "not_running"))).map((r) => r.state)).toEqual(["sent"]);
  expect(s.rows("doorbell_rering")[0].trigger).toBe("registry");
});

test("any later sent / held / unknown outcome takes the message out (review P1)", async () => {
  for (const later of ["sent", "held", "unknown"]) {
    const s = await stand(); const p = await s.post();
    await s.store.append("doorbell_outcome", { messageId: p.messageId, recipient: "c-1", recipientKind: "claude", state: later });
    s.back();
    expect(await s.service.ringAgain("c-1", { binding: S1, trigger: "activity" })).toEqual([]);
  }
});

test("registry liveness needs the recorded start time: a reused pid is not the session (review P1)", async () => {
  const { sessionLiveness } = await import("../../src/adapters/claude-native-v1/registry.mjs");
  const dir = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm5l-"))); roots.push(dir); await fs.chmod(dir, 0o700);
  await fs.writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: S1, procStart: "Thu Jan  1 00:00:00 1970" }), { mode: 0o600 });
  expect(await sessionLiveness(S1, { sessionsDir: dir })).toBe("not_running");
  const { processStart } = await import("../../src/adapters/claude-native-v1/darwin-procargs.mjs");
  await fs.writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: S1, procStart: processStart(process.pid) }), { mode: 0o600 });
  expect(await sessionLiveness(S1, { sessionsDir: dir })).toBe("running");
  expect(await sessionLiveness(S1, { sessionsDir: path.join(dir, "missing") })).toBe("unknown");
});

test("a message bound to a previous session is never rung at the new one, and status does not promise it (review P2)", async () => {
  const s = await stand(); const old = await s.post(S2);   // bound to S2; the alias names S1
  s.back();
  expect(s.service.eligibleAgain(old)).toBe(false);
  expect(await s.service.ringAgain("c-1", { binding: null, trigger: "activity" })).toEqual([]);
});

// The replay matrix (review of abf57db): a reservation left by any build is replayed with exactly
// its own wording, and only a completed write counts as sent. `core` mimics PeerCore.send: a prior
// request with a different hash is MESSAGE_ID_CONFLICT; with the same hash it is a replay that
// reports the first attempt's durable state and sends nothing.
describe("replaying a reserved Claude doorbell", async () => {
  const { uuidv5 } = await import("../../src/core/posts.mjs");
  const { canonicalSend, sha256 } = await import("../../src/core/dedupe.mjs");
  const { claudeDoorbellVersions } = await import("../../src/core/doorbell.mjs");
  async function reserved(wording, status) {
    const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm5p-"))); roots.push(root); await fs.chmod(root, 0o700);
    const store = new EventStore(statePaths(root)); await store.init();
    const row = await store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S1 });
    const derived = uuidv5(`doorbell:${row.messageId}`);
    const body = wording === "unknown" ? "PEER_DOORBELL v=1 something else" : claudeDoorbellVersions(row.messageId)[wording];
    const hash = (line) => sha256(canonicalSend({ alias: "c-1", messageId: derived, threadId: row.messageId, kind: "doorbell", body: line }));
    store.request = (id) => (id === derived ? { messageId: id, requestHash: hash(body) } : null);
    const sent = [];
    const service = new DoorbellService({ store, root, settings: { codexCli: { value: null }, codexAppServerSocket: { value: null } }, codexPeers: () => ({}), claudePeers: () => ({ "c-1": { sessionId: S1 } }),
      sendClaude: async ({ line }) => { if (hash(line) !== hash(body)) throw Object.assign(new Error("conflict"), { code: "MESSAGE_ID_CONFLICT" }); sent.push(line); return { replay: true, status }; } });
    return { result: await service.ring(row.messageId, {}), sent, body };
  }
  for (const [name, wording] of [["legacy bare", 2], ["M5 r5", 1], ["M5 r6", 0]]) {
    test(`${name} written → replayed with its own wording, sent`, async () => {
      const r = await reserved(wording, "written");
      expect(r.result).toMatchObject({ state: "sent", replay: true }); expect(r.sent).toEqual([r.body]);
    });
    test(`${name} reserved only (crash before the write) → unknown, not sent`, async () => {
      const r = await reserved(wording, "requested");
      expect(r.result).toMatchObject({ state: "unknown", errorCode: "REPLAY_NOT_WRITTEN", replayStatus: "requested" });
    });
  }
  test("a reservation matching no known wording is not re-sent with another: unknown", async () => {
    const r = await reserved("unknown", "written");
    expect(r.result).toMatchObject({ state: "unknown", errorCode: "DOORBELL_ENVELOPE_UNKNOWN" }); expect(r.sent).toEqual([]);
  });
});

test("MESSAGE_ID_CONFLICT on a Claude doorbell is recorded as unknown", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm5c-"))); roots.push(root); await fs.chmod(root, 0o700);
  const store = new EventStore(statePaths(root)); await store.init();
  const service = new DoorbellService({ store, root, settings: { codexCli: { value: null }, codexAppServerSocket: { value: null } }, codexPeers: () => ({}), claudePeers: () => ({ "c-1": { sessionId: S1 } }),
    sendClaude: async () => { throw Object.assign(new Error("conflict"), { code: "MESSAGE_ID_CONFLICT" }); } });
  const row = await store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S1 });
  expect((await service.ring(row.messageId, { first: true })).state).toBe("unknown");
});

test("a message the Owner relinks is rung at its new session, once (measured: a relinked answer sat unannounced)", async () => {
  const s = await stand(); s.back();
  const old = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S2 });
  await s.service.ring(old.messageId, { first: true });
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "not_sent", errorCode: "WAKE_TARGET_MISMATCH" });
  await s.store.append("peer_post_relinked", { messageId: old.messageId, recipient: "c-1", recipientSessionId: S1 });
  expect(s.service.bindingOf(old)).toBe(S1);
  expect((await s.service.ringRelinked(old.messageId)).state).toBe("sent");
  expect(s.rows("doorbell_outcome").at(-1)).toMatchObject({ state: "sent", threadId: S1 });
  await s.store.append("peer_post_processed", { messageId: old.messageId });
  expect(await s.service.ringRelinked(old.messageId)).toBeNull();
  expect(s.rows("doorbell_relink_ring")).toHaveLength(1);
});

// Review of 0584332: the previous session's success must not stand for the session the message was
// moved to. `core` mimics PeerCore.send: a transport id already reserved replays and writes nothing.
describe("relink generations", () => {
  async function standCore() {
    const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm5g-"))); roots.push(root); await fs.chmod(root, 0o700);
    const store = new EventStore(statePaths(root)); await store.init();
    const writes = []; const reserved = new Map(); let current = S1;
    const service = new DoorbellService({ store, root, settings: { codexCli: { value: null }, codexAppServerSocket: { value: null } }, codexPeers: () => ({}), claudePeers: () => ({ "c-1": { sessionId: current } }),
      sendClaude: async ({ messageId }) => { if (reserved.has(messageId)) return { replay: true, status: "written" }; reserved.set(messageId, current); writes.push([messageId, current]); return {}; } });
    return { store, service, writes, move: (s) => { current = s; } };
  }
  test("sent at S1, alias moved to S2, relinked: written to S2 under a new transport id", async () => {
    const g = await standCore();
    const p = await g.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S1 });
    await g.service.ring(p.messageId, { first: true });
    g.move(S2);
    await g.store.append("peer_post_relinked", { messageId: p.messageId, recipient: "c-1", recipientSessionId: S2 });
    expect((await g.service.ringRelinked(p.messageId)).state).toBe("sent");
    expect(g.writes.map(([, s]) => s)).toEqual([S1, S2]);
    expect(new Set(g.writes.map(([id]) => id)).size).toBe(2);
  });
  test("the same move is rung once, even twice at once; a second move is rung again", async () => {
    const g = await standCore();
    const p = await g.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S2 });
    g.move(S1);
    await g.store.append("peer_post_relinked", { messageId: p.messageId, recipient: "c-1", recipientSessionId: S1 });
    const both = await Promise.all([g.service.ringRelinked(p.messageId), g.service.ringRelinked(p.messageId)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    const S3 = "30000000-0000-4000-8000-0000000000aa"; g.move(S3);
    await g.store.append("peer_post_relinked", { messageId: p.messageId, recipient: "c-1", recipientSessionId: S3 });
    expect((await g.service.ringRelinked(p.messageId)).state).toBe("sent");
    expect(g.writes.map(([, s]) => s)).toEqual([S1, S3]);
    expect(g.store.events.filter((e) => e.type === "doorbell_relink_ring")).toHaveLength(2);
  });
});

test("moving a message to the session it is already bound to is refused (not a move)", async () => {
  const { relinkPost } = await import("../../src/core/posts.mjs");
  const s = await stand();
  const p = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S2 });
  await expect(relinkPost(s.store, { messageId: p.messageId, identity: { kind: "claude", sessionId: S2 } })).rejects.toMatchObject({ code: "ALREADY_BOUND" });
  expect((await relinkPost(s.store, { messageId: p.messageId, identity: { kind: "claude", sessionId: S1 } })).relinked).toBe(true);
  await expect(relinkPost(s.store, { messageId: p.messageId, identity: { kind: "claude", sessionId: S1 } })).rejects.toMatchObject({ code: "ALREADY_BOUND" });
});

describe("relink generations, review of 5adccbd", () => {
  async function standSlow() {
    const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm5h-"))); roots.push(root); await fs.chmod(root, 0o700);
    const store = new EventStore(statePaths(root)); await store.init();
    let current = S1; let release; const gate = new Promise((r) => { release = r; }); let calls = 0;
    const service = new DoorbellService({ store, root, settings: { codexCli: { value: null }, codexAppServerSocket: { value: null } }, codexPeers: () => ({}), claudePeers: () => ({ "c-1": { sessionId: current } }),
      sendClaude: async () => { calls += 1; if (calls === 1) { await gate; throw Object.assign(new Error("x"), { code: "WAKE_FAILED" }); } return {}; } });
    return { store, service, move: (s) => { current = s; }, release: () => release() };
  }
  test("an attempt that started at S1 and fails after a relink is recorded for S1's generation; S2's success stands", async () => {
    const { overview } = await import("../../src/core/overview.mjs");
    const g = await standSlow();
    const p = await g.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S1 });
    const slow = g.service.ring(p.messageId, { first: true });
    await Bun.sleep(20);
    g.move(S2); await g.store.append("peer_post_relinked", { messageId: p.messageId, recipient: "c-1", recipientSessionId: S2 });
    expect((await g.service.ringRelinked(p.messageId)).state).toBe("sent");
    g.release(); await slow;
    const outcomes = g.store.events.filter((e) => e.type === "doorbell_outcome").map((e) => [e.threadId, e.state, e.relinkSeq ?? 0]);
    const gen = g.store.events.find((e) => e.type === "peer_post_relinked").seq;
    expect(outcomes).toEqual([[S2, "sent", gen], [S1, "not_sent", 0]]);
    const v = overview({ events: g.store.events, peers: [{ alias: "c-1", kind: "claude", sessionId: S2 }] });
    expect(v.peers[0]).toMatchObject({ unprocessed: 1, undelivered: 0, uncertain: 0 });
  });
  test("a claim written and never rung (a crash) shows as not delivered for the current generation", async () => {
    const { overview } = await import("../../src/core/overview.mjs");
    const s = await stand(); s.back();
    const p = await s.post();   // sent at S1 (generation 0)
    const r = await s.store.append("peer_post_relinked", { messageId: p.messageId, recipient: "c-1", recipientSessionId: S2 });
    await s.store.append("doorbell_relink_ring", { messageId: p.messageId, recipient: "c-1", threadId: S2, relinkSeq: r.seq });
    const v = overview({ events: s.store.events, peers: [{ alias: "c-1", kind: "claude", sessionId: S2 }] });
    expect(v.peers[0]).toMatchObject({ undelivered: 1 });
  });
  test("two identical moves at once: one relink, one ALREADY_BOUND", async () => {
    const { relinkPost } = await import("../../src/core/posts.mjs");
    const s = await stand();
    const p = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S2 });
    const both = await Promise.allSettled([relinkPost(s.store, { messageId: p.messageId, identity: { kind: "claude", sessionId: S1 } }), relinkPost(s.store, { messageId: p.messageId, identity: { kind: "claude", sessionId: S1 } })]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(both.find((r) => r.status === "rejected").reason.code).toBe("ALREADY_BOUND");
    expect(s.store.events.filter((e) => e.type === "peer_post_relinked")).toHaveLength(1);
  });
});

test("the Claude sender is told which session the attempt is for", async () => {
  const s = await stand(); s.back();
  let seen = null; s.service.sendClaude = async (args) => { seen = args.expectSessionId; return {}; };
  const p = await s.store.append("peer_post", { messageId: crypto.randomUUID(), recipient: "c-1", recipientKind: "claude", recipientSessionId: S1 });
  await s.service.ring(p.messageId, { first: true });
  expect(seen).toBe(S1);
});

describe("misopened sessions (measured 2026-10-07: a re-ring spent on argv_executable_mismatch)", () => {
  test("PeerCore.reachable answers without a ledger row and names the resolver's reason", async () => {
    const { PeerCore } = await import("../../src/core/peer-core.mjs");
    const rows = []; const store = { append: async (t, d) => { rows.push({ type: t, ...d }); return {}; } };
    const ok = new PeerCore({ targets: { "c-1": { sessionId: S1 } }, store, address: "uds:/x.sock", resolver: async () => ({ sessionId: S1 }) });
    expect(await ok.reachable("c-1")).toEqual({ reachable: true, reason: null });
    const bad = new PeerCore({ targets: { "c-1": { sessionId: S1 } }, store, address: "uds:/x.sock", resolver: async () => { throw new Error("target argv executable mismatch"); } });
    expect(await bad.reachable("c-1")).toEqual({ reachable: false, reason: "argv_executable_mismatch" });
    expect(await bad.reachable("nobody")).toEqual({ reachable: false, reason: "unknown_alias" });
    expect(rows).toEqual([]);
  });
  test("a re-ring that could not land leaves one more chance; at most two", async () => {
    const s = await stand(); const p = await s.post();   // not_sent while away
    await s.store.append("doorbell_rering", { messageId: p.messageId, recipient: "c-1", trigger: "registry" });
    await s.store.append("doorbell_outcome", { messageId: p.messageId, recipient: "c-1", recipientKind: "claude", state: "not_sent", errorCode: "TARGET_UNAVAILABLE" });
    expect(s.service.eligibleAgain(p)).toBe(true);
    s.back();
    expect((await s.service.ringAgain("c-1", { binding: S1, trigger: "activity" })).map((r) => r.state)).toEqual(["sent"]);
    expect(s.service.eligibleAgain(p)).toBe(false);
  });
});
