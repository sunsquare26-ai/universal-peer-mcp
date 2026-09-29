import { expect, test } from "bun:test";
import { dailyStats, pairedResolveRows, traceMessage } from "../../src/core/trace.mjs";
import { ledger } from "./helpers.mjs";

const M = "13457e71-a5ea-4419-a971-848879e8c5a3";
const OTHER = "d7e3473e-c0bf-42ba-9fd2-f1aa9c50a216";
const T = (s) => `2026-09-29T06:${s}Z`;
const send = (id, pid = 31075, session = "aaaaaaaa-0000-4000-8000-000000000001") => ({ messageId: id, targetAlias: "friday-main", alias: "friday-main", targetPid: pid, targetProcStart: "p", targetSessionId: session });

test("acked message: every stage with its time, bottleneck is the longest gap", () => {
  const rows = ledger([
    ["send_requested", T("23:37.794"), send(M)],
    ["socket_write_complete", T("23:37.808"), { messageId: M }],
    ["peer_socket_hold_bounded", T("23:38.810"), {}],
    ["peer_ack", T("23:45.262"), { messageId: M, evidence: "application_ack", firstLine: "PEER_ACK v=1 …" }]
  ]);
  const t = traceMessage(rows, M);
  expect(t.found).toBe(true);
  const [r] = t.receivers;
  expect(r.receiver).toMatchObject({ key: "claude:friday-main", sessionId: "aaaaaaaa-0000-4000-8000-000000000001", pid: 31075 });
  expect(r.stages.map((s) => s.stage)).toEqual(["recorded", "written", "acked"]);
  expect(r.reached).toBe("acked"); expect(r.done).toBe(true); expect(r.succeeded).toBe(true);
  expect(r.bottleneck).toEqual({ from: "written", to: "acked", ms: 7454 });
  expect(t.restarts).toEqual([]);
});

test("written and never answered: stuck after written, measured to now", () => {
  const rows = ledger([["send_requested", T("23:22.345"), send(OTHER)], ["socket_write_complete", T("23:22.354"), { messageId: OTHER }]]);
  const t = traceMessage(rows, OTHER, { now: Date.parse(T("33:22.354")) });
  expect(t.receivers[0].bottleneck).toEqual({ stuckAfter: "written", sinceSeq: 2, ms: 600000 });
  expect(t.receivers[0].done).toBe(false);
});

test("a wait timeout is a note on the timeline, not the stage reached", () => {
  const rows = ledger([["send_requested", T("00:00.000"), send(M)], ["socket_write_complete", T("00:00.010"), { messageId: M }], ["peer_wait_timed_out", T("00:30.010"), { messageId: M, require: "ack", waitedMs: 30000 }]]);
  const r = traceMessage(rows, M, { now: Date.parse(T("01:00.000")) }).receivers[0];
  expect(r.stages.at(-1).stage).toBe("wait_timed_out");
  expect(r.reached).toBe("written");
});

test("restarts inside the window: daemon generation, target generation, succession rows", () => {
  const rows = ledger([
    ["daemon_started", T("00:00.000"), { generationId: "11111111-1111-4111-8111-111111111111", daemonPid: 10 }],
    ["send_requested", T("00:01.000"), send(OTHER, 31075)],
    ["send_requested", T("00:02.000"), send(M, 31075)],
    ["socket_write_complete", T("00:02.010"), { messageId: M }],
    ["daemon_stopping", T("00:03.000"), { generationId: "11111111-1111-4111-8111-111111111111" }],
    ["daemon_started", T("00:04.000"), { generationId: "22222222-2222-4222-8222-222222222222", daemonPid: 11 }],
    ["target_rebind_failed", T("00:05.000"), { alias: "friday-main", reason: "rebind_no_proof" }],
    ["target_resolve_failed", T("00:05.001"), { alias: "friday-main", reason: "rebind_no_proof", rebindFailedSeq: 7 }],
    ["send_requested", T("00:06.000"), send(OTHER.replace("d7", "e7"), 40000, "bbbbbbbb-0000-4000-8000-000000000002")],
    ["peer_ack", T("00:07.000"), { messageId: M }]
  ]);
  const t = traceMessage(rows, M);
  expect(t.restarts.map((r) => r.kind)).toEqual(["daemon_stopping", "daemon_started", "target_rebind_failed", "target_resolve_failed", "target_generation"]);
  expect(t.restarts.find((r) => r.kind === "target_generation")).toMatchObject({ pid: 40000, sessionId: "bbbbbbbb-0000-4000-8000-000000000002" });
  expect(t.receivers[0].bottleneck).toMatchObject({ from: "written", to: "acked" });
});

