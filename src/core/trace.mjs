import { dayOf, DAY_OFFSET_MINUTES } from "./days.mjs";
import { sameUuid } from "./limits.mjs";

// One message id, read back from the ledger as a timeline: which receiving session it was aimed
// at, which stage it reached, where the time went, and what restarted while it was in flight.
// Everything here is a pure function of the rows, so the same answer comes from the live daemon
// (`trace_message`) and from a copied ledger file days later (`universal-peer-mcp trace --ledger`).
//
// Stages are evidence, not hopes. `written` is a socket write, not a delivery; `observed` is an
// idle notice after the message, which says the target finished a turn, not that it read it;
// `queued` is a `codex queue` receipt, not a Codex read. Only `acked`/`replied` come from the
// receiving model.

const SEND_STAGE = {
  send_requested: "recorded",
  send_recovery_reserved: "recovery_reserved",
  socket_write_complete: "written",
  send_failed: "failed",
  peer_message_status: "status",
  peer_terminal_failure: "failed",
  peer_idle_notice: "observed",
  peer_ack: "acked",
  peer_reply: "replied",
  peer_wait_timed_out: "wait_timed_out",
  peer_frame_refused: "refused"
};
const SUCCESS = new Set(["acked", "replied"]);
const TERMINAL = new Set(["acked", "replied", "failed"]);
// The stages that are progress. A wait timing out or a refusal is a note on the timeline, not a
// step forward, so it never becomes "the stage reached".
const PROGRESS = new Set(["recorded", "recovery_reserved", "written", "observed", "acked", "replied", "failed", "intended", "queued", "attempt_written", "attempt_failed", "attempt_unknown", "read"]);

function receiverOfSend(row) {
  const alias = row.targetAlias ?? row.alias ?? null;
  return { key: `claude:${alias ?? "unknown"}`, kind: "claude_session", alias, sessionId: row.targetSessionId ?? null, pid: row.targetPid ?? null, procStart: row.targetProcStart ?? null };
}
function receiverOfAttempt(row) {
  const id = row.receiverThreadId ?? row.receiverAlias ?? "unknown";
  return { key: `${row.path}:${id}`, kind: row.path, alias: row.receiverAlias ?? null, threadId: row.receiverThreadId ?? null };
}

function stageOf(row) {
  if (row.type === "attempt_intent") return "intended";
  if (row.type === "attempt_outcome") return row.outcome === "queued" ? "queued" : `attempt_${row.outcome}`;
  if (row.type === "inbound_body_read") return "read";
  return SEND_STAGE[row.type] ?? null;
}

function stageEntry(row, stage) {
  const entry = { stage, seq: row.seq, at: row.at };
  for (const key of ["reason", "errorCode", "evidence", "verdict", "state", "outcome", "attemptId", "returnedId", "readerPid", "header", "waitedMs", "require"]) {
    if (row[key] !== undefined && row[key] !== null) entry[key] = row[key];
  }
  return entry;
}

function summarise(stages, now) {
  const progress = stages.filter((s) => PROGRESS.has(s.stage));
  if (progress.length === 0) return { reached: null, done: false, bottleneck: null };
  const last = progress.at(-1);
  const done = progress.some((s) => TERMINAL.has(s.stage));
  const succeeded = progress.some((s) => SUCCESS.has(s.stage));
  let bottleneck = null;
  if (done) {
    for (let i = 1; i < progress.length; i += 1) {
      const ms = Date.parse(progress[i].at) - Date.parse(progress[i - 1].at);
      if (bottleneck === null || ms > bottleneck.ms) bottleneck = { from: progress[i - 1].stage, to: progress[i].stage, ms };
    }
  } else {
    bottleneck = { stuckAfter: last.stage, sinceSeq: last.seq, ms: Math.max(0, now - Date.parse(last.at)) };
  }
  return { reached: last.stage, done, succeeded, bottleneck };
}

