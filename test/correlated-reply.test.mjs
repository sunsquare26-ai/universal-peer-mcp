// A reply from a peer running this package arrives inside an envelope. Core read the raw content
// and handed it straight to `parseMarker`, which is anchored at the first byte of the first line
// — and the first byte of a wrapped message is `<`. So the marker was never found, every real
// reply ended as `no_reply_marker`, and `acknowledged` and `replied` were states no ledger could
// reach. Measured before this file existed: three state directories from real round trips, zero
// `peer_ack` and zero `peer_reply` rows between them.
//
// The unwrapping lives in one place now (`unwrapEnvelope`) and core, milestone and code review
// all read it from there, because this is the third time a body has had to be taken out of an
// envelope and the first two were copies of each other.
//
// The hook is the second half. `frameObserver` calls its observers for every frame, correlated or
// not, so an observer cannot tell "this answers a message we sent" from "this arrived". A return
// path needs exactly that distinction and needs the text, which the ledger does not keep. So
// `onCorrelatedReply` is called after the ledger row is written and only then.
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import * as peerCore from "../src/core/peer-core.mjs";
import { senderEnvelope } from "../src/adapters/claude-native-v1/protocol.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const { PeerCore } = peerCore;
const roots = [];
const messageId = "10000000-0000-4000-8000-000000000010";
const threadId = "10000000-0000-4000-8000-000000000011";
const replyId = "10000000-0000-4000-8000-000000000012";
const TARGET_SOCKET = "/tmp/fake-correlated.sock";
const FROM = `uds:${TARGET_SOCKET}`;

afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

async function make({ hook = null } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-correlated-")); roots.push(made); await fsp.chmod(made, 0o700);
  const root = await fsp.realpath(made);
  const store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: "10000000-0000-4000-8000-000000000020", cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: 99, procStart: "start", socketPath: TARGET_SOCKET, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const calls = [];
  const core = new PeerCore({
    targets: { review: target }, store, address: "uds:/tmp/sender.sock",
    resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 }),
    onCorrelatedReply: hook === null ? (call) => { calls.push(call); } : hook
  });
  await core.send({ alias: "review", messageId, threadId, kind: "question", body: "hello" });
  return { core, store, calls, peer: { pid: 99, procStart: "start" } };
}

const marker = (type, { replyTo = messageId, thread = threadId, id = replyId, verdict = "pass" } = {}) =>
  type === "ack"
    ? `PEER_ACK v=1 message_id=${id} thread_id=${thread} reply_to=${replyTo}`
    : `PEER_REPLY v=1 message_id=${id} thread_id=${thread} reply_to=${replyTo} verdict=${verdict}`;

// The shape a peer running this package actually writes: the marker and whatever follows it,
// wrapped by `senderEnvelope`, carried in a user frame whose `from` is the writer's own socket.
const wrapped = (body, overrides = {}) => ({
  type: "user", msg_id: crypto.randomUUID(), from: FROM,
  message: { role: "user", content: senderEnvelope({ from: FROM, body }) },
  ...overrides
});

describe("an envelope-wrapped reply correlates", () => {
  test("a wrapped reply reaches the ledger as peer_reply and a wrapped ack as peer_ack", async () => {
    const ctx = await make();
    expect(await ctx.core.acceptFrame(wrapped(`${marker("ack")}\nworking on it`), ctx.peer)).toBeNull();
    expect(await ctx.core.acceptFrame(wrapped(`${marker("reply")}\nthe answer`), ctx.peer)).toBeNull();
    const types = ctx.store.events.map((event) => event.type);
    expect(types).toContain("peer_ack");
    expect(types).toContain("peer_reply");
    expect((await ctx.core.wait({ messageId, require: "reply", timeoutMs: 50 })).event).toMatchObject({ type: "peer_reply", messageId, responseMessageId: replyId, verdict: "pass", evidence: "application_ack" });
    expect((await ctx.core.send({ alias: "review", messageId, threadId, kind: "question", body: "hello" })).status).toBe("replied");
  });

  test("an unwrapped reply still correlates — one reader, both shapes", async () => {
    const ctx = await make();
    await ctx.core.acceptFrame({ type: "user", from: FROM, message: { content: marker("reply") } }, ctx.peer);
    expect(ctx.store.events.some((event) => event.type === "peer_reply")).toBeTrue();
  });

  test("an envelope whose declared writer is not the frame's writer is not unwrapped", async () => {
    const ctx = await make();
    const forged = { type: "user", from: "uds:/tmp/somebody-else.sock", message: { content: senderEnvelope({ from: FROM, body: marker("reply") }) } };
    expect(await ctx.core.acceptFrame(forged, ctx.peer)).toEqual({ reason: "no_reply_marker" });
    expect(ctx.store.events.some((event) => event.type === "peer_reply")).toBeFalse();
    expect(ctx.calls).toEqual([]);
  });
});

