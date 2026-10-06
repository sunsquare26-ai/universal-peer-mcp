// M4 review fixes: [상]1 mail stays with the session it was for; [상]2 bodies leave only through the
// reader's own path (with the compatibility window); [중] no orphan body files.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { lane, stopDaemon, writeBody } from "./harness.mjs";
import { controlCall } from "../../src/core/control.mjs";
import { EventStore } from "../../src/core/events.mjs";
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { PeerCore, frameObserver } from "../../src/core/peer-core.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { acceptPost } from "../../src/core/posts.mjs";
import { sweepOrphanBodies } from "../../src/core/orphans.mjs";
import { openStore, tempRoot } from "../m1/helpers.mjs";

// Operator cases run in L.detached: a process with no session ancestor (reparented to launchd), so
// they give the same answer whether the tests run inside a Claude session, a Codex thread or neither.
const lanes = [];
afterEach(async () => { for (const L of lanes.splice(0)) await L.stop(); });
async function setup() {
  const L = await lane(); lanes.push(L); await L.owner(["peers"]);
  const c1 = await L.claude(); const x1 = await L.codex();
  for (const [s, a] of [[c1, "test-claude-1"], [x1, "test-codex-1"]]) expect((await s.run(["register", "--alias", a])).json.state).toBe("registered");
  return { L, c1, x1 };
}
const post = async (L, from, to, text) => (await from.run(["post", "--to", to, "--body-file", await writeBody(L, text)])).json.results[0].messageId;

