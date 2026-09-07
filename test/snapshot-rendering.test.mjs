// Pinning how a start time is rendered fixes the values this build produces. It does not touch the
// ones already on disk. Every durable identity snapshot in the ledger — the send reservation, the
// milestone reservation, the code review reservation — holds a start time a previous build
// rendered, in the reader's local zone and in the reader's locale, and there is no way to tell by
// looking whether a given string is one of those or one of ours. Two strings that differ may name
// the same instant; two that match may not. So a snapshot now says which rendering it is, and one
// that does not say is not compared: it stops, with its own reason, in front of a person.
import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PROC_START_RENDERING } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { PeerCore, milestoneSendOptions } from "../src/core/peer-core.mjs";
import { canonicalSend, sha256 } from "../src/core/dedupe.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { MilestoneExtension } from "../src/extensions/milestone/index.mjs";
import { CodeReviewExtension, requestBody } from "../src/extensions/code-review/index.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

const fx = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HASH = "0f".repeat(32);
const SOCKET = "/tmp/fake-snapshot-rendering.sock";
// What a build that read `ps` through the reader's own zone wrote down. On this machine that is
// nine hours away from the instant it meant to name, and nothing in the string says so.
const OLD_START = "Mon Sep 8 01:43:02 2026";

async function make() {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-snapshot-rendering-")); roots.push(made);
  await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: fx(900), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: 77, procStart: "Mon Sep 7 16:43:02 2026", socketPath: SOCKET, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const wires = [];
  const core = new PeerCore({ targets: { worker: target, reviewer: target }, store, address: "uds:/tmp/sender.sock", resolver: async () => resolved, sender: async (_t, frames) => { wires.push(frames); return { bytesWritten: 42 }; } });
  const milestone = new MilestoneExtension({ store, core });
  const review = new CodeReviewExtension({ store, core });
  return { root, store, core, milestone, review, wires, oldPeer: { pid: 77, procStart: OLD_START } };
}
function unversioned(alias, cwd) {
  return { targetAlias: alias, targetSessionId: fx(900), targetCwd: cwd, targetSocketPath: SOCKET, targetPid: 77, targetProcStart: OLD_START, targetPermissionMode: "prompting", targetPermissionVerifiedBy: "kern_procargs2" };
}
const statusFrame = (origMsgId) => ({ type: "control", action: "peer_message_status", orig_msg_id: origMsgId, status: "delivered", from: `uds:${SOCKET}` });

