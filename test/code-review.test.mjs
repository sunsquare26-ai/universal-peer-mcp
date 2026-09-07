import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { canonicalSend, sha256 } from "../src/core/dedupe.mjs";
import { SENDER_PRODUCT_NAME, senderEnvelope } from "../src/adapters/claude-native-v1/protocol.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { CodeReviewExtension, MAX_ROUNDS, parseReceipt, publicLedgerEvent, requestBody } from "../src/extensions/code-review/index.mjs";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { validateSchema } from "../src/mcp/schema-validator.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

const fx = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HASH_A = "0f".repeat(32); const HASH_B = "1e".repeat(32);
const CORE_TOOLS = ["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status"];
const MILESTONE_TOOLS = ["milestone_status", "milestone_list", "milestone_wait", "milestone_recover_ack"];
const CODE_REVIEW_TOOLS = ["code_review_status", "code_review_list", "code_review_wait", "code_review_request"];

async function make({ failAt = [], withOther = false, ledger = null } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-code-review-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  if (ledger !== null) await fsp.writeFile(statePaths(root).events, ledger, { mode: 0o600 });
  const store = new EventStore(statePaths(root)); await store.init(); const socketPath = "/tmp/fake-code-review.sock";
  const target = { sessionId: fx(900), cwd: root, permissionMode: "prompting", expectedDisplayName: null }; const other = { sessionId: fx(901), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: 77, procStart: "start", socketPath, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const otherResolved = { ...other, pid: 78, procStart: "other-start", socketPath: "/tmp/fake-other.sock", token: "2".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const wires = []; const unavailable = new Set();
  const core = new PeerCore({ targets: withOther ? { reviewer: target, other } : { reviewer: target }, store, address: "uds:/tmp/sender.sock", resolver: async (expected) => { if (unavailable.has(expected.sessionId)) throw new Error("synthetic unavailable"); return expected.sessionId === other.sessionId ? otherResolved : resolved; }, sender: async (_target, frames) => { wires.push(frames); if (failAt.includes(wires.length)) throw new Error("synthetic failure"); return { bytesWritten: 42 }; } });
  const review = new CodeReviewExtension({ store, core }); const peer = { pid: 77, procStart: "start" };
  const args = { alias: "reviewer", reviewId: fx(101), requestMessageId: fx(102), threadId: fx(103), targetKind: "implementation", artifactHash: HASH_A, scope: ["src/example/index.mjs"], nonGoals: [], evidence: [{ command: "bun test", summary: "1 pass, 0 fail" }] };
  return { root, store, core, review, wires, peer, socketPath, args, unavailable, other: { alias: "other", peer: { pid: 78, procStart: "other-start" }, socketPath: otherResolved.socketPath } };
}
function receiptPayload(overrides = {}) { return { review_id: fx(101), verdict: "pass", review_thread_id: "thread-1", rounds: 2, reviewed_at: "2026-09-03T00:00:00Z", artifact_hash: HASH_A, mandatory_changes: [], unresolved: [], ...overrides }; }
function receiptContent({ messageId = fx(104), threadId = fx(103), replyTo = fx(102), payload = receiptPayload() } = {}) { return `CODE_REVIEW_RECEIPT v=1 message_id=${messageId} thread_id=${threadId} reply_to=${replyTo}\n${JSON.stringify(payload)}`; }
function frameOf(ctx, content, msgId = fx(700)) { return { type: "user", msg_id: msgId, from: `uds:${ctx.socketPath}`, message: { content } }; }
async function deliver(ctx, frame, peer = ctx.peer) { await ctx.core.acceptFrame(frame, peer); return ctx.review.observeFrame(frame, peer); }
async function statusFrame(ctx, transportId, status, overrides = {}) { const frame = { type: "control", action: "peer_message_status", orig_msg_id: transportId, status, from: `uds:${ctx.socketPath}`, ...overrides }; await ctx.core.acceptFrame(frame, ctx.peer); await ctx.review.observeFrame(frame, ctx.peer); }
const types = (ctx) => ctx.store.events.map((event) => event.type);

describe("code-review extension", () => {
  test("fsyncs requested, core reservation, and reserved before the wire and binds the request body to the artifact hash", async () => {
    const ctx = await make(); const result = await ctx.review.request(ctx.args); const order = types(ctx);
    expect(order.indexOf("code_review_requested")).toBeLessThan(order.indexOf("send_requested")); expect(order.indexOf("send_requested")).toBeLessThan(order.indexOf("code_review_request_send_reserved")); expect(order.indexOf("code_review_request_send_reserved")).toBeLessThan(order.indexOf("socket_write_complete"));
    expect(result).toMatchObject({ found: true, replay: false, passed: false, state: "awaiting_receipt", stale: false, receipt: null, review: { reviewId: fx(101), round: 1, requestMessageId: fx(102), threadId: fx(103), alias: "reviewer", targetKind: "implementation", artifactHash: HASH_A }, request: { messageId: fx(102), transportMessageId: fx(102), delivery: "written" } });
    expect(result.history).toEqual([{ round: 1, requestMessageId: fx(102), artifactHash: HASH_A, verdict: null, receiptMessageId: null, stale: false }]);
    const [, userFrame] = ctx.wires[0]; const [marker, json] = userFrame.message.content.split("\n").slice(1, 3);
    expect(marker).toBe(`CODE_REVIEW_REQUEST v=1 message_id=${fx(102)} thread_id=${fx(103)} review_id=${fx(101)} round=1 artifact_hash=${HASH_A}`);
    expect(json).toBe(`{"artifact_hash":"${HASH_A}","evidence":[{"command":"bun test","summary":"1 pass, 0 fail"}],"non_goals":[],"review_id":"${fx(101)}","scope":["src/example/index.mjs"],"target_kind":"implementation"}`);
    const requested = ctx.store.events.find((event) => event.type === "code_review_requested"); expect(requested.payloadHash).toBe(sha256(json)); expect(requestBody(requested)).toBe(`${marker}\n${json}`);
    expect(ctx.store.request(fx(102))).toMatchObject({ kind: "code_review_request", targetPid: 77, targetSocketPath: ctx.socketPath });
    const reserved = ctx.store.events.find((event) => event.type === "code_review_request_send_reserved"); expect(reserved).toMatchObject({ reviewId: fx(101), round: 1, transportMessageId: fx(102), artifactHash: HASH_A, targetPid: 77, targetProcStart: "start", targetSocketPath: ctx.socketPath });
  });

  test("replays the same request without a second wire and rejects reuse with different content, foreign messages, and unknown targets", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); const replay = await ctx.review.request({ ...ctx.args, reviewId: fx(101).toUpperCase() }); expect(replay.replay).toBeTrue(); expect(ctx.wires).toHaveLength(1);
    const before = ctx.store.events.length;
    await expect(ctx.review.request({ ...ctx.args, scope: ["src/other.mjs"] })).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
    await expect(ctx.review.request({ ...ctx.args, threadId: fx(303) })).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
    await ctx.core.send({ alias: "reviewer", messageId: fx(120), threadId: fx(103), kind: "work", body: "plain" });
    await expect(ctx.review.request({ ...ctx.args, requestMessageId: fx(120) })).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
    await expect(ctx.review.request({ ...ctx.args, requestMessageId: fx(121), alias: "missing" })).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
    expect(ctx.store.events.filter((event) => event.type.startsWith("code_review_"))).toHaveLength(2); expect(ctx.store.events.length - before).toBe(2); expect(ctx.wires).toHaveLength(2);
  });

  test("accepts a hash-bound pass receipt only from the exact peer identity", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); const content = receiptContent();
    for (const [peer, from] of [[ctx.peer, "uds:/tmp/wrong.sock"], [{ pid: 78, procStart: "start" }, `uds:${ctx.socketPath}`], [{ pid: 77, procStart: "other" }, `uds:${ctx.socketPath}`]]) await expect(ctx.review.observeFrame({ ...frameOf(ctx, content), from }, peer)).rejects.toThrow("identity mismatch");
    expect(ctx.store.events.some((event) => event.type === "code_review_receipt_accepted")).toBeFalse();
    const accepted = await deliver(ctx, frameOf(ctx, content)); expect(accepted).toMatchObject({ type: "code_review_receipt_accepted", reviewId: fx(101), round: 1, requestMessageId: fx(102), receiptMessageId: fx(104), receiptVerdict: "pass", artifactHash: HASH_A, reviewThreadId: "thread-1", rounds: 2, peerPid: 77, peerProcStart: "start", sourceAddress: `uds:${ctx.socketPath}` });
    const view = ctx.review.status({ reviewId: fx(101) }); expect(view).toMatchObject({ found: true, passed: true, state: "passed", stale: false, receipt: { receiptMessageId: fx(104), verdict: "pass", reviewThreadId: "thread-1", rounds: 2, reviewedAt: "2026-09-03T00:00:00Z", artifactHash: HASH_A } });
    expect(view.history).toEqual([{ round: 1, requestMessageId: fx(102), artifactHash: HASH_A, verdict: "pass", receiptMessageId: fx(104), stale: false }]);
    expect(ctx.review.status({ requestMessageId: fx(102) })).toEqual(view); expect(() => ctx.review.status({})).toThrow("exactly one"); expect(() => ctx.review.status({ reviewId: fx(101), requestMessageId: fx(102) })).toThrow("exactly one");
    expect(ctx.core.events({ messageId: fx(102) }).events.some((event) => event.type === "peer_reply")).toBeFalse();
  });

  test("hash mismatch: rejects a receipt whose artifact hash differs from the request, records the rejection, and never passes", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args);
    await expect(deliver(ctx, frameOf(ctx, receiptContent({ payload: receiptPayload({ artifact_hash: HASH_B }) })))).rejects.toMatchObject({ code: "CODE_REVIEW_HASH_MISMATCH" });
    const rejected = ctx.store.events.find((event) => event.type === "code_review_receipt_rejected"); expect(rejected).toMatchObject({ reviewId: fx(101), round: 1, requestMessageId: fx(102), incomingReceiptMessageId: fx(104), artifactHash: HASH_A, incomingArtifactHash: HASH_B, receiptVerdict: "pass", reason: "artifact_hash_mismatch" });
    const view = ctx.review.status({ reviewId: fx(101) }); expect(view).toMatchObject({ passed: false, state: "awaiting_receipt", receipt: null, lastEvent: { type: "code_review_receipt_rejected", reason: "artifact_hash_mismatch", incomingArtifactHash: HASH_B } }); expect(view.history[0].verdict).toBeNull();
    for (const key of ["peerPid", "peerProcStart", "sourceAddress", "targetPid"]) expect(JSON.stringify(view)).not.toContain(key);
    await deliver(ctx, frameOf(ctx, receiptContent({ messageId: fx(105) }))); expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: true, state: "passed", receipt: { receiptMessageId: fx(105), artifactHash: HASH_A } });
  });

  test("stale PASS: a new round for a changed artifact supersedes an earlier pass and late receipts for old rounds stay superseded", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); await deliver(ctx, frameOf(ctx, receiptContent())); expect(ctx.review.status({ reviewId: fx(101) }).passed).toBeTrue();
    const second = await ctx.review.request({ ...ctx.args, requestMessageId: fx(112), threadId: fx(113), artifactHash: HASH_B });
    expect(second).toMatchObject({ passed: false, state: "awaiting_receipt", stale: false, review: { round: 2, artifactHash: HASH_B }, receipt: null });
    expect(second.history).toEqual([{ round: 1, requestMessageId: fx(102), artifactHash: HASH_A, verdict: "pass", receiptMessageId: fx(104), stale: true }, { round: 2, requestMessageId: fx(112), artifactHash: HASH_B, verdict: null, receiptMessageId: null, stale: false }]);
    expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: false, state: "awaiting_receipt", review: { round: 2 } });
    expect(ctx.review.status({ requestMessageId: fx(102) })).toMatchObject({ passed: false, state: "superseded", stale: true, receipt: { verdict: "pass", artifactHash: HASH_A } });
    await expect(deliver(ctx, frameOf(ctx, receiptContent({ messageId: fx(114), threadId: fx(113), replyTo: fx(112), payload: receiptPayload({ artifact_hash: HASH_A }) })))).rejects.toMatchObject({ code: "CODE_REVIEW_HASH_MISMATCH" });
    expect(ctx.review.status({ reviewId: fx(101) }).passed).toBeFalse();
    await deliver(ctx, frameOf(ctx, receiptContent({ messageId: fx(115), threadId: fx(113), replyTo: fx(112), payload: receiptPayload({ artifact_hash: HASH_B, rounds: 3 }) })));
    expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: true, state: "passed", review: { round: 2, artifactHash: HASH_B }, receipt: { receiptMessageId: fx(115), artifactHash: HASH_B } });
    const late = await make(); await late.review.request(late.args); await late.review.request({ ...late.args, requestMessageId: fx(112), artifactHash: HASH_B });
    await deliver(late, frameOf(late, receiptContent())); expect(late.review.status({ requestMessageId: fx(102) })).toMatchObject({ passed: false, state: "superseded", stale: true, receipt: { verdict: "pass" } });
    expect(late.review.status({ reviewId: fx(101) })).toMatchObject({ passed: false, state: "awaiting_receipt", review: { round: 2 } }); expect(late.review.list({}).rounds.map((round) => round.state)).toEqual(["superseded", "awaiting_receipt"]);
  });

  test("unresolved: a pass cannot carry unresolved items or mandatory changes while a fail receipt records them without passing", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); const unresolved = [{ topic: "ledger key", message: "reviewer and author disagree" }]; const mandatory = [{ location: "src/example/index.mjs:12", message: "reject an empty scope" }];
    expect(parseReceipt(receiptContent({ payload: receiptPayload({ unresolved }) }))).toBeNull(); expect(parseReceipt(receiptContent({ payload: receiptPayload({ mandatory_changes: mandatory }) }))).toBeNull();
    const before = ctx.store.events.length; await expect(deliver(ctx, frameOf(ctx, receiptContent({ payload: receiptPayload({ unresolved }) })))).rejects.toThrow("invalid code review receipt"); expect(ctx.store.events).toHaveLength(before);
    await deliver(ctx, frameOf(ctx, receiptContent({ payload: receiptPayload({ verdict: "fail", unresolved, mandatory_changes: mandatory }) })));
    const view = ctx.review.status({ reviewId: fx(101) }); expect(view).toMatchObject({ passed: false, state: "failed", receipt: { verdict: "fail", payload: { verdict: "fail", unresolved, mandatory_changes: mandatory } } }); expect(view.history[0].verdict).toBe("fail");
    const bare = await make(); await bare.review.request(bare.args); await deliver(bare, frameOf(bare, receiptContent({ payload: receiptPayload({ verdict: "fail" }) }))); expect(bare.review.status({ reviewId: fx(101) })).toMatchObject({ passed: false, state: "failed" });
  });

  test("round bounds: rounds are sequential, capped per review, and receipt rounds are bounded", async () => {
    const ctx = await make();
    for (let index = 0; index < MAX_ROUNDS; index += 1) { const view = await ctx.review.request({ ...ctx.args, requestMessageId: fx(200 + index), artifactHash: index % 2 ? HASH_B : HASH_A }); expect(view.review.round).toBe(index + 1); }
    expect(ctx.review.status({ reviewId: fx(101) }).history.map((entry) => entry.round)).toEqual(Array.from({ length: MAX_ROUNDS }, (_, index) => index + 1));
    const before = ctx.store.events.length; await expect(ctx.review.request({ ...ctx.args, requestMessageId: fx(299) })).rejects.toMatchObject({ code: "CODE_REVIEW_ROUND_LIMIT" }); expect(ctx.store.events).toHaveLength(before); expect(ctx.wires).toHaveLength(MAX_ROUNDS);
    expect(ctx.review.status({ requestMessageId: fx(299) }).found).toBeFalse(); expect(ctx.review.list({ reviewId: fx(101) }).rounds).toHaveLength(MAX_ROUNDS);
    for (const rounds of [0, MAX_ROUNDS + 1, 1.5, "3", -1, null]) expect(parseReceipt(receiptContent({ payload: receiptPayload({ rounds }) }))).toBeNull();
    for (const rounds of [1, MAX_ROUNDS]) expect(parseReceipt(receiptContent({ payload: receiptPayload({ rounds }) }))?.payload.rounds).toBe(rounds);
  });

  test("schema bounds: rejects malformed request arguments before any ledger write and malformed receipts before acceptance", async () => {
    const ctx = await make(); const long = "x".repeat(257); const wide = "가".repeat(100); const item = (n) => Array.from({ length: n }, (_, index) => `item-${index}`);
    const oversized = { scope: Array.from({ length: 32 }, () => "s".repeat(256)), nonGoals: Array.from({ length: 32 }, () => "n".repeat(256)), evidence: Array.from({ length: 16 }, () => ({ command: "c".repeat(512), summary: "r".repeat(1024) })) };
    for (const args of [
      { ...ctx.args, scope: [] }, { ...ctx.args, scope: item(33) }, { ...ctx.args, scope: [long] }, { ...ctx.args, scope: [wide] }, { ...ctx.args, scope: ["bad\nline"] }, { ...ctx.args, scope: [""] }, { ...ctx.args, scope: "src" },
      { ...ctx.args, nonGoals: item(33) }, { ...ctx.args, evidence: Array.from({ length: 17 }, () => ctx.args.evidence[0]) }, { ...ctx.args, evidence: [{ command: "bun test" }] }, { ...ctx.args, evidence: [{ ...ctx.args.evidence[0], extra: 1 }] }, { ...ctx.args, evidence: [{ command: "c".repeat(513), summary: "ok" }] },
      { ...ctx.args, artifactHash: HASH_A.toUpperCase() }, { ...ctx.args, artifactHash: HASH_A.slice(1) }, { ...ctx.args, targetKind: "other" }, { ...ctx.args, reviewId: "not-a-uuid" }, { ...ctx.args, alias: "Reviewer" }, { ...ctx.args, extra: true }, (({ nonGoals, ...rest }) => rest)(ctx.args), { ...ctx.args, ...oversized }, null, [], "text"
    ]) await expect(ctx.review.request(args)).rejects.toMatchObject({ code: "CODE_REVIEW_INVALID_ARGUMENTS" });
    expect(ctx.store.events).toHaveLength(0); expect(ctx.wires).toHaveLength(0);
    const bigList = (key, value) => ({ [key]: Array.from({ length: 32 }, () => value) });
    for (const payload of [
      { ...receiptPayload(), extra: 1 }, (({ unresolved, ...rest }) => rest)(receiptPayload()), receiptPayload({ verdict: "PASS" }), receiptPayload({ verdict: "unknown" }), receiptPayload({ review_thread_id: "" }), receiptPayload({ review_thread_id: "has space" }), receiptPayload({ review_thread_id: "t".repeat(129) }), receiptPayload({ review_thread_id: "-lead" }),
      receiptPayload({ reviewed_at: "2026-09-03T00:00:00" }), receiptPayload({ reviewed_at: "yesterday" }), receiptPayload({ artifact_hash: HASH_A.toUpperCase() }), receiptPayload({ artifact_hash: undefined }), receiptPayload({ review_id: "not-a-uuid" }),
      receiptPayload({ verdict: "fail", mandatory_changes: Array.from({ length: 33 }, () => ({ location: "a", message: "b" })) }), receiptPayload({ verdict: "fail", mandatory_changes: [{ location: long, message: "b" }] }), receiptPayload({ verdict: "fail", mandatory_changes: [{ location: "a", message: "b\u0007" }] }), receiptPayload({ verdict: "fail", unresolved: [{ topic: "a", message: "b", extra: 1 }] }), receiptPayload({ verdict: "fail", unresolved: [{ topic: "a" }] }), receiptPayload({ verdict: "fail", unresolved: "none" }),
      receiptPayload({ verdict: "fail", ...bigList("mandatory_changes", { location: "l".repeat(256), message: "m".repeat(1024) }), ...bigList("unresolved", { topic: "t".repeat(256), message: "m".repeat(1024) }) })
    ]) expect(parseReceipt(receiptContent({ payload }))).toBeNull();
    expect(parseReceipt(receiptContent().replace("v=1", "v=2"))).toBeNull(); expect(parseReceipt(receiptContent().split("\n")[0])).toBeNull(); expect(parseReceipt(`${receiptContent().split("\n")[0]}\nnot json`)).toBeNull(); expect(parseReceipt(`${receiptContent()}`.replace(fx(104), "not-a-uuid"))).toBeNull();
    const parsed = parseReceipt(receiptContent({ messageId: fx(104).toUpperCase(), payload: { ...receiptPayload({ verdict: "fail", unresolved: [{ topic: "t", message: "m" }] }), review_id: fx(101).toUpperCase() } }));
    expect(parsed).toMatchObject({ messageId: fx(104), threadId: fx(103), replyTo: fx(102), payload: { review_id: fx(101), verdict: "fail", unresolved: [{ topic: "t", message: "m" }] } }); expect(Object.keys(parsed.payload)).toEqual(["review_id", "verdict", "review_thread_id", "rounds", "reviewed_at", "artifact_hash", "mandatory_changes", "unresolved"]);
    expect(parsed.canonicalPayload).toBe(`{"artifact_hash":"${HASH_A}","mandatory_changes":[],"review_id":"${fx(101)}","review_thread_id":"thread-1","reviewed_at":"2026-09-03T00:00:00Z","rounds":2,"unresolved":[{"message":"m","topic":"t"}],"verdict":"fail"}`);
  });

  test("dedupes an identical receipt and isolates conflicting receipts from the accepted one", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); await deliver(ctx, frameOf(ctx, receiptContent()));
    const duplicate = await deliver(ctx, frameOf(ctx, receiptContent(), fx(701))); expect(duplicate).toMatchObject({ type: "code_review_receipt_duplicate", receiptMessageId: fx(104), transportMessageId: fx(701) });
    await expect(deliver(ctx, frameOf(ctx, receiptContent({ payload: receiptPayload({ rounds: 3 }) }), fx(702)))).rejects.toThrow("conflicts with a recorded receipt");
    await expect(deliver(ctx, frameOf(ctx, receiptContent({ messageId: fx(106) }), fx(703)))).rejects.toThrow("already has a recorded receipt");
    const conflicts = ctx.store.events.filter((event) => event.type === "code_review_receipt_conflict"); expect(conflicts).toHaveLength(2); expect(conflicts.map((event) => event.incomingReceiptMessageId)).toEqual([fx(104), fx(106)]); expect(conflicts.every((event) => event.existingReceiptMessageId === fx(104))).toBeTrue();
    expect(ctx.store.events.filter((event) => event.type === "code_review_receipt_accepted")).toHaveLength(1); expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: true, receipt: { receiptMessageId: fx(104), rounds: 2 } });
  });

  test("correlation: rejects receipts for unknown requests, wrong threads, wrong review ids, unreserved rounds, and snapshot-less history without writing", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); const before = ctx.store.events.length;
    for (const content of [receiptContent({ replyTo: fx(999) }), receiptContent({ threadId: fx(998) }), receiptContent({ payload: receiptPayload({ review_id: fx(555) }) })]) await expect(deliver(ctx, frameOf(ctx, content))).rejects.toThrow("not bound");
    await ctx.store.append("code_review_requested", { reviewId: fx(141), round: 1, requestMessageId: fx(122), threadId: fx(103), targetAlias: "reviewer", targetKind: "design", artifactHash: HASH_A, payloadHash: "a".repeat(64), payload: {} });
    await expect(deliver(ctx, frameOf(ctx, receiptContent({ replyTo: fx(122), payload: receiptPayload({ review_id: fx(141) }) })))).rejects.toThrow("not bound");
    const legacyArgs = { alias: "reviewer", messageId: fx(130), threadId: fx(103), kind: "code_review_request", body: "old" };
    await ctx.store.append("send_requested", { messageId: fx(130), threadId: fx(103), alias: "reviewer", requestHash: sha256(canonicalSend(legacyArgs)), subscriptionId: fx(131), targetPid: 77, targetProcStart: "start" });
    await ctx.store.append("code_review_requested", { reviewId: fx(142), round: 1, requestMessageId: fx(130), threadId: fx(103), targetAlias: "reviewer", targetKind: "design", artifactHash: HASH_A, payloadHash: "a".repeat(64), payload: {} });
    await expect(deliver(ctx, frameOf(ctx, receiptContent({ replyTo: fx(130), payload: receiptPayload({ review_id: fx(142) }) })))).rejects.toThrow("identity snapshot");
    expect(ctx.store.events.length - before).toBe(3); expect(ctx.store.events.some((event) => event.type === "code_review_receipt_accepted")).toBeFalse();
  });

  // The envelope the shipped sender writes is the envelope the shipped receiver takes apart, and
  // the two changed together when the mode attributes came off. A wrapper that still declares a
  // mode is a shape this build cannot check, so the payload inside it is not read at all rather
  // than read with its header ignored.
  test("unwraps a receipt from the envelope this package writes and refuses one that declares a mode", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); const from = `uds:${ctx.socketPath}`;
    const wrapped = senderEnvelope({ from, body: receiptContent() });
    expect(wrapped.startsWith(`<cross-session-message from="${from}" from-name="${SENDER_PRODUCT_NAME}">\n`)).toBeTrue();
    await deliver(ctx, frameOf(ctx, wrapped));
    expect(ctx.store.events.some((event) => event.type === "code_review_receipt_accepted")).toBeTrue();
    const settled = ctx.store.events.length;
    for (const stranger of [
      `<cross-session-message from="${from}" from-name="Claude MCP" from-mode="prompting">\n${receiptContent({ messageId: fx(105) })}\n</cross-session-message>`,
      `<cross-session-message from="${from}" from-name="Claude MCP" from-mode="prompting" from-mode-verified-by="kern_procargs2">\n${receiptContent({ messageId: fx(106) })}\n</cross-session-message>`
    ]) await deliver(ctx, frameOf(ctx, stranger, fx(701)));
    expect(ctx.store.events.length).toBe(settled);
  });

  test("preserves plain P1 evidence and ignores control frames and unrelated messages", async () => {
    const ctx = await make(); const args = { alias: "reviewer", messageId: fx(150), threadId: fx(103), kind: "work", body: "plain" }; const sent = await ctx.core.send(args); expect((await ctx.core.send(args)).replay).toBeTrue();
    const before = ctx.store.events.length;
    for (const frame of [{ type: "control", action: "peer_message_status", orig_msg_id: fx(150), status: "delivered", from: `uds:${ctx.socketPath}` }, { type: "control", action: "peer_idle_notice", orig_msg_id: sent.subscriptionId, state: "idle", from: `uds:${ctx.socketPath}` }, frameOf(ctx, `PEER_REPLY v=1 message_id=${fx(151)} thread_id=${fx(103)} reply_to=${fx(150)} verdict=pass`), frameOf(ctx, "free text reply"), frameOf(ctx, `<cross-session-message from="uds:/tmp/other.sock" from-name="x" from-mode="prompting">\n${receiptContent()}\n</cross-session-message>`)]) await deliver(ctx, frame);
    expect(ctx.store.events.slice(before).map((event) => event.type)).toEqual(["peer_message_status", "peer_idle_notice", "peer_reply"]);
    expect((await ctx.core.wait({ messageId: fx(150), require: "delivery", timeoutMs: 50 })).event.transportMessageId).toBe(fx(150)); expect(ctx.core.events({ messageId: fx(150) }).events.some((event) => event.subscriptionId === sent.subscriptionId)).toBeTrue();
    expect(ctx.review.status({ requestMessageId: fx(150) }).found).toBeFalse();
  });

  test("public views omit identity, permission proof, sockets, and absolute paths and use code_review_ event names", async () => {
    const ctx = await make(); const absolutePath = ["", "private", "build.log"].join("/");
    await ctx.review.request({ ...ctx.args, scope: [`path:${absolutePath},[/var/run/confidential.txt]`, "src/relative.mjs"], evidence: [{ command: `cat ${absolutePath}`, summary: "seen at /opt/private.log" }] });
    await deliver(ctx, frameOf(ctx, receiptContent({ payload: receiptPayload({ verdict: "fail", mandatory_changes: [{ location: `${absolutePath}:3`, message: `inspect=${absolutePath}` }], unresolved: [{ topic: "socket", message: "see /var/run/hidden.txt" }] }) })));
    const outputs = [ctx.review.status({ reviewId: fx(101) }), ctx.review.list({}), await ctx.review.wait({ afterSeq: 0, reviewId: fx(101), timeoutMs: 10 })]; const bytes = JSON.stringify(outputs);
    for (const value of [ctx.socketPath, absolutePath, "/var/run/confidential.txt", "/opt/private.log", "/var/run/hidden.txt", "targetPid", "targetProcStart", "targetCwd", "targetPermission", "kern_procargs2", "peerPid", "peerProcStart", "sourceAddress", "targetSocketPath", "targetSessionId"]) expect(bytes).not.toContain(value);
    expect(bytes).toContain("[path]"); expect(bytes).toContain("src/relative.mjs");
    expect(ctx.store.events.filter((event) => event.reviewId === fx(101)).every((event) => event.type.startsWith("code_review_"))).toBeTrue();
    expect(outputs[2].events.every((event) => event.type.startsWith("code_review_"))).toBeTrue(); expect(outputs[2].events.map((event) => event.type)).toEqual(["code_review_requested", "code_review_request_send_reserved", "code_review_receipt_accepted"]);
  });

  test("wait reconnects from a cursor, reports the bound round, and times out without side effects", async () => {
    const ctx = await make(); const cursor = ctx.store.events.at(-1)?.seq ?? 0;
    const pending = ctx.review.wait({ afterSeq: cursor, reviewId: fx(101), timeoutMs: 1000 }); await ctx.review.request(ctx.args); const waited = await pending;
    expect(waited.events[0]).toMatchObject({ type: "code_review_requested", reviewId: fx(101), round: 1 }); expect(waited.review).toMatchObject({ state: "awaiting_receipt" }); expect(waited.timedOut).toBeUndefined();
    expect(waited.cursor).toBeLessThan(ctx.store.events.at(-1).seq); const settled = ctx.store.events.at(-1).seq;
    const receiptPending = ctx.review.wait({ afterSeq: settled, requestMessageId: fx(102), timeoutMs: 1000 }); await deliver(ctx, frameOf(ctx, receiptContent())); const received = await receiptPending;
    expect(received.events.map((event) => event.type)).toEqual(["code_review_receipt_accepted"]); expect(received.review).toMatchObject({ passed: true, state: "passed" });
    const before = ctx.store.events.length; expect(await ctx.review.wait({ afterSeq: received.cursor, timeoutMs: 20 })).toEqual({ cursor: received.cursor, events: [], review: null, timedOut: true }); expect(ctx.store.events).toHaveLength(before);
    await expect(ctx.review.wait({ afterSeq: -1 })).rejects.toThrow("afterSeq"); expect(() => ctx.review.list({ afterSeq: 1.5 })).toThrow("afterSeq");
  });

  test("a crashed request without a core reservation is sent on the explicit replay and a failed wire is never retried", async () => {
    const ctx = await make(); const crashed = { ...ctx.args, reviewId: fx(141), requestMessageId: fx(140) };
    await ctx.store.append("code_review_requested", { reviewId: fx(141), round: 1, requestMessageId: fx(140), threadId: fx(103), targetAlias: "reviewer", targetKind: "implementation", artifactHash: HASH_A, payloadHash: sha256(`{"artifact_hash":"${HASH_A}","evidence":[{"command":"bun test","summary":"1 pass, 0 fail"}],"non_goals":[],"review_id":"${fx(141)}","scope":["src/example/index.mjs"],"target_kind":"implementation"}`), payload: { review_id: fx(141), target_kind: "implementation", artifact_hash: HASH_A, scope: ["src/example/index.mjs"], non_goals: [], evidence: [{ command: "bun test", summary: "1 pass, 0 fail" }] } });
    expect(ctx.review.status({ reviewId: fx(141) })).toMatchObject({ state: "awaiting_receipt", request: { delivery: "unsent", transportMessageId: null } });
    const sent = await ctx.review.request(crashed); expect(sent).toMatchObject({ replay: false, review: { round: 1 }, request: { delivery: "written", transportMessageId: fx(140) } }); expect(ctx.wires).toHaveLength(1);
    expect((await ctx.review.request(crashed)).replay).toBeTrue(); expect(ctx.wires).toHaveLength(1); expect(ctx.store.events.filter((event) => event.type === "code_review_requested")).toHaveLength(1); expect(ctx.store.events.some((event) => event.type === "send_recovery_reserved")).toBeFalse();
    const failing = await make({ failAt: [1] }); await expect(failing.review.request(failing.args)).rejects.toMatchObject({ code: "DELIVERY_UNCERTAIN" });
    expect(failing.review.status({ reviewId: fx(101) })).toMatchObject({ state: "awaiting_receipt", request: { delivery: "failed", transportMessageId: fx(102) } });
    expect(await failing.review.request(failing.args)).toMatchObject({ replay: true, request: { delivery: "failed" } }); expect(failing.wires).toHaveLength(1);
    const next = await failing.review.request({ ...failing.args, requestMessageId: fx(112) }); expect(next).toMatchObject({ review: { round: 2 }, request: { delivery: "written" } }); expect(failing.wires).toHaveLength(2); expect(failing.store.events.some((event) => event.type === "send_recovery_reserved")).toBeFalse();
  });

  test("delivery evidence: only the exact delivered status marks the request delivered while held, idle, wrong transport, wrong socket, and terminal never do", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); const delivery = () => ctx.review.status({ reviewId: fx(101) }).request.delivery;
    await statusFrame(ctx, fx(102), "held"); expect(delivery()).toBe("written");
    const idle = { type: "control", action: "peer_idle_notice", orig_msg_id: ctx.store.request(fx(102)).subscriptionId, state: "idle", from: `uds:${ctx.socketPath}` }; await deliver(ctx, idle); expect(delivery()).toBe("written");
    await statusFrame(ctx, fx(998), "delivered"); expect(delivery()).toBe("written");
    await statusFrame(ctx, fx(102), "delivered", { from: "uds:/tmp/not-the-target.sock" }); expect(delivery()).toBe("written");
    await statusFrame(ctx, fx(102), "delivered"); expect(delivery()).toBe("delivered");
    const terminal = await make(); await terminal.review.request(terminal.args); await statusFrame(terminal, fx(102), "denied"); expect(terminal.review.status({ reviewId: fx(101) })).toMatchObject({ state: "awaiting_receipt", request: { delivery: "terminal" } });
  });

  test("neutral fixture round-trips: the fixture request binds the fixture pass receipt and carries no private values", async () => {
    const request = JSON.parse(await fsp.readFile(new URL("../fixtures/code-review/request.json", import.meta.url), "utf8")); const receipt = JSON.parse(await fsp.readFile(new URL("../fixtures/code-review/receipt.json", import.meta.url), "utf8"));
    const text = [JSON.stringify(request), JSON.stringify(receipt)].join("\n"); expect(text).not.toContain(["", "Users"].join("/") + "/"); expect(text).not.toContain("cc-socks"); expect(text.toLowerCase()).not.toContain("token"); expect(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi).every((id) => /^10000000-0000-4000-8000-0000000001\d\d$/.test(id))).toBeTrue();
    const ctx = await make(); const sent = await ctx.review.request(request); expect(sent).toMatchObject({ replay: false, review: { reviewId: request.reviewId, round: 1, artifactHash: request.artifactHash, payload: { scope: request.scope, non_goals: request.nonGoals, evidence: request.evidence } }, request: { delivery: "written" } });
    const content = `CODE_REVIEW_RECEIPT v=1 message_id=${receipt.message_id} thread_id=${receipt.thread_id} reply_to=${receipt.reply_to}\n${JSON.stringify(receipt.payload)}`;
    await deliver(ctx, frameOf(ctx, content)); expect(ctx.review.status({ reviewId: request.reviewId })).toMatchObject({ passed: true, state: "passed", receipt: { receiptMessageId: receipt.message_id, verdict: "pass", reviewThreadId: receipt.payload.review_thread_id, rounds: 3, artifactHash: request.artifactHash } });
    await expect(deliver(ctx, frameOf(ctx, content.replace(request.artifactHash, HASH_B), fx(710)))).rejects.toMatchObject({ code: "CODE_REVIEW_HASH_MISMATCH" });
  });

  test("hash-bound verdicts: core event listing never carries a code review verdict and the code review contract refuses a verdict without its artifact hash", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); await deliver(ctx, frameOf(ctx, receiptContent())); expect(ctx.review.status({ reviewId: fx(101) }).passed).toBeTrue();
    const coreCall = async (name, args) => name === "peer_list_events" ? ctx.core.events(args) : ctx.core.wait(args);
    for (const options of [{}, { extensions: ["code-review"] }, { extensions: ["code-review", "milestone"], admin: true }]) {
      const modern = await createFacade({ tools: toolDefinitions(["reviewer"], options), callTool: coreCall }).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "peer_list_events", arguments: {} } });
      const legacyFacade = createFacade({ tools: toolDefinitions(["reviewer"], options), callTool: coreCall }); await legacyFacade.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const legacy = await legacyFacade.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "peer_list_events", arguments: {} } });
      for (const response of [modern, legacy]) {
        expect(response.result.isError).toBeUndefined(); const events = response.result.structuredContent.events; expect(events.map((event) => event.type)).toEqual(types(ctx));
        expect(events.filter((event) => Object.hasOwn(event, "verdict") && event.artifactHash === undefined)).toEqual([]);
        expect(events.filter((event) => event.type.startsWith("code_review_") && Object.hasOwn(event, "verdict"))).toEqual([]);
      }
    }
    const ledger = ctx.store.events.filter((event) => event.type.startsWith("code_review_")); expect(ledger.every((event) => event.verdict === undefined)).toBeTrue(); expect(ledger.filter((event) => event.receiptVerdict === "pass").map((event) => event.artifactHash)).toEqual([HASH_A]);
    const reviewFacade = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async (name, args) => name === "code_review_status" ? ctx.review.status(args) : ctx.review.wait({ ...args, timeoutMs: 20 }) });
    const status = await reviewFacade.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "code_review_status", arguments: { reviewId: fx(101) } } });
    const waited = await reviewFacade.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta(), name: "code_review_wait", arguments: { afterSeq: 0, reviewId: fx(101) } } });
    expect(status.result.structuredContent.lastEvent).toMatchObject({ type: "code_review_receipt_accepted", verdict: "pass", artifactHash: HASH_A, reviewId: fx(101), requestMessageId: fx(102), receiptMessageId: fx(104) });
    const verdicts = waited.result.structuredContent.events.filter((event) => Object.hasOwn(event, "verdict")); expect(verdicts).toHaveLength(1); expect(verdicts[0]).toMatchObject({ type: "code_review_receipt_accepted", verdict: "pass", artifactHash: HASH_A, reviewId: fx(101), requestMessageId: fx(102) });
    const eventSchema = toolDefinitions([], { extensions: ["code-review"] }).find((tool) => tool.name === "code_review_wait").outputSchema.properties.events.items;
    const bare = { seq: 3, type: "code_review_receipt_accepted", at: "2026-09-03T00:00:01Z", reviewId: fx(101), round: 1, requestMessageId: fx(102), receiptMessageId: fx(104), verdict: "pass" };
    expect(validateSchema(eventSchema, bare).valid).toBeFalse(); expect(validateSchema(eventSchema, { ...bare, verdict: "fail" }).valid).toBeFalse(); expect(validateSchema(eventSchema, { ...bare, artifactHash: HASH_A }).valid).toBeTrue(); expect(validateSchema(eventSchema, (({ verdict, ...rest }) => rest)(bare)).valid).toBeTrue();
    const leaking = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async () => ({ ...ctx.review.status({ reviewId: fx(101) }), lastEvent: bare }) });
    const refused = await leaking.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: modernMeta(), name: "code_review_status", arguments: { reviewId: fx(101) } } });
    expect(refused.result.isError).toBeTrue(); expect(refused.result.structuredContent).toEqual({ reason: "invalid_public_result" }); expect(JSON.stringify(refused)).not.toContain("pass");
  });

  test("foreign reservation: a receipt binds only to the reservation its request recorded, so another send's identity cannot pass the review and the replay reports a conflict", async () => {
    const ctx = await make({ withOther: true }); ctx.unavailable.add(fx(900));
    await expect(ctx.review.request(ctx.args)).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" }); expect(types(ctx)).toEqual(["code_review_requested"]);
    await ctx.core.send({ alias: "other", messageId: fx(102), threadId: fx(103), kind: "work", body: "plain" }); expect(ctx.store.request(fx(102))).toMatchObject({ targetAlias: "other", targetPid: 78, targetSocketPath: ctx.other.socketPath }); expect(ctx.wires).toHaveLength(1);
    const foreign = { type: "user", msg_id: fx(700), from: `uds:${ctx.other.socketPath}`, message: { content: receiptContent() } }; await ctx.core.acceptFrame(foreign, ctx.other.peer);
    await expect(ctx.review.observeFrame(foreign, ctx.other.peer)).rejects.toMatchObject({ code: "CODE_REVIEW_IDENTITY_MISMATCH" });
    await expect(ctx.review.observeFrame(frameOf(ctx, receiptContent(), fx(701)), ctx.peer)).rejects.toMatchObject({ code: "CODE_REVIEW_IDENTITY_MISMATCH" });
    expect(ctx.store.events.some((event) => event.type === "code_review_receipt_accepted")).toBeFalse();
    expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: false, state: "awaiting_receipt", review: { alias: "reviewer" }, request: { delivery: "unsent", transportMessageId: null, subscriptionId: null } });
    ctx.unavailable.delete(fx(900)); await expect(ctx.review.request(ctx.args)).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" }); expect(ctx.wires).toHaveLength(1); expect(ctx.store.events.some((event) => event.type === "code_review_request_send_reserved")).toBeFalse();
    const next = await ctx.review.request({ ...ctx.args, requestMessageId: fx(112) }); expect(next).toMatchObject({ replay: false, review: { round: 2, alias: "reviewer" }, request: { delivery: "written", transportMessageId: fx(112) } }); expect(ctx.wires).toHaveLength(2);
    await deliver(ctx, frameOf(ctx, receiptContent({ messageId: fx(114), replyTo: fx(112) }), fx(702))); expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: true, state: "passed", review: { round: 2 }, receipt: { receiptMessageId: fx(114), artifactHash: HASH_A } });
    const canonical = `{"artifact_hash":"${HASH_A}","evidence":[{"command":"bun test","summary":"1 pass, 0 fail"}],"non_goals":[],"review_id":"${fx(101)}","scope":["src/example/index.mjs"],"target_kind":"implementation"}`;
    const unrecorded = await make(); const round = { reviewId: fx(101), round: 1, requestMessageId: fx(102), threadId: fx(103), targetAlias: "reviewer", targetKind: "implementation", artifactHash: HASH_A, payloadHash: sha256(canonical), payload: JSON.parse(canonical) };
    await unrecorded.core.send({ alias: "reviewer", messageId: fx(102), threadId: fx(103), kind: "code_review_request", body: requestBody(round) }); await unrecorded.store.append("code_review_requested", round);
    await expect(deliver(unrecorded, frameOf(unrecorded, receiptContent()))).rejects.toMatchObject({ code: "CODE_REVIEW_IDENTITY_MISMATCH" }); expect(unrecorded.review.status({ reviewId: fx(101) })).toMatchObject({ passed: false, request: { delivery: "unsent", transportMessageId: null } });
    await expect(unrecorded.review.request(unrecorded.args)).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" }); expect(unrecorded.wires).toHaveLength(1); expect(unrecorded.store.events.some((event) => event.type === "code_review_receipt_accepted")).toBeFalse();
  });

  test("legacy ledger replay: a receipt the first writer recorded under `verdict` restores the same PASS, replays and dedupes without a second wire, and is never rewritten", async () => {
    const source = await make(); await source.review.request(source.args); await deliver(source, frameOf(source, receiptContent())); const expected = source.review.status({ reviewId: fx(101) }); expect(expected).toMatchObject({ passed: true, state: "passed" });
    const written = await fsp.readFile(statePaths(source.root).events, "utf8"); const legacy = written.replaceAll('"receiptVerdict":', '"verdict":');
    expect(legacy).not.toBe(written); expect(legacy).not.toContain("receiptVerdict"); expect(legacy.split("\n").find((line) => line.includes('"code_review_receipt_accepted"'))).toContain('"verdict":"pass"');
    const ctx = await make({ ledger: legacy }); const accepted = ctx.store.events.find((event) => event.type === "code_review_receipt_accepted"); expect(accepted).toMatchObject({ verdict: "pass", artifactHash: HASH_A }); expect(accepted.receiptVerdict).toBeUndefined();
    expect(ctx.review.status({ reviewId: fx(101) })).toEqual(expected); expect(ctx.review.status({ requestMessageId: fx(102) })).toEqual(expected); expect(ctx.review.list({})).toEqual(source.review.list({}));
    expect(await ctx.review.wait({ afterSeq: 0, reviewId: fx(101), timeoutMs: 10 })).toEqual(await source.review.wait({ afterSeq: 0, reviewId: fx(101), timeoutMs: 10 }));
    expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: true, state: "passed", receipt: { receiptMessageId: fx(104), verdict: "pass", artifactHash: HASH_A, payload: { verdict: "pass" } }, history: [{ round: 1, artifactHash: HASH_A, verdict: "pass", receiptMessageId: fx(104), stale: false }], lastEvent: { type: "code_review_receipt_accepted", verdict: "pass", artifactHash: HASH_A, receiptMessageId: fx(104) }, request: { delivery: "written", transportMessageId: fx(102) } });
    expect((await ctx.review.request(ctx.args)).replay).toBeTrue(); expect(ctx.wires).toHaveLength(0);
    const facade = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async (name, args) => name === "code_review_status" ? ctx.review.status(args) : name === "code_review_list" ? ctx.review.list(args) : name === "code_review_request" ? ctx.review.request(args) : ctx.review.wait({ ...args, timeoutMs: 20 }) });
    const call = (id, name, args) => facade.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: modernMeta(), name, arguments: args } });
    const responses = [await call(1, "code_review_status", { reviewId: fx(101) }), await call(2, "code_review_list", {}), await call(3, "code_review_wait", { afterSeq: 0, reviewId: fx(101) }), await call(4, "code_review_request", ctx.args)];
    for (const response of responses) expect(response.result.isError).toBeUndefined();
    expect(responses[0].result.structuredContent).toMatchObject({ passed: true, state: "passed", receipt: { verdict: "pass", artifactHash: HASH_A }, lastEvent: { type: "code_review_receipt_accepted", verdict: "pass", artifactHash: HASH_A } });
    expect(responses[1].result.structuredContent.rounds.map((round) => round.state)).toEqual(["passed"]);
    expect(responses[2].result.structuredContent.events.filter((event) => Object.hasOwn(event, "verdict"))).toEqual([expect.objectContaining({ type: "code_review_receipt_accepted", verdict: "pass", artifactHash: HASH_A })]);
    expect(responses[3].result.structuredContent).toMatchObject({ replay: true, passed: true, state: "passed" });
    expect((await deliver(ctx, frameOf(ctx, receiptContent(), fx(701)))).type).toBe("code_review_receipt_duplicate"); expect(ctx.review.status({ reviewId: fx(101) })).toMatchObject({ passed: true, state: "passed", receipt: { receiptMessageId: fx(104) } }); expect(ctx.wires).toHaveLength(0);
    expect(ctx.store.events.find((event) => event.type === "code_review_receipt_accepted")).toBe(accepted); expect(accepted.verdict).toBe("pass"); expect(accepted.receiptVerdict).toBeUndefined(); expect(await fsp.readFile(statePaths(ctx.root).events, "utf8")).toContain('"verdict":"pass"');
  });

  test("legacy ledger listing: the core event listing the daemon returns never carries a code review verdict — extension off and on, modern and legacy — while the ledger keeps its old key untouched", async () => {
    const source = await make(); await source.review.request(source.args); await deliver(source, frameOf(source, receiptContent()));
    const ctx = await make({ ledger: (await fsp.readFile(statePaths(source.root).events, "utf8")).replaceAll('"receiptVerdict":', '"verdict":') });
    const accepted = ctx.store.events.find((event) => event.type === "code_review_receipt_accepted"); expect(accepted).toMatchObject({ verdict: "pass", artifactHash: HASH_A });
    const listing = (args) => { const listed = ctx.core.events(args); return { ...listed, events: listed.events.map(publicLedgerEvent) }; };
    const raw = listing({}); expect(raw.cursor).toBe(ctx.store.events.at(-1).seq); expect(raw.events.map((event) => event.seq)).toEqual(ctx.store.events.map((event) => event.seq));
    expect(raw.events.filter((event) => event.type.startsWith("code_review_") && (Object.hasOwn(event, "verdict") || Object.hasOwn(event, "receiptVerdict")))).toEqual([]);
    expect(raw.events.find((event) => event.type === "code_review_receipt_accepted")).toMatchObject({ seq: accepted.seq, receiptMessageId: fx(104), artifactHash: HASH_A });
    expect(raw.events.filter((event) => !event.type.startsWith("code_review_"))).toEqual(ctx.store.events.filter((event) => !event.type.startsWith("code_review_")));
    for (const options of [{}, { extensions: ["code-review"] }]) {
      const modern = await createFacade({ tools: toolDefinitions(["reviewer"], options), callTool: async (_name, args) => listing(args) }).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "peer_list_events", arguments: {} } });
      const legacyFacade = createFacade({ tools: toolDefinitions(["reviewer"], options), callTool: async (_name, args) => listing(args) }); await legacyFacade.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const legacy = await legacyFacade.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "peer_list_events", arguments: {} } });
      for (const response of [modern, legacy]) {
        expect(response.result.isError).toBeUndefined(); const events = response.result.structuredContent.events; expect(events.map((event) => event.type)).toEqual(types(ctx));
        expect(events.filter((event) => Object.hasOwn(event, "verdict") && event.artifactHash === undefined)).toEqual([]);
        expect(events.filter((event) => event.type.startsWith("code_review_") && Object.hasOwn(event, "verdict"))).toEqual([]);
        expect(events.find((event) => event.type === "code_review_receipt_accepted")).toEqual({ seq: accepted.seq, type: "code_review_receipt_accepted", at: accepted.at, threadId: fx(103) });
      }
    }
    expect(ctx.core.events({ messageId: fx(102) }).events.every((event) => !event.type.startsWith("code_review_"))).toBeTrue();
    expect(ctx.store.events.find((event) => event.type === "code_review_receipt_accepted")).toBe(accepted); expect(accepted.verdict).toBe("pass"); expect(await fsp.readFile(statePaths(ctx.root).events, "utf8")).toContain('"verdict":"pass"');
  });
});