test("a doorbell attempt is its own receiver: intended -> queued, receiver is the Codex thread", () => {
  const thread = "01a0d249-5457-7f82-8602-b992529eac16"; const attemptId = "33333333-3333-4333-8333-333333333333";
  const rows = ledger([
    ["attempt_intent", T("00:00.000"), { messageId: M, attemptId, path: "codex_queue", receiverThreadId: thread, receiverAlias: "codex-main" }],
    ["attempt_outcome", T("00:01.300"), { messageId: M, attemptId, outcome: "queued", returnedId: "01a0ead6-9156-7000-8000-000000000000" }]
  ]);
  const [r] = traceMessage(rows, M, { now: Date.parse(T("30:00.000")) }).receivers;
  expect(r.receiver).toMatchObject({ key: `codex_queue:${thread}`, alias: "codex-main" });
  expect(r.stages.map((s) => s.stage)).toEqual(["intended", "queued"]);
  // queued is not delivery: the trace stays open and shows where it is stuck.
  expect(r.done).toBe(false);
  expect(r.bottleneck.stuckAfter).toBe("queued");
});

test("unknown id is reported as not found", () => {
  expect(traceMessage([], M)).toEqual({ messageId: M, found: false, receivers: [], restarts: [] });
});

test("a rebind failure is counted once, linked or legacy-paired", () => {
  const rows = ledger([
    ["target_rebind_failed", "2026-09-27T01:00:00.000Z", { alias: "erp-project-f9", reason: "rebind_no_proof" }],
    ["target_resolve_failed", "2026-09-27T01:00:00.020Z", { alias: "erp-project-f9", reason: "rebind_no_proof" }],
    ["target_rebind_failed", "2026-09-27T02:00:00.000Z", { alias: "friday-main", reason: "rebind_no_proof" }],
    ["target_resolve_failed", "2026-09-27T02:00:00.010Z", { alias: "friday-main", reason: "rebind_no_proof", rebindFailedSeq: 3 }],
    ["target_resolve_failed", "2026-09-27T03:00:00.000Z", { alias: "friday-main", reason: "argv_executable_mismatch" }],
    // A resolve failure with a rebind reason and no rebind row near it is its own failure.
    ["target_resolve_failed", "2026-09-27T04:00:00.000Z", { alias: "friday-main", reason: "rebind_no_proof" }]
  ]);
  expect([...pairedResolveRows(rows)].sort()).toEqual([2, 4]);
  const day = dailyStats(rows)["2026-09-27"];
  expect(day.rebindFailed).toEqual({ rebind_no_proof: 2 });
  expect(day.resolveFailed).toEqual({ argv_executable_mismatch: 1, rebind_no_proof: 1 });
});

test("daily counts: first ACK/reply per message only, days in Korea time, hold rows ignored", () => {
  const rows = ledger([
    ["send_requested", "2026-09-28T14:59:59.000Z", send(M)],          // 09-28 23:59:59 KST
    ["peer_socket_hold_bounded", "2026-09-28T15:00:00.500Z", {}],
    ["peer_ack", "2026-09-28T15:00:01.000Z", { messageId: M }],       // 09-29 00:00:01 KST
    ["peer_ack", "2026-09-28T15:00:02.000Z", { messageId: M.toUpperCase() }],
    ["peer_reply", "2026-09-28T15:01:00.000Z", { messageId: M }],
    ["peer_reply", "2026-09-28T15:02:00.000Z", { messageId: M }],
    ["peer_wait_timed_out", "2026-09-28T15:03:00.000Z", { messageId: M }],
    ["peer_wait_timed_out", "2026-09-28T15:04:00.000Z", { messageId: M }]
  ]);
  const d = dailyStats(rows);
  expect(d["2026-09-28"].sends).toBe(1);
  expect(d["2026-09-29"]).toMatchObject({ acked: 1, replied: 1, waitTimedOut: 1 });
  expect(JSON.stringify(d)).not.toContain("hold");
});

test("a trace never carries a body, a body file name or a digest-free secret", () => {
  const rows = ledger([
    ["send_requested", T("00:00.000"), send(M)],
    ["peer_reply", T("00:05.000"), { messageId: M, verdict: "pass", bodyFile: "inbound/x.txt", body: "760124-1234567 본문", bodyBytes: 20, bodySha256: "a".repeat(64), firstLine: "[rrn] 본문" }]
  ]);
  const text = JSON.stringify(traceMessage(rows, M));
  expect(text).not.toContain("760124"); expect(text).not.toContain("inbound/x.txt"); expect(text).not.toContain("\"body\"");
  expect(text).toContain("[rrn] 본문");
});