describe("a snapshot says which rendering it holds", () => {
  test("every snapshot this build writes names its rendering", async () => {
    const ctx = await make();
    await ctx.core.send({ alias: "worker", messageId: fx(102), threadId: fx(103), kind: "work", body: "Do one bounded task." });
    expect(ctx.store.request(fx(102)).targetProcStartRendering).toBe(PROC_START_RENDERING);

    await ctx.review.request({ alias: "reviewer", reviewId: fx(201), requestMessageId: fx(202), threadId: fx(203), targetKind: "implementation", artifactHash: HASH, scope: ["src/example/index.mjs"], nonGoals: [], evidence: [] });
    const reserved = ctx.store.events.find((event) => event.type === "code_review_request_send_reserved");
    expect(reserved.targetProcStartRendering).toBe(PROC_START_RENDERING);
  });

  test("the milestone copy of a snapshot carries the rendering with it", async () => {
    const ctx = await make();
    const instructionId = fx(300); const threadId = fx(301); const completionMessageId = fx(302);
    await ctx.core.send({ alias: "worker", messageId: instructionId, threadId, kind: "work", body: "Do one bounded task." });
    const payload = { instruction_id: instructionId, attempt_id: fx(303), milestone_id: "M-1", files: ["src/example.mjs"], tests: [{ command: "bun test", scope: "milestone", pass: 7, fail: 0, skip: 0 }], blockers: [], last_signal_at: "2026-09-03T00:00:00Z" };
    const content = `MILESTONE_COMPLETED v=1 message_id=${completionMessageId} thread_id=${threadId} reply_to=${instructionId}\n${JSON.stringify(payload)}`;
    const frame = { type: "user", msg_id: fx(304), from: `uds:${SOCKET}`, message: { content } };
    const peer = { pid: 77, procStart: "Mon Sep 7 16:43:02 2026" };
    await ctx.core.acceptFrame(frame, peer); await ctx.milestone.observeFrame(frame, peer);
    const accepted = ctx.store.events.find((event) => event.type === "milestone_completion_accepted");
    expect(accepted.targetProcStartRendering).toBe(PROC_START_RENDERING);
    expect(ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved").targetProcStartRendering).toBe(PROC_START_RENDERING);
  });
});

describe("a snapshot that does not say is not compared", () => {
  // The silent one. On a machine that already ran in UTC the old rendering and the new one are the
  // same characters, so this delivery would be recorded as proven — a durable, terminal-adjacent
  // conclusion drawn from a string whose meaning this build cannot vouch for. It is not that the
  // comparison fails; it is that passing it means nothing.
  test("an inbound status against a pre-rendering request is refused, not recorded", async () => {
    const ctx = await make();
    await ctx.store.append("send_requested", { messageId: fx(102), transportMessageId: fx(102), threadId: fx(103), replyTo: null, kind: "work", alias: "worker", requestHash: "a".repeat(64), subscriptionId: fx(109), ...unversioned("worker", ctx.root) });
    await expect(ctx.core.acceptFrame(statusFrame(fx(102)), ctx.oldPeer)).rejects.toMatchObject({ code: "SNAPSHOT_RENDERING_UNVERSIONED", messageId: fx(102) });
    expect(ctx.store.events.some((event) => event.type === "peer_message_status")).toBeFalse();
  });

  test("a recovery that would reuse a pre-rendering snapshot is refused", async () => {
    const ctx = await make();
    const args = { alias: "worker", messageId: fx(110), threadId: fx(111), replyTo: null, kind: "work", body: "Do one bounded task." };
    await ctx.store.append("send_requested", { messageId: args.messageId, transportMessageId: args.messageId, threadId: args.threadId, replyTo: null, kind: args.kind, alias: args.alias, requestHash: sha256(canonicalSend(args)), subscriptionId: fx(112), ...unversioned("worker", ctx.root) });
    await expect(ctx.core.send(args, milestoneSendOptions({ recovery: true }))).rejects.toMatchObject({ code: "SNAPSHOT_RENDERING_UNVERSIONED" });
    expect(ctx.store.events.some((event) => event.type === "send_recovery_reserved")).toBeFalse();
    expect(ctx.wires).toHaveLength(0);
  });

  test("a milestone ACK status against a pre-rendering reservation is refused", async () => {
    const ctx = await make();
    const completionMessageId = fx(120); const ackMessageId = fx(121);
    await ctx.store.append("milestone_completion_accepted", { completionMessageId, attemptId: fx(122), milestoneId: "M-1", instructionId: fx(123), threadId: fx(124), payloadHash: "b".repeat(64), payload: {}, ...unversioned("worker", ctx.root) });
    await ctx.store.append("milestone_ack_send_reserved", { completionMessageId, attemptId: fx(122), ackMessageId, ackTransportMessageId: ackMessageId, ackSubscriptionId: fx(125), threadId: fx(124), payloadHash: "b".repeat(64), reason: "initial", ...unversioned("worker", ctx.root) });
    await expect(ctx.milestone.observeFrame(statusFrame(ackMessageId), ctx.oldPeer)).rejects.toMatchObject({ code: "MILESTONE_SNAPSHOT_RENDERING_UNVERSIONED" });
    expect(ctx.store.events.some((event) => event.type === "milestone_ack_delivered")).toBeFalse();
  });

  test("a code review receipt against a pre-rendering request is refused", async () => {
    const ctx = await make();
    const round = { reviewId: fx(130), round: 1, requestMessageId: fx(131), threadId: fx(132), targetAlias: "reviewer", targetKind: "implementation", artifactHash: HASH, payloadHash: sha256(`{"artifact_hash":"${HASH}","evidence":[],"non_goals":[],"review_id":"${fx(130)}","scope":["src/example/index.mjs"],"target_kind":"implementation"}`), payload: { review_id: fx(130), target_kind: "implementation", artifact_hash: HASH, scope: ["src/example/index.mjs"], non_goals: [], evidence: [] } };
    const args = { alias: "reviewer", messageId: round.requestMessageId, threadId: round.threadId, replyTo: null, kind: "code_review_request", body: requestBody(round) };
    await ctx.store.append("code_review_requested", round);
    await ctx.store.append("send_requested", { messageId: round.requestMessageId, transportMessageId: round.requestMessageId, threadId: round.threadId, replyTo: null, kind: "code_review_request", alias: "reviewer", requestHash: sha256(canonicalSend(args)), subscriptionId: fx(133), ...unversioned("reviewer", ctx.root) });
    await ctx.store.append("code_review_request_send_reserved", { reviewId: round.reviewId, round: 1, requestMessageId: round.requestMessageId, transportMessageId: round.requestMessageId, subscriptionId: fx(133), threadId: round.threadId, artifactHash: HASH, payloadHash: round.payloadHash, ...unversioned("reviewer", ctx.root) });
    const receipt = { review_id: fx(130), verdict: "pass", review_thread_id: "thread-1", rounds: 2, reviewed_at: "2026-09-03T00:00:00Z", artifact_hash: HASH, mandatory_changes: [], unresolved: [] };
    const content = `CODE_REVIEW_RECEIPT v=1 message_id=${fx(134)} thread_id=${round.threadId} reply_to=${round.requestMessageId}\n${JSON.stringify(receipt)}`;
    const frame = { type: "user", msg_id: fx(135), from: `uds:${SOCKET}`, message: { content } };
    await expect(ctx.review.observeFrame(frame, ctx.oldPeer)).rejects.toMatchObject({ code: "CODE_REVIEW_SNAPSHOT_RENDERING_UNVERSIONED" });
    expect(ctx.store.events.some((event) => event.type === "code_review_receipt_accepted")).toBeFalse();
  });
});