// Restarts in the window a message was in flight: daemon generations (daemon_started rows) and
// target generations (the same alias sent to under a different pid, process start or session id),
// plus the succession rows for that alias. `window` is [first seq of the message, seq it finished
// or the end of the ledger].
function restartsFor(events, receivers, from, to) {
  const out = [];
  const aliases = new Set(receivers.filter((r) => r.kind === "claude_session" && r.alias).map((r) => r.alias));
  const generation = new Map();
  for (const row of events) {
    if (row.seq > to) break;
    if (row.type === "send_requested" && aliases.has(row.targetAlias ?? row.alias)) {
      const alias = row.targetAlias ?? row.alias;
      const key = `${row.targetPid}|${row.targetProcStart}|${row.targetSessionId}`;
      const prior = generation.get(alias);
      if (prior !== undefined && prior !== key && row.seq >= from) out.push({ kind: "target_generation", alias, seq: row.seq, at: row.at, pid: row.targetPid ?? null, sessionId: row.targetSessionId ?? null });
      generation.set(alias, key);
    }
    if (row.seq < from) continue;
    if (row.type === "daemon_started") out.push({ kind: "daemon_started", seq: row.seq, at: row.at, generationId: row.generationId ?? null, pid: row.daemonPid ?? null });
    if (row.type === "daemon_stopping") out.push({ kind: "daemon_stopping", seq: row.seq, at: row.at, generationId: row.generationId ?? null });
    if (["target_rebound", "target_rebind_failed", "target_resolve_failed"].includes(row.type) && aliases.has(row.alias)) out.push({ kind: row.type, alias: row.alias, seq: row.seq, at: row.at, reason: row.reason ?? null });
  }
  return out;
}

export function traceMessage(events, messageId, { now = Date.now() } = {}) {
  const rows = events.filter((row) => typeof row.messageId === "string" && sameUuid(row.messageId, messageId));
  if (rows.length === 0) return { messageId, found: false, receivers: [], restarts: [] };
  const receivers = new Map();
  let sendReceiver = null;
  const receiverFor = (row) => {
    if (row.type === "send_requested") { sendReceiver = receiverOfSend(row); return sendReceiver; }
    if (row.type === "attempt_intent" || row.type === "attempt_outcome") {
      if (row.type === "attempt_outcome") {
        const intent = rows.find((r) => r.type === "attempt_intent" && r.attemptId === row.attemptId);
        return intent ? receiverOfAttempt(intent) : { key: `attempt:${row.attemptId}`, kind: "unknown" };
      }
      return receiverOfAttempt(row);
    }
    if (row.type === "inbound_body_read") return { key: `reader:${row.readerPid}|${row.readerProcStart}`, kind: "reader", pid: row.readerPid ?? null };
    return sendReceiver ?? { key: "claude:unknown", kind: "claude_session" };
  };
  for (const row of rows) {
    const stage = stageOf(row);
    if (!stage) continue;
    const receiver = receiverFor(row);
    if (!receivers.has(receiver.key)) receivers.set(receiver.key, { receiver, stages: [] });
    receivers.get(receiver.key).stages.push(stageEntry(row, stage));
  }
  const out = [...receivers.values()].map(({ receiver, stages }) => ({ receiver, stages, ...summarise(stages, now) }));
  const from = rows[0].seq;
  const allDone = out.every((r) => r.done);
  const to = allDone ? rows.at(-1).seq : (events.at(-1)?.seq ?? rows.at(-1).seq);
  return { messageId, found: true, firstSeq: from, lastSeq: rows.at(-1).seq, receivers: out, restarts: restartsFor(events, out.map((r) => r.receiver), from, to) };
}

