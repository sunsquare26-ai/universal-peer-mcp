// Three values this package writes to its own ledger that its own public contract refuses to
// read back. None of them comes from a caller's arguments, so no caller can avoid one, and two of
// them land on rows that the read tools reach by message id — where there is no cursor to skip
// past and the tool stays dead for that id.
//
//   (a) `peer_idle_notice` checked `frame.status` against a closed list on the branch above it and
//       wrote `frame.state` without looking at it. The contract says `state` is a string.
//   (b) a code review receipt recorded `transportMessageId: frame.msg_id ?? null`, and the
//       projection's allowlist drops `undefined` and passes `null`. The contract says uuid. The
//       sibling fields on the same event are declared nullable and this one is not, which is what
//       says the null was never intended.
//   (c) the receiver's oversize refusal did not pass an ordinal, so it recorded the counter's
//       value — 0 when the oversize frame is the first on the connection. Every other refusal in
//       that loop passes the ordinal of the frame it refused, which is 1 or more.
//
// (c) is not visible over MCP today: the public event contract carries no ordinal at all
// (docs/known-issues.md §4), so the value is projected away before validation. It is fixed
// because 0 names no frame — the ledger is where that diagnostic is read.
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { startReceiver } from "../src/adapters/claude-native-v1/receiver.mjs";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { CodeReviewExtension, publicLedgerEvent } from "../src/extensions/code-review/index.mjs";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";

const roots = []; const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

const fx = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HASH_A = "0f".repeat(32);
const SOCKET = "/tmp/fake-public-contract.sock";

async function wired() {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-public-contract-")); roots.push(made); await fsp.chmod(made, 0o700);
  const root = await fsp.realpath(made);
  const store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: fx(900), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: 77, procStart: "start", socketPath: SOCKET, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const core = new PeerCore({ targets: { reviewer: target }, store, address: "uds:/tmp/sender.sock", resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 }) });
  const review = new CodeReviewExtension({ store, core });
  return { root, store, core, review, peer: { pid: 77, procStart: "start" } };
}

// The two read paths, spoken the way the daemon speaks them: the same projection, the same
// validation, the same published failure.
function facadeFor(tools, callTool) { return createFacade({ tools, callTool }); }
async function call(facade, name, args = {}) {
  const response = await facade.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name, arguments: args } });
  return response.result;
}

describe("(a) an idle notice carries a state the contract can read", () => {
  test("a non-string state is refused and nothing is written", async () => {
    const ctx = await wired();
    await ctx.core.send({ alias: "reviewer", messageId: fx(102), threadId: fx(103), kind: "question", body: "hello" });
    const subscriptionId = ctx.store.request(fx(102)).subscriptionId;
    const before = ctx.store.events.length;
    for (const state of [{ turn: "ended" }, ["idle"], 7, null, undefined, true]) {
      await expect(ctx.core.acceptFrame({ type: "control", action: "peer_idle_notice", orig_msg_id: subscriptionId, state }, ctx.peer)).rejects.toThrow("invalid state");
    }
    expect(ctx.store.events.length).toBe(before);
    await ctx.core.acceptFrame({ type: "control", action: "peer_idle_notice", orig_msg_id: subscriptionId, state: "idle" }, ctx.peer);
    expect(ctx.store.events.at(-1)).toMatchObject({ type: "peer_idle_notice", state: "idle", evidence: "idle_notice" });
  });

  test("what it would have done to the reader", async () => {
    const ctx = await wired();
    await ctx.store.append("peer_idle_notice", { messageId: fx(102), subscriptionId: fx(104), state: { turn: "ended" }, evidence: "idle_notice" });
    const tools = toolDefinitions(["reviewer"], {});
    const facade = facadeFor(tools, async (_name, args) => { const listing = ctx.core.events(args); return { ...listing, events: listing.events.map(publicLedgerEvent) }; });
    expect(await call(facade, "peer_list_events", {})).toMatchObject({ isError: true, structuredContent: { reason: "invalid_public_result" } });
  });
});

describe("(b) a code review receipt records a transport id or none", () => {
  async function receipt(ctx, frameOverrides) {
    await ctx.review.request({ alias: "reviewer", reviewId: fx(101), requestMessageId: fx(102), threadId: fx(103), targetKind: "implementation", artifactHash: HASH_A, scope: ["src/a.mjs"], nonGoals: [], evidence: [{ command: "bun test", summary: "1 pass" }] });
    const payload = { review_id: fx(101), verdict: "pass", review_thread_id: "thread-1", rounds: 1, reviewed_at: "2026-09-07T00:00:00Z", artifact_hash: HASH_A, mandatory_changes: [], unresolved: [] };
    const content = `CODE_REVIEW_RECEIPT v=1 message_id=${fx(104)} thread_id=${fx(103)} reply_to=${fx(102)}\n${JSON.stringify(payload)}`;
    return ctx.review.observeFrame({ type: "user", from: `uds:${SOCKET}`, message: { content }, ...frameOverrides }, ctx.peer);
  }

  test("a frame with no transport id records no transport id, and the reader still answers", async () => {
    const ctx = await wired();
    const accepted = await receipt(ctx, {});
    expect("transportMessageId" in accepted).toBeFalse();
    const tools = toolDefinitions(["reviewer"], { extensions: ["code-review"] });
    const facade = facadeFor(tools, async (_name, args) => ctx.review.status(args));
    const result = await call(facade, "code_review_status", { requestMessageId: fx(102) });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ found: true, passed: true, state: "passed" });
  });

  test("a transport id that is not a uuid is not recorded as one", async () => {
    const ctx = await wired();
    const accepted = await receipt(ctx, { msg_id: "not-a-uuid" });
    expect("transportMessageId" in accepted).toBeFalse();
  });

  test("a transport id that is one is recorded", async () => {
    const ctx = await wired();
    const msgId = crypto.randomUUID();
    const accepted = await receipt(ctx, { msg_id: msgId });
    expect(accepted.transportMessageId).toBe(msgId);
  });
});

describe("(c) a refusal names the frame it refused", () => {
  test("an oversize first frame is refused under ordinal 1, not 0", async () => {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-oversize-")); roots.push(made); await fsp.chmod(made, 0o700);
    const root = await fsp.realpath(made);
    const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets");
    await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
    const refusals = [];
    const receiver = await startReceiver(() => {}, {
      sessionsDir, socketDir,
      peerIdentityReader: () => ({ pid: process.pid, uid: process.getuid(), procStart: processStart() }),
      onFrameRefused: async (refusal) => { refusals.push(refusal); }
    });
    cleanups.push(() => receiver.close());
    const socket = net.createConnection({ path: receiver.address.slice("uds:".length) });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("x".repeat(1024 * 1024 + 64));
    const deadline = Date.now() + 5_000;
    while (refusals.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    socket.destroy();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ reason: "frame_too_large", connectionId: 1 });
    expect(refusals[0].frameOrdinal).toBeGreaterThanOrEqual(1);
  });
});
