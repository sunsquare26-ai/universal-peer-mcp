import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore, milestoneSendOptions } from "../src/core/peer-core.mjs";
import { canonicalSend, sha256 } from "../src/core/dedupe.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { MilestoneExtension, parseCompletion } from "../src/extensions/milestone/index.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

async function make({ failAt = [] } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-milestone-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const store = new EventStore(statePaths(root)); await store.init(); const sessionId = crypto.randomUUID(); const socketPath = "/tmp/fake-milestone.sock";
  const target = { sessionId, cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: 77, procStart: "start", socketPath, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const wires = [];
  const core = new PeerCore({ targets: { worker: target }, store, address: "uds:/tmp/sender.sock", resolver: async () => resolved, sender: async (_target, frames) => { wires.push(frames); if (failAt.includes(wires.length)) throw new Error("synthetic failure"); return { bytesWritten: 42 }; } });
  const milestone = new MilestoneExtension({ store, core });
  const instructionId = crypto.randomUUID(); const threadId = crypto.randomUUID(); const attemptId = crypto.randomUUID(); const completionMessageId = crypto.randomUUID();
  await core.send({ alias: "worker", messageId: instructionId, threadId, kind: "work", body: "Do one bounded task." });
  const payload = { instruction_id: instructionId, attempt_id: attemptId, milestone_id: "M-1", files: ["src/example.mjs"], tests: [{ command: "bun test", scope: "milestone", pass: 7, fail: 0, skip: 0 }], blockers: [], last_signal_at: "2026-09-03T00:00:00Z" };
  const content = `MILESTONE_COMPLETED v=1 message_id=${completionMessageId} thread_id=${threadId} reply_to=${instructionId}\n${JSON.stringify(payload)}`;
  const frame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${socketPath}`, message: { content } }; const peer = { pid: 77, procStart: "start" };
  return { root, store, core, milestone, wires, instructionId, threadId, attemptId, completionMessageId, payload, frame, peer, socketPath };
}

async function acceptCompletion(ctx) { await ctx.core.acceptFrame(ctx.frame, ctx.peer); return ctx.milestone.observeFrame(ctx.frame, ctx.peer); }
async function acceptStatus(ctx, transportId, status = "delivered", overrides = {}) { const frame = { type: "control", action: "peer_message_status", orig_msg_id: transportId, status, from: `uds:${ctx.socketPath}`, ...overrides }; await ctx.core.acceptFrame(frame, ctx.peer); await ctx.milestone.observeFrame(frame, ctx.peer); }
async function recordAccepted(ctx) {
  const marker = parseCompletion(ctx.frame.message.content); const request = ctx.store.request(ctx.instructionId); const payloadHash = sha256(marker.canonicalPayload);
  const event = await ctx.store.append("milestone_completion_accepted", {
    completionMessageId: ctx.completionMessageId, attemptId: ctx.attemptId, milestoneId: ctx.payload.milestone_id,
    instructionId: ctx.instructionId, threadId: ctx.threadId, payloadHash, payload: ctx.payload,
    targetAlias: request.targetAlias, targetSessionId: request.targetSessionId, targetCwd: request.targetCwd,
    targetSocketPath: request.targetSocketPath, targetPid: request.targetPid, targetProcStart: request.targetProcStart,
    targetPermissionMode: request.targetPermissionMode, targetPermissionVerifiedBy: request.targetPermissionVerifiedBy
  });
  return event;
}

describe("milestone extension", () => {
  test("strictly parses the completion schema and instruction correlation field", async () => { const ctx = await make(); expect(parseCompletion(ctx.frame.message.content)?.payload.instruction_id).toBe(ctx.instructionId); expect(parseCompletion(ctx.frame.message.content.replace('"files"', '"extra"'))).toBeNull(); });

  test("fsyncs accepted, prepared, and reserved before the ACK wire and completes only on exact delivered evidence", async () => {
    const ctx = await make(); await acceptCompletion(ctx); const types = ctx.store.events.map((event) => event.type); const accepted = types.indexOf("milestone_completion_accepted"); const prepared = types.indexOf("milestone_ack_prepared"); const reserved = types.indexOf("milestone_ack_send_reserved"); const write = types.lastIndexOf("socket_write_complete");
    expect(accepted).toBeLessThan(prepared); expect(prepared).toBeLessThan(reserved); expect(reserved).toBeLessThan(write); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse();
    const attempt = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved"); expect(attempt.ackTransportMessageId).toBe(attempt.ackMessageId);
    await acceptStatus(ctx, attempt.ackTransportMessageId); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId })).toMatchObject({ complete: true, state: "ack_delivered" });
  });

  test("delivered closes after a failed wire and missing write-complete while idle, exited, and held never close", async () => {
    const ctx = await make({ failAt: [2] }); await expect(acceptCompletion(ctx)).rejects.toThrow("delivery is uncertain"); const attempt = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved"); expect(ctx.store.events.some((event) => event.type === "socket_write_complete" && event.messageId === attempt.ackMessageId)).toBeFalse();
    for (const state of ["idle", "exited"]) { const idle = { type: "control", action: "peer_idle_notice", orig_msg_id: attempt.ackSubscriptionId, state, from: `uds:${ctx.socketPath}` }; await ctx.core.acceptFrame(idle, ctx.peer); await ctx.milestone.observeFrame(idle, ctx.peer); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse(); }
    await acceptStatus(ctx, attempt.ackTransportMessageId, "held"); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse();
    await acceptStatus(ctx, attempt.ackTransportMessageId); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeTrue();
  });

  test("reconciles delivered evidence written before socket completion or a daemon restart", async () => {
    const ctx = await make();
    ctx.core.sender = async (_target, frames) => {
      ctx.wires.push(frames);
      if (ctx.wires.length === 2) {
        const reserved = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved");
        await ctx.core.acceptFrame({ type: "control", action: "peer_message_status", orig_msg_id: reserved.ackTransportMessageId, status: "delivered", from: `uds:${ctx.socketPath}` }, ctx.peer);
      }
      return { bytesWritten: 42 };
    };
    await acceptCompletion(ctx);
    const coreDelivered = ctx.store.events.findIndex((event) => event.type === "peer_message_status" && event.status === "delivered");
    const writeComplete = ctx.store.events.findIndex((event) => event.type === "socket_write_complete" && event.messageId !== ctx.instructionId);
    expect(coreDelivered).toBeLessThan(writeComplete); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse();
    const restarted = new MilestoneExtension({ store: ctx.store, core: ctx.core }); await restarted.reconcile();
    expect(restarted.status({ completionMessageId: ctx.completionMessageId })).toMatchObject({ complete: true, state: "ack_delivered" });
    expect(ctx.store.events.filter((event) => event.type === "milestone_ack_delivered")).toHaveLength(1);
  });

  test("rejects wrong transport, subscription, socket, PID, and process-start evidence without completing", async () => { const ctx = await make(); await acceptCompletion(ctx); await acceptStatus(ctx, crypto.randomUUID()); const wrongIdle = { type: "control", action: "peer_idle_notice", orig_msg_id: crypto.randomUUID(), state: "idle", from: `uds:${ctx.socketPath}` }; await ctx.core.acceptFrame(wrongIdle, ctx.peer); await ctx.milestone.observeFrame(wrongIdle, ctx.peer); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse(); const attempt = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved"); for (const [peer, from] of [[ctx.peer, "uds:/tmp/wrong.sock"], [{ pid: 78, procStart: "start" }, `uds:${ctx.socketPath}`], [{ pid: 77, procStart: "other" }, `uds:${ctx.socketPath}`]]) await expect(ctx.milestone.observeFrame({ type: "control", action: "peer_message_status", orig_msg_id: attempt.ackTransportMessageId, status: "delivered", from }, peer)).rejects.toThrow("identity mismatch"); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse(); });

  test("coalesces concurrent explicit recovery to one fresh transport and forbids recovery after delivery", async () => {
    const ctx = await make({ failAt: [2] }); await expect(acceptCompletion(ctx)).rejects.toThrow(); const payloadHash = ctx.store.events.find((event) => event.type === "milestone_completion_accepted").payloadHash;
    const [a, b] = await Promise.all([ctx.milestone.recover({ completionMessageId: ctx.completionMessageId, payloadHash }), ctx.milestone.recover({ completionMessageId: ctx.completionMessageId, payloadHash })]);
    expect([a.state, b.state]).toEqual(["ack_reserved", "ack_reserved"]); const reservations = ctx.store.events.filter((event) => event.type === "milestone_ack_send_reserved"); expect(reservations).toHaveLength(2); expect(reservations[1].ackTransportMessageId).not.toBe(reservations[0].ackTransportMessageId); expect(ctx.store.events.filter((event) => event.type === "send_recovery_reserved")).toHaveLength(1);
    await acceptStatus(ctx, reservations[1].ackTransportMessageId); const delivered = await ctx.milestone.recover({ completionMessageId: ctx.completionMessageId, payloadHash }); expect(delivered.alreadyDelivered).toBeTrue(); expect(ctx.store.events.filter((event) => event.type === "send_recovery_reserved")).toHaveLength(1);
  });

  test("keeps one explicit recovery open after non-exact core delivery evidence", async () => {
    const ctx = await make({ failAt: [2] }); await expect(acceptCompletion(ctx)).rejects.toThrow();
    const accepted = ctx.store.events.find((event) => event.type === "milestone_completion_accepted");
    const initial = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved");
    const wrongSource = { type: "control", action: "peer_message_status", orig_msg_id: initial.ackTransportMessageId, status: "delivered", from: "uds:/tmp/not-the-target.sock" };
    await ctx.core.acceptFrame(wrongSource, ctx.peer);
    await expect(ctx.milestone.observeFrame(wrongSource, ctx.peer)).rejects.toThrow("identity mismatch");
    expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).complete).toBeFalse();
    await ctx.milestone.recover({ completionMessageId: ctx.completionMessageId, payloadHash: accepted.payloadHash });
    const reservations = ctx.store.events.filter((event) => event.type === "milestone_ack_send_reserved");
    expect(reservations).toHaveLength(2); expect(reservations[1].ackTransportMessageId).not.toBe(initial.ackTransportMessageId);
    await acceptStatus(ctx, reservations[1].ackTransportMessageId);
    expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId })).toMatchObject({ complete: true, state: "ack_delivered" });
  });

  test("recovers accepted-only and prepared-only crashes without consuming a fresh transport", async () => {
    for (const preparedBeforeCrash of [false, true]) {
      const ctx = await make(); const accepted = await recordAccepted(ctx); const ackMessageId = crypto.randomUUID();
      if (preparedBeforeCrash) await ctx.store.append("milestone_ack_prepared", { completionMessageId: ctx.completionMessageId, attemptId: ctx.attemptId, ackMessageId, threadId: ctx.threadId, payloadHash: accepted.payloadHash });
      await ctx.milestone.recover({ completionMessageId: ctx.completionMessageId, payloadHash: accepted.payloadHash });
      const prepared = ctx.store.events.find((event) => event.type === "milestone_ack_prepared" && event.completionMessageId === ctx.completionMessageId);
      const reserved = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved" && event.completionMessageId === ctx.completionMessageId);
      expect(prepared).toBeTruthy(); expect(reserved.reason).toBe("initial"); expect(reserved.ackTransportMessageId).toBe(prepared.ackMessageId); expect(ctx.store.events.filter((event) => event.type === "send_recovery_reserved" && event.messageId === prepared.ackMessageId)).toHaveLength(0);
    }
  });

  test("persists one recovery allowance across restart and never auto-retries it", async () => {
    const ctx = await make({ failAt: [2, 3] }); await expect(acceptCompletion(ctx)).rejects.toThrow(); const accepted = ctx.store.events.find((event) => event.type === "milestone_completion_accepted");
    await expect(ctx.milestone.recover({ completionMessageId: ctx.completionMessageId, payloadHash: accepted.payloadHash })).rejects.toThrow();
    const restarted = new MilestoneExtension({ store: ctx.store, core: ctx.core }); const result = await restarted.recover({ completionMessageId: ctx.completionMessageId, payloadHash: accepted.payloadHash });
    expect(result.alreadyRecovered).toBeTrue(); expect(ctx.store.events.filter((event) => event.type === "send_recovery_reserved")).toHaveLength(1); expect(ctx.wires).toHaveLength(3);
  });

  test("dedupes identical completion and isolates a conflicting incoming record from the accepted completion", async () => { const ctx = await make(); await acceptCompletion(ctx); await ctx.milestone.observeFrame({ ...ctx.frame, msg_id: crypto.randomUUID() }, ctx.peer); expect(ctx.store.events.filter((event) => event.type === "milestone_ack_send_reserved")).toHaveLength(1); const changed = { ...ctx.payload, milestone_id: "M-2" }; const conflict = { ...ctx.frame, msg_id: crypto.randomUUID(), message: { content: ctx.frame.message.content.slice(0, ctx.frame.message.content.indexOf("\n") + 1) + JSON.stringify(changed) } }; await expect(ctx.milestone.observeFrame(conflict, ctx.peer)).rejects.toThrow("conflicts"); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).state).toBe("ack_reserved"); });

  test("rejects attempt reuse without poisoning the accepted completion", async () => { const ctx = await make(); await acceptCompletion(ctx); const incoming = crypto.randomUUID(); const content = ctx.frame.message.content.replace(`message_id=${ctx.completionMessageId}`, `message_id=${incoming}`); await expect(ctx.milestone.observeFrame({ ...ctx.frame, msg_id: crypto.randomUUID(), message: { content } }, ctx.peer)).rejects.toThrow("attempt identifier"); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId }).state).toBe("ack_reserved"); expect(ctx.milestone.status({ completionMessageId: incoming }).found).toBeFalse(); });

  test("enforces schema bounds, correlation, safe POSIX paths, and loopback-only previews", async () => {
    const ctx = await make(); const markerLine = ctx.frame.message.content.slice(0, ctx.frame.message.content.indexOf("\n")); const encoded = (payload, marker = markerLine) => `${marker}\n${JSON.stringify(payload)}`;
    const absolutePath = ["", "private", "result.txt"].join("/");
    for (const payload of [
      { ...ctx.payload, files: ["src/bad\nname.mjs"] }, { ...ctx.payload, files: [absolutePath] }, { ...ctx.payload, files: ["src/../bad.mjs"] },
      { ...ctx.payload, files: Array.from({ length: 257 }, (_, index) => `src/${index}.mjs`) }, { ...ctx.payload, tests: Array.from({ length: 65 }, () => ctx.payload.tests[0]) },
      { ...ctx.payload, blockers: Array.from({ length: 65 }, () => ({ code: "BLOCK", message: "blocked" })) }, { ...ctx.payload, preview_url: "https://example.test/preview" },
      { ...ctx.payload, extra: true }
    ]) expect(parseCompletion(encoded(payload))).toBeNull();
    expect(parseCompletion(encoded({ ...ctx.payload, preview_url: "http://127.0.0.1:4181/preview" }))).not.toBeNull();
    const other = crypto.randomUUID(); const mismatchedPayload = { ...ctx.payload, instruction_id: other };
    await expect(ctx.milestone.observeFrame({ ...ctx.frame, message: { content: encoded(mismatchedPayload) } }, ctx.peer)).rejects.toThrow("not bound");
    const wrongThread = markerLine.replace(`thread_id=${ctx.threadId}`, `thread_id=${crypto.randomUUID()}`);
    await expect(ctx.milestone.observeFrame({ ...ctx.frame, message: { content: encoded(ctx.payload, wrongThread) } }, ctx.peer)).rejects.toThrow("not bound");
  });

  test("keeps snapshot-less P1 history replayable but milestone-ineligible", async () => { const ctx = await make(); const oldId = crypto.randomUUID(); const args = { alias: "worker", messageId: oldId, threadId: ctx.threadId, kind: "work", body: "Old durable work." }; await ctx.store.append("send_requested", { messageId: oldId, threadId: ctx.threadId, alias: "worker", requestHash: sha256(canonicalSend(args)), subscriptionId: crypto.randomUUID(), targetPid: 77, targetProcStart: "start" }); const replay = await ctx.core.send(args); expect(replay).toMatchObject({ replay: true, messageId: oldId }); const content = ctx.frame.message.content.replaceAll(ctx.instructionId, oldId); await expect(ctx.milestone.observeFrame({ ...ctx.frame, message: { content } }, ctx.peer)).rejects.toThrow("identity snapshot"); expect(ctx.store.events.some((event) => event.type === "milestone_completion_accepted" && event.instructionId === oldId)).toBeFalse(); });

  test("isolates internal recovery from MCP-shaped data, rejects callback failure before wire, and fails same-ID callback re-entry", async () => {
    const ctx = await make(); const ordinaryId = crypto.randomUUID(); let injected = false;
    await ctx.core.send({ alias: "worker", messageId: ordinaryId, threadId: ctx.threadId, kind: "work", body: "x", recovery: true, afterReservation: () => { injected = true; } });
    expect(injected).toBeFalse(); expect(ctx.store.events.some((event) => event.type === "send_recovery_reserved" && event.messageId === ordinaryId)).toBeFalse();
    await expect(ctx.core.send({ alias: "worker", messageId: crypto.randomUUID(), threadId: ctx.threadId, kind: "work", body: "x" }, { recovery: true })).rejects.toThrow("internal send options");
    const callbackId = crypto.randomUUID(); const beforeFailure = ctx.wires.length;
    await expect(ctx.core.send({ alias: "worker", messageId: callbackId, threadId: ctx.threadId, kind: "work", body: "x" }, milestoneSendOptions({ afterReservation: async () => { throw new Error("synthetic callback failure"); } }))).rejects.toThrow("callback failure");
    expect(ctx.wires).toHaveLength(beforeFailure);
    const reentrantId = crypto.randomUUID(); const reentrantArgs = { alias: "worker", messageId: reentrantId, threadId: ctx.threadId, kind: "work", body: "x" };
    await expect(ctx.core.send(reentrantArgs, milestoneSendOptions({ afterReservation: async () => ctx.core.send(reentrantArgs) }))).rejects.toMatchObject({ code: "INTERNAL_SEND_REENTRANT" });
    expect(ctx.wires).toHaveLength(beforeFailure);
  });

  test("uses milestone_ event names and public views omit identity, permission proof, and delimiter-adjacent absolute paths", async () => { const ctx = await make(); const absolutePath = ["", "private", "build.log"].join("/"); const payload = { ...ctx.payload, tests: [{ ...ctx.payload.tests[0], command: `path:${absolutePath},[/var/run/confidential.txt]=('/opt/private.log') //network-root/private.data` }], blockers: [{ code: "CHECK", message: `inspect=${absolutePath},[/var/run/hidden.txt]` }] }; ctx.frame.message.content = ctx.frame.message.content.slice(0, ctx.frame.message.content.indexOf("\n") + 1) + JSON.stringify(payload); await acceptCompletion(ctx); const result = ctx.milestone.status({ completionMessageId: ctx.completionMessageId }); const bytes = JSON.stringify(result); for (const value of [ctx.socketPath, absolutePath, "/var/run/confidential.txt", "/opt/private.log", "/var/run/hidden.txt", "//network-root/private.data", "targetPid", "targetProcStart", "targetCwd", "targetPermission", "kern_procargs2"]) expect(bytes).not.toContain(value); expect(bytes).toContain("[path]"); expect(ctx.store.events.filter((event) => event.completionMessageId === ctx.completionMessageId).every((event) => event.type.startsWith("milestone_"))).toBeTrue(); });

  test("preserves plain P1 evidence before, during, and after extension use on the same store", async () => { const ctx = await make(); const plainId = crypto.randomUUID(); const args = { alias: "worker", messageId: plainId, threadId: ctx.threadId, kind: "work", body: "plain" }; const sent = await ctx.core.send(args); const withExtension = new MilestoneExtension({ store: ctx.store, core: ctx.core }); expect((await ctx.core.send(args)).replay).toBeTrue(); await ctx.core.acceptFrame({ type: "control", action: "peer_message_status", orig_msg_id: plainId, status: "delivered", from: `uds:${ctx.socketPath}` }, ctx.peer); await withExtension.observeFrame({ type: "control", action: "peer_message_status", orig_msg_id: plainId, status: "delivered", from: `uds:${ctx.socketPath}` }, ctx.peer); expect((await ctx.core.wait({ messageId: plainId, require: "delivery", timeoutMs: 50 })).event.transportMessageId).toBe(plainId); expect((await ctx.core.send(args)).replay).toBeTrue(); expect(ctx.core.events({ messageId: plainId }).events.some((event) => event.subscriptionId === sent.subscriptionId)).toBeTrue(); });

  test("wait reconnects from a cursor and terminal evidence blocks completion", async () => { const ctx = await make(); const cursor = ctx.store.events.at(-1).seq; const pending = ctx.milestone.wait({ afterSeq: cursor, completionMessageId: ctx.completionMessageId, timeoutMs: 1000 }); await acceptCompletion(ctx); const waited = await pending; expect(waited.events[0].type).toBe("milestone_completion_accepted"); const attempt = ctx.store.events.find((event) => event.type === "milestone_ack_send_reserved"); await acceptStatus(ctx, attempt.ackTransportMessageId, "denied"); expect(ctx.milestone.status({ completionMessageId: ctx.completionMessageId })).toMatchObject({ complete: false, state: "terminal" }); });
});