// A rebind failure writes two rows: `target_rebind_failed` and then `target_resolve_failed` with a
// rebind reason (src/core/session-rebind.mjs -> src/core/peer-core.mjs). Rows written from this
// build link the second to the first (`rebindFailedSeq`); older rows are paired by position — same
// alias, same reason, the rebind row within the previous 8 rows and 5 seconds. A paired resolve
// row is not a second failure.
export function pairedResolveRows(events) {
  const paired = new Set();
  const used = new Set();
  for (let i = 0; i < events.length; i += 1) {
    const row = events[i];
    if (row.type !== "target_resolve_failed") continue;
    if (Number.isInteger(row.rebindFailedSeq)) { paired.add(row.seq); used.add(row.rebindFailedSeq); continue; }
    for (let j = i - 1; j >= Math.max(0, i - 8); j -= 1) {
      const prior = events[j];
      if (prior.type !== "target_rebind_failed" || used.has(prior.seq)) continue;
      if (prior.alias === row.alias && prior.reason === row.reason && Date.parse(row.at) - Date.parse(prior.at) <= 5000) { paired.add(row.seq); used.add(prior.seq); break; }
    }
  }
  return paired;
}

// Daily counts with nothing counted twice: a message is acked (or replied) on the day of its first
// ACK (reply) only, a rebind failure is one failure, and the socket-hold rows are left out because
// they are on every send and carry no signal.
export function dailyStats(events, { offsetMinutes = DAY_OFFSET_MINUTES, sinceDay = null } = {}) {
  const days = {};
  const bump = (day, path, n = 1) => {
    if (sinceDay && day < sinceDay) return;
    const d = (days[day] ??= { sends: 0, written: 0, sendFailed: 0, acked: 0, replied: 0, waitTimedOut: 0, unpaired: {}, refused: {}, resolveFailed: {}, rebindFailed: {}, rebound: 0, attempts: {}, attemptOutcomes: {}, bodyReads: 0, bodiesExpired: 0, daemonStarts: 0, daemonStops: 0, archived: 0 });
    if (path.length === 1) d[path[0]] += n; else d[path[0]][path[1]] = (d[path[0]][path[1]] ?? 0) + n;
  };
  const paired = pairedResolveRows(events);
  const seenAck = new Set(); const seenReply = new Set(); const seenWait = new Set();
  for (const row of events) {
    const day = dayOf(row.at, offsetMinutes);
    const id = typeof row.messageId === "string" ? row.messageId.toLowerCase() : null;
    switch (row.type) {
      case "send_requested": bump(day, ["sends"]); break;
      case "socket_write_complete": bump(day, ["written"]); break;
      case "send_failed": bump(day, ["sendFailed"]); break;
      case "peer_ack": if (id && !seenAck.has(id)) { seenAck.add(id); bump(day, ["acked"]); } break;
      case "peer_reply": if (id && !seenReply.has(id)) { seenReply.add(id); bump(day, ["replied"]); } break;
      case "peer_wait_timed_out": if (id && !seenWait.has(id)) { seenWait.add(id); bump(day, ["waitTimedOut"]); } break;
      case "peer_frame_uncorrelated": bump(day, ["unpaired", row.reason ?? "unknown"]); break;
      case "peer_frame_refused": bump(day, ["refused", row.reason ?? "unknown"]); break;
      case "target_resolve_failed": if (!paired.has(row.seq)) bump(day, ["resolveFailed", row.reason ?? "unknown"]); break;
      case "target_rebind_failed": bump(day, ["rebindFailed", row.reason ?? "unknown"]); break;
      case "target_rebound": bump(day, ["rebound"]); break;
      case "attempt_intent": bump(day, ["attempts", row.path ?? "unknown"]); break;
      case "attempt_outcome": bump(day, ["attemptOutcomes", row.outcome ?? "unknown"]); break;
      case "inbound_body_read": bump(day, ["bodyReads"]); break;
      case "inbound_body_expired": bump(day, ["bodiesExpired"]); break;
      case "daemon_started": bump(day, ["daemonStarts"]); break;
      case "daemon_stopping": bump(day, ["daemonStops"]); break;
      case "ledger_archived": bump(day, ["archived"]); break;
    }
  }
  return days;
}