// ---------------------------------------------------------------- [상]1
test("--replace, post before: the new session never sees or acks the old session's mail; peers counts it; the Owner re-addresses by hand", async () => {
  const { L, c1, x1 } = await setup();
  const waiting = await post(L, c1, "test-codex-1", "secret for x1");
  const x2 = await L.codex();
  await x2.run(["register", "--alias", "test-codex-1", "--replace"]);
  expect((await x2.run(["inbox"])).json.events).toEqual([]);
  expect((await x2.run(["inbox-ack", "--message-id", waiting])).error).toMatchObject({ code: "NOT_RECIPIENT" });
  expect((await x2.run(["link", "--post", waiting])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  expect((await L.detached(["link", "--post", waiting])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "no_tty" });
  const listed = (await L.owner(["peers"])).json;
  expect(listed.peers.find((p) => p.alias === "test-codex-1").heldForPreviousSession).toBe(1);
  expect(JSON.stringify(listed)).not.toContain("secret");
  expect((await L.detached(["link", "--post", waiting], `CONFIRM ${waiting}`)).json).toMatchObject({ relinked: true, recipient: "test-codex-1" });
  const box = (await x2.run(["inbox"])).json.events;
  expect(box.map((e) => [e.messageId, e.body])).toEqual([[waiting, "secret for x1"]]);
  expect((await L.owner(["peers"])).json.peers.find((p) => p.alias === "test-codex-1").heldForPreviousSession).toBeUndefined();
}, 60_000);

test("--replace, replace before post: mail sent after the move is the new session's, and the old one cannot read it", async () => {
  const { L, c1, x1 } = await setup();
  const x2 = await L.codex();
  await x2.run(["register", "--alias", "test-codex-1", "--replace"]);
  const m = await post(L, c1, "test-codex-1", "for x2");
  expect((await x2.run(["inbox"])).json.events.map((e) => e.messageId)).toEqual([m]);
  expect((await x1.run(["inbox"])).error).toMatchObject({ code: "SENDER_UNAUTHENTICATED" });
  // Moving back is the same session again: it gets back what was bound to it, nothing of x2's.
  await x1.run(["register", "--alias", "test-codex-1", "--replace"]);
  expect((await x1.run(["inbox"])).json.events).toEqual([]);
});

test("Claude: resume inherits (post before and after), a different session with --replace does not", async () => {
  const { L, c1, x1 } = await setup();
  const before = await post(L, x1, "test-claude-1", "before restart");
  await c1.close();
  const c1b = await L.claude({ resume: c1.sessionId });
  const after = await post(L, x1, "test-claude-1", "after restart");     // resolves to c1b once rebound
  expect((await c1b.run(["inbox"])).json.events.map((e) => e.messageId).sort()).toEqual([before, after].sort());
  const pending = await post(L, x1, "test-claude-1", "for c1b");
  const other = await L.claude();
  await other.run(["register", "--alias", "test-claude-1", "--replace"]);
  const seen = (await other.run(["inbox"])).json.events.map((e) => e.messageId);
  expect(seen).not.toContain(pending); expect(seen).not.toContain(before);
  expect((await L.owner(["peers"])).json.peers.find((p) => p.alias === "test-claude-1").heldForPreviousSession).toBe(3);
});

// ---------------------------------------------------------------- [상]2
// A ledger with one request this lane "sent" to `review`, its correlated reply (body kept), and one
// frame that correlated nothing (body kept). Built offline, then served by a real daemon.
async function seeded({ legacy }) {
  const L = await lane(); lanes.push(L);
  const target = { sessionId: crypto.randomUUID(), cwd: L.work, permissionMode: "prompting" };
  await fsp.writeFile(L.paths.targets, JSON.stringify({ review: target }), { mode: 0o600 });
  if (legacy !== undefined) await fsp.writeFile(path.join(L.root, "config.json"), JSON.stringify({ legacyBodiesInDiagnostics: legacy }), { mode: 0o600 });
  const store = new EventStore(statePaths(L.root)); await store.init();
  const resolved = { ...target, expectedDisplayName: null, pid: 99, procStart: "start", socketPath: "/tmp/fake-review.sock", token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const core = new PeerCore({ targets: { review: { ...target, expectedDisplayName: null } }, store, address: "uds:/tmp/x.sock", resolver: async () => resolved, sender: async () => ({ bytesWritten: 1 }), inboundSpool: new InboundSpool(statePaths(L.root)) });
  const send = { alias: "review", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "question", body: "q" };
  await core.send(send);
  const onFrame = frameObserver({ core, store });
  await onFrame({ type: "user", from: "uds:/tmp/fake-review.sock", message: { content: `PEER_REPLY v=1 message_id=${crypto.randomUUID()} thread_id=${send.threadId} reply_to=${send.messageId} verdict=pass\nREPLY-BODY` } }, { pid: 99, procStart: "start" }, {});
  await onFrame({ type: "user", from: "uds:/tmp/fake-review.sock", message: { content: "free text UNMATCHED-BODY" } }, { pid: 99, procStart: "start" }, {});
  await store.close();
  return { L, send };
}
// Another process of the same user: the "different session reading via cursor".
async function otherProcess(L, method, args) {
  const script = `import { controlCall } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/core/control.mjs"))}; process.stdout.write(JSON.stringify(await controlCall(${JSON.stringify(method)}, ${JSON.stringify(args)})));`;
  const child = spawn(process.execPath, ["-e", script], { env: L.env, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); await new Promise((r) => child.on("close", r));
  return JSON.parse(out);
}
const bodies = (events) => events.filter((e) => typeof e.body === "string").map((e) => (e.body.includes("REPLY-BODY") ? "REPLY-BODY" : e.body));

for (const legacy of [false, true]) {
  test(`compatibility window ${legacy ? "on: legacy peer_send → peer_wait bodies, for every reader" : "off: no diagnostic answer carries a body, not even to the process that sent the request"}`, async () => {
    const { L, send } = await seeded({ legacy });
    const status = await controlCall("daemon_status", {}, { root: L.root });
    expect(status.settings.warning).toBe(legacy ? "진단 본문 노출 호환창 켜짐" : undefined);
    const expect_ = { daemonPid: status.pid, daemonProcStart: status.procStart, targetsDigest: status.targetsDigest };
    // This process asks (a replay of the request: no socket is touched), then waits for the reply —
    // the way a Codex MCP serve did, and one serve can carry several threads.
    const replay = await controlCall("peer_send", send, { root: L.root, expect: expect_ });
    expect(replay.status).toBe("replied");
    const waited = await controlCall("peer_wait", { messageId: send.messageId, require: "reply", timeoutMs: 100 }, { root: L.root });
    const mine = await controlCall("peer_list_events", { afterSeq: 0 }, { root: L.root });
    const theirs = await otherProcess(L, "peer_list_events", { afterSeq: 0 });
    const theirWait = await otherProcess(L, "peer_wait", { messageId: send.messageId, require: "reply", timeoutMs: 100 });
    if (legacy) {
      expect(waited.event.body).toContain("REPLY-BODY"); expect(theirWait.event.body).toContain("REPLY-BODY");
      expect(bodies(mine.events).length).toBe(2); expect(bodies(theirs.events).length).toBe(2);
    } else {
      expect(waited.event.body).toBeUndefined(); expect(theirWait.event.body).toBeUndefined();
      expect(bodies(mine.events)).toEqual([]); expect(bodies(theirs.events)).toEqual([]);
      expect(waited.event.bodyInlineOmitted).toBe("not_for_this_reader");
      expect(JSON.stringify(await otherProcess(L, "trace_message", { messageId: send.messageId }))).not.toContain("REPLY-BODY");
    }
    expect((await L.owner(["peers"])).json.warning).toBe(legacy ? "진단 본문 노출 호환창 켜짐" : undefined);
  });
}

test("two Codex threads in one host process: a thread's answer reaches only its own inbox; the other thread and every diagnostic reader get no body", async () => {
  const { L, c1, x1 } = await setup();            // x1: a host process; its default thread is test-codex-1
  const T2 = (await import("./harness.mjs")).uuidv7(); await L.rollout(T2);
  expect((await x1.run(["register", "--alias", "test-codex-2"], { thread: T2 })).json).toMatchObject({ state: "registered", kind: "codex", threadId: T2 });
  // Codex sends with the shell post; Claude answers with --reply-to.
  const ask = await post(L, x1, "test-claude-1", "QUESTION");
  const q = (await c1.run(["inbox"])).json.events;
  expect(q.map((e) => [e.messageId, e.body, e.senderAlias])).toEqual([[ask, "QUESTION", "test-codex-1"]]);
  const ans = await c1.run(["post", "--reply-to", ask, "--body-file", await writeBody(L, "ANSWER")]);
  expect(ans.json).toMatchObject({ replyTo: ask, results: [{ recipient: "test-codex-1", state: "accepted" }] });
  // M5: the same answer sent again — twice at once, then again — is the first answer, not a second
  // message; different text, or an explicit --group-id, is a new message.
  const both = await Promise.all([1, 2].map(async () => c1.run(["post", "--reply-to", ask, "--body-file", await writeBody(L, "ANSWER")])));
  for (const r of both) expect(r.json.results[0]).toMatchObject({ recipient: "test-codex-1", messageId: ans.json.results[0].messageId, state: "duplicate" });
  const other = await c1.run(["post", "--reply-to", ask, "--body-file", await writeBody(L, "ANSWER 2")]);
  const named = await c1.run(["post", "--reply-to", ask, "--body-file", await writeBody(L, "ANSWER"), "--group-id", crypto.randomUUID()]);
  expect([other.json.results[0].state, named.json.results[0].state]).toEqual(["accepted", "accepted"]);
  expect(new Set([ans, other, named].map((r) => r.json.results[0].messageId)).size).toBe(3);
  await x1.run(["inbox-ack", "--message-id", other.json.results[0].messageId]); await x1.run(["inbox-ack", "--message-id", named.json.results[0].messageId]);
  // Only the asking thread reads it; the other thread in the same host process sees nothing.
  expect((await x1.run(["inbox"])).json.events.map((e) => [e.body, e.replyTo])).toEqual([["ANSWER", ask]]);
  expect((await x1.run(["inbox"], { thread: T2 })).json.events).toEqual([]);
  expect((await x1.run(["inbox", "--recipient", "test-codex-1"], { thread: T2 })).error).toMatchObject({ code: "RECIPIENT_MISMATCH" });
  // Nobody else may answer for Claude, and diagnostics hand out neither the question nor the answer.
  expect((await x1.run(["post", "--reply-to", ask, "--body-file", await writeBody(L, "forged")], { thread: T2 })).error).toMatchObject({ code: "REPLY_NOT_ALLOWED" });
  const listing = JSON.stringify(await otherProcess(L, "peer_list_events", { afterSeq: 0 }));
  expect(listing).not.toContain("QUESTION"); expect(listing).not.toContain("ANSWER");
  // The answer stays bound to the asking thread even after the alias moves to another thread.
  const again = await post(L, x1, "test-claude-1", "SECOND");
  const x3 = await L.codex(); await x3.run(["register", "--alias", "test-codex-1", "--replace"]);
  expect((await c1.run(["post", "--reply-to", again, "--body-file", await writeBody(L, "LATE")])).json.results[0].state).toBe("accepted");
  expect((await x3.run(["inbox"])).json.events).toEqual([]);
  expect((await L.owner(["peers"])).json.peers.find((p) => p.alias === "test-codex-1").heldForPreviousSession).toBe(2);   // ANSWER (unacked) + LATE
});

test("a peer's post body is not in the diagnostic answers; its own inbox still returns it", async () => {
  const { L, c1, x1 } = await setup();
  const m = await post(L, c1, "test-codex-1", "INBOX-ONLY");
  const listing = await otherProcess(L, "peer_list_events", { afterSeq: 0 });
  expect(JSON.stringify(listing)).not.toContain("INBOX-ONLY");
  expect((await x1.run(["inbox"])).json.events.map((e) => [e.messageId, e.body])).toEqual([[m, "INBOX-ONLY"]]);
});

// ---------------------------------------------------------------- [중] orphan body files
test("a post whose row cannot be written leaves no body file; a later sweep moves any leftover aside with one alert", async () => {
  const root = await tempRoot();
  try {
    const store = await openStore(root); const spool = new InboundSpool(statePaths(root));
    const files = async (dir = "inbound") => (await fsp.readdir(path.join(root, dir)).catch(() => [])).length;
    const broken = Object.create(store); broken.appendChecked = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    await expect(acceptPost({ store: broken, spool, messageId: crypto.randomUUID(), body: "x", who: {}, source: "control" })).rejects.toThrow();
    expect(await files()).toBe(0);
    // A leftover from an older build (or a failed unlink): moved aside, counted once, never deleted.
    await fsp.writeFile(path.join(root, "inbound", "2026-01-01T000000000Z-aaaaaaaaaaaaaaaa.txt"), "old", { mode: 0o600 });
    await acceptPost({ store, spool, messageId: crypto.randomUUID(), body: "kept", who: {}, source: "control" });
    const raised = [];
    expect(await sweepOrphanBodies({ root, store, alerts: { raise: async (a) => { raised.push(a); } }, graceMs: 0 })).toEqual({ moved: 1 });
    expect(await files()).toBe(1); expect(await files("inbound-orphans")).toBe(1);
    expect(raised).toHaveLength(1); expect(store.events.filter((e) => e.type === "inbound_orphans_moved")).toHaveLength(1);
    expect(await sweepOrphanBodies({ root, store, graceMs: 0 })).toEqual({ moved: 0 });
    await store.close();
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- operator(interactive-tty)
test("cross-session mutations are refused: dispose, link, relink, unregister of another's items; own items pass", async () => {
  const { L, c1, x1 } = await setup();
  const m = await post(L, c1, "test-codex-1", "DISPOSABLE");
  const row = (await x1.run(["inbox"])).json.events[0];
  expect(row.seq).toBeGreaterThan(0);
  // another session cannot dispose it, nor can a terminal without a tty
  expect((await c1.run(["body-dispose", "--seq", String(row.seq), "--disposition", "discard"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  expect((await L.detached(["body-dispose", "--seq", String(row.seq), "--disposition", "discard"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "no_tty" });
  // the recipient session can
  expect((await x1.run(["body-dispose", "--seq", String(row.seq), "--disposition", "discard"])).json).toMatchObject({ disposition: "discard" });
  // link of an unmatched frame / relink / another alias: refused to sessions and to non-tty callers
  expect((await c1.run(["link", "--seq", "1", "--message-id", m, "--as", "ack"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  expect((await L.detached(["link", "--seq", "1", "--message-id", m, "--as", "ack"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "no_tty" });
  expect((await x1.run(["unregister", "--alias", "test-claude-1"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  // an unregistered Claude session is still a session
  const stranger = await L.claude();
  expect((await stranger.run(["whoami"])).json.authenticated).toBe(false);
  expect((await stranger.run(["link", "--post", m])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  expect((await stranger.run(["unregister", "--alias", "test-codex-1"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  const refused = (await L.events()).filter((e) => e.type === "operator_refused");
  expect(refused.every((e) => e.operator === "operator(interactive-tty)")).toBe(true);
  expect(refused.length).toBe(7);
  // diagnostics: metadata keeps seq, not the body file name
  const listing = await otherProcess(L, "peer_list_events", { afterSeq: 0 });
  expect(listing.events.every((e) => e.bodyFile === undefined && Number.isInteger(e.seq))).toBe(true);
}, 60_000);

test("operator(interactive-tty): the phrase typed at a terminal outside any session passes and is recorded; a wrong phrase does not", async () => {
  const { L, c1, x1 } = await setup();
  const wrong = await L.detached(["unregister", "--alias", "test-claude-1"], "CONFIRM test-codex-1");
  expect(wrong.prompted).toBe(true); expect(wrong.error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "confirm_mismatch" });
  expect((await L.detached(["unregister", "--alias", "test-claude-1"], "CONFIRM test-claude-1")).json).toEqual({ removed: true, alias: "test-claude-1", kind: "claude" });
  const m = await post(L, x1, "test-codex-1", "to self");
  const seq = (await x1.run(["inbox"])).json.events[0].seq;
  expect((await L.detached(["body-dispose", "--seq", String(seq), "--disposition", "discard"], `CONFIRM ${seq}`)).json).toMatchObject({ disposition: "discard" });
  const actions = (await L.events()).filter((e) => e.type === "operator_action");
  expect(actions.map((e) => [e.action, e.target, e.operator])).toEqual([["unregister", "test-claude-1", "operator(interactive-tty)"], ["dispose", String(seq), "operator(interactive-tty)"]]);
  expect(actions.every((e) => /^tty/.test(e.tty))).toBe(true);
  void c1; void m;
}, 60_000);