describe("onCorrelatedReply", () => {
  test("is announced as a capability so a caller can refuse to run without it", () => {
    expect(peerCore.CORRELATED_REPLY_HOOK).toBe("onCorrelatedReply/v1");
    expect(PeerCore.capabilities).toContain("onCorrelatedReply/v1");
  });

  test("carries the published shape, and the alias comes from the request rather than the frame", async () => {
    const ctx = await make();
    await ctx.core.acceptFrame(wrapped(`${marker("reply")}\nthe answer`, { alias: "spoofed", from: FROM }), ctx.peer);
    expect(ctx.calls).toHaveLength(1);
    const call = ctx.calls[0];
    expect(Object.keys(call).sort()).toEqual(["alias", "body", "evidence", "peer", "requestMessageId", "responseMessageId", "threadId", "verdict"]);
    expect(call).toMatchObject({ requestMessageId: messageId, responseMessageId: replyId, threadId, alias: "review", verdict: "pass", evidence: "application_ack" });
    expect(call.peer).toEqual({ pid: 99, procStart: "start" });
    expect(call.body).toBe(`${marker("reply")}\nthe answer`);
  });

  test("an ack carries a null verdict and the same shape", async () => {
    const ctx = await make();
    await ctx.core.acceptFrame(wrapped(`${marker("ack")}\nack body`), ctx.peer);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatchObject({ verdict: null, evidence: "application_ack", body: `${marker("ack")}\nack body` });
  });

  test("is not called when nothing correlates, and not called when the writer is the wrong process", async () => {
    const ctx = await make();
    expect(await ctx.core.acceptFrame(wrapped("not a marker at all"), ctx.peer)).toEqual({ reason: "no_reply_marker" });
    expect(await ctx.core.acceptFrame(wrapped(marker("reply", { replyTo: "10000000-0000-4000-8000-0000000000ff" })), ctx.peer)).toEqual({ reason: "unknown_reply_target" });
    expect(await ctx.core.acceptFrame(wrapped(marker("reply", { thread: "10000000-0000-4000-8000-0000000000fe" })), ctx.peer)).toEqual({ reason: "unknown_reply_target" });
    await expect(ctx.core.acceptFrame(wrapped(marker("reply")), { pid: 100, procStart: "start" })).rejects.toThrow("identity mismatch");
    expect(ctx.calls).toEqual([]);
    expect(ctx.store.events.some((event) => event.type === "peer_reply")).toBeFalse();
  });

  test("the body reaches the hook and never the ledger", async () => {
    const ctx = await make();
    const secret = "the-body-nobody-should-find-on-disk";
    await ctx.core.acceptFrame(wrapped(`${marker("reply")}\n${secret}`), ctx.peer);
    expect(ctx.calls[0].body).toContain(secret);
    expect(JSON.stringify(ctx.store.events)).not.toContain(secret);
    expect(await fsp.readFile(ctx.store.paths.events, "utf8")).not.toContain(secret);
  });

  test("a hook that throws leaves the reply recorded and says so on the ledger", async () => {
    const ctx = await make({ hook: () => { throw Object.assign(new Error("consumer failed"), { code: "RETURN_PATH_DOWN" }); } });
    expect(await ctx.core.acceptFrame(wrapped(marker("reply")), ctx.peer)).toBeNull();
    const types = ctx.store.events.map((event) => event.type);
    expect(types).toContain("peer_reply");
    expect(types).toContain("peer_reply_hook_failed");
    expect(ctx.store.events.at(-1)).toMatchObject({ messageId, alias: "review", errorCode: "RETURN_PATH_DOWN" });
  });

  test("a hook that is not a function is refused when the core is built", async () => {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-correlated-bad-")); roots.push(made); await fsp.chmod(made, 0o700);
    const root = await fsp.realpath(made); const store = new EventStore(statePaths(root)); await store.init();
    expect(() => new PeerCore({ targets: {}, store, address: "uds:/tmp/sender.sock", onCorrelatedReply: "yes please" })).toThrow("onCorrelatedReply");
  });
});