describe("code-review MCP contract", () => {
  test("advertises code-review tools in fixed order only when the daemon enables them and keeps the extension enum bound to known names", () => {
    expect(toolDefinitions([]).map((tool) => tool.name)).toEqual(CORE_TOOLS);
    expect(toolDefinitions([], { extensions: ["code-review"] }).map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...CODE_REVIEW_TOOLS]);
    expect(toolDefinitions([], { extensions: ["code-review", "milestone"], admin: true }).map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...MILESTONE_TOOLS, ...CODE_REVIEW_TOOLS, "daemon_shutdown"]);
    expect(toolDefinitions([], { requestedExtensions: ["code-review"] }).map((tool) => tool.name)).toEqual(CORE_TOOLS);
    const daemonSchema = (options) => toolDefinitions([], options).find((tool) => tool.name === "daemon_status").outputSchema;
    expect(daemonSchema({ extensions: ["milestone"] }).properties.enabledExtensions.items.enum).toEqual(["milestone"]); expect(daemonSchema({ requestedExtensions: ["milestone"] }).properties.enabledExtensions.items.enum).toEqual(["milestone"]);
    expect(daemonSchema({ extensions: ["code-review"], requestedExtensions: ["milestone"] }).properties.requestedExtensions.items.enum).toEqual(["code-review", "milestone"]); expect(daemonSchema({}).properties.enabledExtensions).toBeUndefined();
    expect(validateSchema(daemonSchema({ extensions: ["code-review", "milestone"] }), { running: true, pid: 4, procStart: "s", admin: false, eventSeq: 0, targetCount: 0, enabledExtensions: ["code-review", "milestone"], requestedExtensions: [], extensionMismatch: true }).valid).toBeTrue();
    expect(validateSchema(daemonSchema({ extensions: ["milestone"] }), { running: true, pid: 4, procStart: "s", admin: false, eventSeq: 0, targetCount: 0, enabledExtensions: ["code-review"] }).valid).toBeFalse();
  });

  test("enforces code-review input schemas before dispatch and projects only public view fields", async () => {
    let calls = 0; const raw = { found: true, passed: true, state: "passed", stale: false, cursor: 5, replay: false, review: { reviewId: fx(101), round: 1, requestMessageId: fx(102), threadId: fx(103), alias: "reviewer", targetKind: "implementation", artifactHash: HASH_A, payloadHash: "b".repeat(64), payload: { review_id: fx(101), target_kind: "implementation", artifact_hash: HASH_A, scope: ["src/a.mjs"], non_goals: [], evidence: [] }, targetPid: 7, targetSocketPath: "/private.sock" }, request: { messageId: fx(102), transportMessageId: fx(102), subscriptionId: fx(109), delivery: "delivered", targetProcStart: "private" }, receipt: { receiptMessageId: fx(104), verdict: "pass", reviewThreadId: "thread-1", rounds: 2, reviewedAt: "2026-09-03T00:00:00Z", artifactHash: HASH_A, payloadHash: "c".repeat(64), payload: receiptPayload(), peerPid: 7, sourceAddress: "uds:/private.sock" }, history: [{ round: 1, requestMessageId: fx(102), artifactHash: HASH_A, verdict: "pass", receiptMessageId: fx(104), stale: false, targetPid: 7 }], lastEvent: { seq: 5, type: "code_review_receipt_accepted", at: "2026-09-03T00:00:01Z", reviewId: fx(101), round: 1, requestMessageId: fx(102), receiptMessageId: fx(104), artifactHash: HASH_A, verdict: "pass", peerPid: 7 } };
    const facade = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async () => { calls += 1; return raw; } }); const meta = modernMeta(); const good = { alias: "reviewer", reviewId: fx(101), requestMessageId: fx(102), threadId: fx(103), targetKind: "implementation", artifactHash: HASH_A, scope: ["src/a.mjs"], nonGoals: [], evidence: [] };
    const invalid = [
      { name: "code_review_request", arguments: { ...good, scope: [] } }, { name: "code_review_request", arguments: { ...good, scope: Array.from({ length: 33 }, () => "s") } }, { name: "code_review_request", arguments: { ...good, scope: ["s".repeat(257)] } }, { name: "code_review_request", arguments: { ...good, targetKind: "other" } },
      { name: "code_review_request", arguments: { ...good, artifactHash: "abc" } }, { name: "code_review_request", arguments: { ...good, extra: true } }, { name: "code_review_request", arguments: (({ nonGoals, ...rest }) => rest)(good) }, { name: "code_review_request", arguments: { ...good, alias: "missing" } }, { name: "code_review_request", arguments: { ...good, evidence: [{ command: "c" }] } }, { name: "code_review_request", arguments: { ...good, evidence: Array.from({ length: 17 }, () => ({ command: "c", summary: "s" })) } },
      { name: "code_review_status", arguments: { extra: true } }, { name: "code_review_status", arguments: { reviewId: "x" } }, { name: "code_review_list", arguments: { afterSeq: -1 } }, { name: "code_review_wait", arguments: { timeoutMs: 0 } }, { name: "code_review_wait", arguments: { timeoutMs: 300001 } }
    ];
    for (let index = 0; index < invalid.length; index += 1) expect((await facade.handle({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { _meta: meta, ...invalid[index] } })).error.code).toBe(-32602);
    expect(calls).toBe(0);
    const response = await facade.handle({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { _meta: meta, name: "code_review_request", arguments: good } }); expect(calls).toBe(1); expect(response.result.isError).toBeUndefined();
    expect(response.result.structuredContent).toEqual({ found: true, passed: true, state: "passed", stale: false, cursor: 5, replay: false, review: { reviewId: fx(101), round: 1, requestMessageId: fx(102), threadId: fx(103), alias: "reviewer", targetKind: "implementation", artifactHash: HASH_A, payloadHash: "b".repeat(64), payload: raw.review.payload }, request: { messageId: fx(102), transportMessageId: fx(102), subscriptionId: fx(109), delivery: "delivered" }, receipt: { receiptMessageId: fx(104), verdict: "pass", reviewThreadId: "thread-1", rounds: 2, reviewedAt: "2026-09-03T00:00:00Z", artifactHash: HASH_A, payloadHash: "c".repeat(64), payload: receiptPayload() }, history: [{ round: 1, requestMessageId: fx(102), artifactHash: HASH_A, verdict: "pass", receiptMessageId: fx(104), stale: false }], lastEvent: { seq: 5, type: "code_review_receipt_accepted", at: "2026-09-03T00:00:01Z", reviewId: fx(101), round: 1, requestMessageId: fx(102), receiptMessageId: fx(104), artifactHash: HASH_A, verdict: "pass" } });
    const bytes = JSON.stringify(response); for (const value of ["targetPid", "targetSocketPath", "private.sock", "targetProcStart", "peerPid", "sourceAddress"]) expect(bytes).not.toContain(value);
    const missing = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async () => ({ found: false, passed: false, state: "not_found", cursor: 0 }) });
    expect((await missing.handle({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { _meta: meta, name: "code_review_status", arguments: { reviewId: fx(199) } } })).result.structuredContent).toEqual({ found: false, passed: false, state: "not_found", cursor: 0 });
    const failing = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async () => { const error = new Error(`hash mismatch at ${os.homedir()}/private`); error.code = "CODE_REVIEW_HASH_MISMATCH"; throw error; } });
    const failed = await failing.handle({ jsonrpc: "2.0", id: 101, method: "tools/call", params: { _meta: meta, name: "code_review_request", arguments: good } }); expect(failed.result.isError).toBeTrue(); expect(failed.result.structuredContent).toEqual({ reason: "internal_failure" }); expect(JSON.stringify(failed)).not.toContain(os.homedir());
    const hidden = await createFacade({ tools: toolDefinitions(["reviewer"]), callTool: async () => { calls += 1; return raw; } }).handle({ jsonrpc: "2.0", id: 102, method: "tools/call", params: { _meta: meta, name: "code_review_status", arguments: { reviewId: fx(101) } } }); expect(hidden.error.code).toBe(-32602); expect(calls).toBe(1);
  });

  test("projects real extension views produced by the ledger through the facade", async () => {
    const ctx = await make(); await ctx.review.request(ctx.args); await deliver(ctx, frameOf(ctx, receiptContent()));
    const facade = createFacade({ tools: toolDefinitions(["reviewer"], { extensions: ["code-review"] }), callTool: async (name, args) => name === "code_review_status" ? ctx.review.status(args) : name === "code_review_list" ? ctx.review.list(args) : ctx.review.wait({ ...args, timeoutMs: 20 }) });
    const call = (id, name, args) => facade.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: modernMeta(), name, arguments: args } });
    const status = await call(1, "code_review_status", { reviewId: fx(101) }); const list = await call(2, "code_review_list", {}); const wait = await call(3, "code_review_wait", { afterSeq: 0, reviewId: fx(101) }); const timedOut = await call(4, "code_review_wait", { afterSeq: 999 });
    for (const response of [status, list, wait, timedOut]) expect(response.result.isError).toBeUndefined();
    expect(status.result.structuredContent).toMatchObject({ passed: true, state: "passed", review: { round: 1 }, receipt: { verdict: "pass" }, request: { delivery: "written" } }); expect(list.result.structuredContent.rounds).toHaveLength(1); expect(wait.result.structuredContent.events.map((event) => event.type)).toEqual(["code_review_requested", "code_review_request_send_reserved", "code_review_receipt_accepted"]); expect(timedOut.result.structuredContent).toEqual({ cursor: ctx.store.events.at(-1).seq, events: [], review: null, timedOut: true });
    const bytes = JSON.stringify([status, list, wait]); for (const value of [ctx.socketPath, "targetPid", "targetProcStart", "peerPid", "peerProcStart", "sourceAddress", "kern_procargs2", ctx.root]) expect(bytes).not.toContain(value);
  });
});
