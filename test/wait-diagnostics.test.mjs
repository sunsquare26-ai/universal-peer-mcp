// Two failures that cost two days between them, both in `PeerCore.wait`.
//
//  (a) an expiry was told to the caller and to nobody else. `timedOut()` returned an object and
//      never appended a row, so the ledger showed zero timeouts while 34 had happened across
//      2026-09-10 and 2026-09-11 over 20 distinct message ids. The number had to be recovered from
//      a transcript, because the durable record of this system did not contain it.
//  (b) a wait for the weaker of two kinds of evidence expired while the stronger one sat in the
//      ledger. Measured 2026-09-10T07:20:06Z: message a93dde78-…, a `verdict=pass` reply already
//      recorded, a `require: "ack"` wait expiring after 30 s. A peer that answered necessarily
//      received.
import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { waitEvidence, WAIT_EVIDENCE } from "../src/core/wait-requirements.mjs";

const M = "10000000-0000-4000-8000-0000000000a1";
const T = "10000000-0000-4000-8000-0000000000a2";
const R = "10000000-0000-4000-8000-0000000000a3";
const peer = { pid: 99, procStart: "start" };
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

async function wired() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "peer-wait-"))); roots.push(root);
  await fsp.chmod(root, 0o700);
  const paths = statePaths(root);
  const store = new EventStore(paths); await store.init();
  const target = { sessionId: R, cwd: root, permissionMode: "prompting" };
  const resolved = { ...target, ...peer, socketPath: "/tmp/fixture-wait.sock", token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" } };
  const core = new PeerCore({
    targets: { review: target }, store, address: "uds:/tmp/sender.sock",
    resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 })
  });
  await core.send({ alias: "review", messageId: M, threadId: T, kind: "question", body: "hello" });
  return { core, store, paths };
}

const ack = () => `PEER_ACK v=1 message_id=${R} thread_id=${T} reply_to=${M}`;
const reply = () => `PEER_REPLY v=1 message_id=${R} thread_id=${T} reply_to=${M} verdict=pass`;

test("W1 an expired wait is written to the ledger, with what it waited for and how long", async () => {
  const { core, store, paths } = await wired();
  const before = store.events.length;
  const result = await core.wait({ messageId: M, require: "ack", timeoutMs: 30 });
  expect(result.timedOut).toBe(true);
  expect(result.state).toBe("written");

  const row = store.events.at(-1);
  expect(row).toMatchObject({ type: "peer_wait_timed_out", messageId: M, require: "ack", state: "written", timeoutMs: 30 });
  expect(row.waitedMs).toBeGreaterThanOrEqual(30);
  expect(store.events.length).toBe(before + 1);

  // Durable, not just in memory.
  const reopened = new EventStore(paths); await reopened.init();
  expect(reopened.events.filter((event) => event.type === "peer_wait_timed_out")).toHaveLength(1);

  // And the answer does not carry the row it just wrote — the evidence it reports on is the
  // evidence that existed when it gave up.
  expect(result.events.some((event) => event.type === "peer_wait_timed_out")).toBe(false);
});

test("W1 a late answer is still collected by waiting on the same messageId", async () => {
  const { core, store } = await wired();
  expect((await core.wait({ messageId: M, require: "ack", timeoutMs: 20 })).timedOut).toBe(true);
  await core.acceptFrame({ message: { content: ack() } }, peer);
  const late = await core.wait({ messageId: M, require: "ack", timeoutMs: 20 });
  expect(late.timedOut).toBeUndefined();
  expect(late.event.type).toBe("peer_ack");
  expect(store.events.filter((event) => event.type === "peer_wait_timed_out")).toHaveLength(1);
});

test("W1 an expiry that cannot be written still answers the caller", async () => {
  const { core } = await wired();
  core.store.append = async () => { throw new Error("ledger wedged"); };
  const result = await core.wait({ messageId: M, require: "reply", timeoutMs: 10 });
  expect(result).toMatchObject({ timedOut: true, messageId: M, require: "reply" });
});

test("W2 a reply satisfies a wait for an ack, immediately", async () => {
  const { core, store } = await wired();
  await core.acceptFrame({ message: { content: reply() } }, peer);
  expect(store.events.some((event) => event.type === "peer_ack")).toBe(false);

  const started = Date.now();
  const result = await core.wait({ messageId: M, require: "ack", timeoutMs: 300_000 });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(result.timedOut).toBeUndefined();
  expect(result.event.type).toBe("peer_reply");
  expect(result.event.verdict).toBe("pass");
  expect(store.events.some((event) => event.type === "peer_wait_timed_out")).toBe(false);
});

test("W2 negative: an ack does not satisfy a wait for a reply", async () => {
  const { core, store } = await wired();
  await core.acceptFrame({ message: { content: ack() } }, peer);
  expect(store.events.some((event) => event.type === "peer_ack")).toBe(true);

  const result = await core.wait({ messageId: M, require: "reply", timeoutMs: 30 });
  expect(result.timedOut).toBe(true);
  expect(result.state).toBe("acknowledged");
  expect(store.events.at(-1)).toMatchObject({ type: "peer_wait_timed_out", require: "reply", state: "acknowledged" });
});

test("W2 the promotion is defined once and only in the direction that is true", () => {
  expect(waitEvidence("ack").map((kind) => kind.type)).toEqual(["peer_ack", "peer_reply"]);
  expect(waitEvidence("reply").map((kind) => kind.type)).toEqual(["peer_reply"]);
  // Nothing else is promoted into anything: idle, delivery and terminal each accept exactly one
  // kind, so a caller asking for one of them is answered by that one and no other.
  for (const requirement of ["idle", "delivery", "terminal"]) expect(waitEvidence(requirement)).toHaveLength(1);
  expect(waitEvidence("constructor")).toBeNull();
  expect(waitEvidence("anything-else")).toBeNull();
  expect(Object.isFrozen(WAIT_EVIDENCE)).toBe(true);
});

test("W2 an ack that arrives first is still the answer to a wait for an ack", async () => {
  const { core } = await wired();
  await core.acceptFrame({ message: { content: ack() } }, peer);
  await core.acceptFrame({ message: { content: reply() } }, peer);
  expect((await core.wait({ messageId: M, require: "ack", timeoutMs: 50 })).event.type).toBe("peer_ack");
  expect((await core.wait({ messageId: M, require: "reply", timeoutMs: 50 })).event.type).toBe("peer_reply");
});
