#!/usr/bin/env bun
// M0 read-only baseline. Prints aggregates only: counts, latencies, reasons, hashes.
// Never prints message bodies, body file names, or free-text fields.
//
//   bun tools/m0/baseline.mjs ledger  <events.jsonl>
//   bun tools/m0/baseline.mjs rollout <codex-rollout.jsonl>
//
// Both inputs are opened read-only and streamed. Neither the daemon nor any session is contacted.
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";

const KST = 9 * 3600 * 1000;
const day = (iso) => new Date(Date.parse(iso) + KST).toISOString().slice(0, 10);
const inc = (m, k, n = 1) => { m[k] = (m[k] ?? 0) + n; };
function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return { n: v.length, p50: q(0.5), p90: q(0.9), p95: q(0.95), max: v.at(-1), min: v[0] };
}
const round = (s) => Object.fromEntries(Object.entries(s).map(([k, x]) => [k, typeof x === "number" && k !== "n" ? Math.round(x) : x]));

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { flags: "r" }), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}
async function sha256(file) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

async function ledger(file) {
  const byType = {}; const perDay = {}; const sends = new Map(); const writes = new Map();
  const acks = new Map(); const replies = new Map(); const idle = new Set(); const waitTimeouts = new Set();
  const uncorrelated = { total: 0, byReason: {}, withPeerPid: 0, withBodyFile: 0, byDay: {} };
  const refused = { total: 0, byReason: {}, withBodyFile: 0 };
  const hold = { heldMs: [], byReason: {} };
  const resolveFailed = { total: 0, byReason: {}, byDayReason: {} };
  const rebindFailed = { total: 0, byReason: {}, byDay: {} };
  const rebound = []; const generations = {}; const evidence = {}; const kinds = {};
  let first = null; let last = null; let rows = 0; let prev = null; const pairs = { rebindThenResolve: 0 };
  for await (const line of lines(file)) {
    const e = JSON.parse(line); rows++; first ??= e; last = e;
    inc(byType, e.type); inc(perDay[day(e.at)] ??= {}, e.type);
    switch (e.type) {
      case "send_requested": {
        sends.set(e.messageId, e); inc(kinds, e.kind ?? "null");
        const g = generations[e.alias ?? e.targetAlias] ??= { gens: [], sends: 0 };
        const key = `${e.targetPid}|${e.targetProcStart}|${e.targetSessionId}`;
        if (g.gens.at(-1)?.key !== key) g.gens.push({ key, firstAt: e.at, sends: 0 });
        g.gens.at(-1).sends++; g.sends++;
        break;
      }
      case "socket_write_complete": writes.set(e.messageId, e); break;
      case "peer_ack": if (!acks.has(e.messageId)) acks.set(e.messageId, e); inc(evidence, `ack:${e.evidence}`); break;
      case "peer_reply": if (!replies.has(e.messageId)) replies.set(e.messageId, e); inc(evidence, `reply:${e.evidence}`); break;
      case "peer_idle_notice": idle.add(e.messageId); break;
      case "peer_wait_timed_out": waitTimeouts.add(e.messageId); break;
      case "peer_frame_uncorrelated":
        uncorrelated.total++; inc(uncorrelated.byReason, e.reason); inc(uncorrelated.byDay, day(e.at));
        if ("peerPid" in e) uncorrelated.withPeerPid++; if (e.bodyFile) uncorrelated.withBodyFile++; break;
      case "peer_frame_refused": refused.total++; inc(refused.byReason, e.reason); if (e.bodyFile) refused.withBodyFile++; break;
      case "peer_socket_hold_bounded": hold.heldMs.push(e.heldMs); inc(hold.byReason, e.reason); break;
      case "target_resolve_failed":
        resolveFailed.total++; inc(resolveFailed.byReason, e.reason); inc(resolveFailed.byDayReason[day(e.at)] ??= {}, e.reason);
        if (prev?.type === "target_rebind_failed" && prev.alias === e.alias && e.reason === "rebind_no_proof") pairs.rebindThenResolve++;
        break;
      case "target_rebind_failed": rebindFailed.total++; inc(rebindFailed.byReason, e.reason); inc(rebindFailed.byDay, day(e.at)); break;
      case "target_rebound": rebound.push({ seq: e.seq, at: e.at, alias: e.alias, proof: e.proof }); break;
    }
    prev = e;
  }
  const ms = (a, b) => Date.parse(b.at) - Date.parse(a.at);
  const writeLat = []; const ackLat = []; const replyLat = []; const firstRespLat = [];
  let acked = 0; let replied = 0; let neither = 0; let neitherButTimedOut = 0; let idleOnly = 0;
  const neitherByDay = {};
  for (const [id, s] of sends) {
    const w = writes.get(id); if (w) writeLat.push(ms(s, w));
    const a = acks.get(id); const r = replies.get(id);
    if (a) { acked++; ackLat.push(ms(s, a)); }
    if (r) { replied++; replyLat.push(ms(s, r)); }
    const firstResp = [a, r].filter(Boolean).sort((x, y) => x.seq - y.seq)[0];
    if (firstResp) firstRespLat.push(ms(s, firstResp));
    else { neither++; inc(neitherByDay, day(s.at)); if (waitTimeouts.has(id)) neitherButTimedOut++; if (idle.has(id)) idleOnly++; }
  }
  const gens = Object.fromEntries(Object.entries(generations).map(([alias, g]) => [alias, { sends: g.sends, generations: g.gens.length, switches: g.gens.length - 1, perGeneration: g.gens.map((x) => ({ firstAt: x.firstAt, sends: x.sends })) }]));
  return {
    input: { rows, sha256: await sha256(file), firstSeq: first?.seq, firstAt: first?.at, lastSeq: last?.seq, lastAt: last?.at },
    byType,
    codexToClaude: {
      sends: sends.size, byKind: kinds,
      socketWriteMs: round(stats(writeLat)),
      acked, ackMs: round(stats(ackLat)),
      replied, replyMs: round(stats(replyLat)),
      anyResponse: sends.size - neither, firstResponseMs: round(stats(firstRespLat)),
      noAckNoReply: neither, noAckNoReplyWithWaitTimeout: neitherButTimedOut, noAckNoReplyWithIdleNotice: idleOnly, noAckNoReplyByDay: neitherByDay,
      evidence, idleNoticeMessages: idle.size, waitTimedOutMessages: waitTimeouts.size
    },
    socketHoldBounded: { count: hold.heldMs.length, ofSends: sends.size, heldMs: round(stats(hold.heldMs)), byReason: hold.byReason },
    inboundUnpaired: uncorrelated,
    inboundRefused: refused,
    targets: { resolveFailed, rebindFailed, rebindThenResolvePairs: pairs.rebindThenResolve, rebindAttemptsCountedOnce: rebindFailed.total, rebound, generations: gens },
    perDay
  };
}

// Codex rollout: a UserMessage whose client_id is a UUIDv7 was queued (its first 48 bits are the
// enqueue time, measured 2026-09-29, undocumented). Owner keyboard input carries a UUIDv4. Delay =
// row timestamp - v7 time. "Held" = a task was running at enqueue time (task_started seen, no
// task_complete/turn_aborted yet; a task_started with no close is closed by the next task_started). This reads an internal format; it is diagnosis, not a contract.
async function rollout(file) {
  let running = null; const turns = [];
  const users = []; let v4 = 0; let other = 0;
  for await (const line of lines(file)) {
    if (!line.includes("task_started") && !line.includes("task_complete") && !line.includes("turn_aborted") && !line.includes("UserMessage")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {}; const t = Date.parse(e.timestamp);
    if (e.type === "event_msg" && p.type === "task_started") { if (running && running.end === undefined) running.end = t; running = { id: p.turn_id, start: t }; turns.push(running); }
    else if (e.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted")) { if (running) running.end = t; running = null; }
    else if (e.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage") {
      const cid = p.item.client_id ?? "";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(cid)) users.push({ at: t, enq: parseInt(cid.replace(/-/g, "").slice(0, 12), 16), cidHash: crypto.createHash("sha256").update(cid).digest("hex").slice(0, 12) });
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-4/i.test(cid)) v4++; else other++;
    }
  }
  const runningAt = (ts) => turns.find((x) => x.start <= ts && (x.end === undefined || ts < x.end));
  const idleDelay = []; const heldDelay = []; const held = [];
  for (const u of users) {
    const d = u.at - u.enq; const turn = runningAt(u.enq - 1);
    if (turn && turn.end !== undefined && u.enq < turn.end) { heldDelay.push(d); held.push({ enqueuedAt: new Date(u.enq).toISOString(), arrivedAt: new Date(u.at).toISOString(), heldSec: Math.round(d / 1000), turnEndToArrivalMs: turn.end ? u.at - turn.end : null, clientIdSha12: u.cidHash }); }
    else idleDelay.push(d);
  }
  const buckets = { "lt5s": 0, "5s-60s": 0, "1-15m": 0, "15-30m": 0, "30-60m": 0, "gt60m": 0 };
  const bucket = (d) => d < 5e3 ? "lt5s" : d < 6e4 ? "5s-60s" : d < 9e5 ? "1-15m" : d < 18e5 ? "15-30m" : d < 36e5 ? "30-60m" : "gt60m";
  const byStart = { turnRunning: { ...buckets }, noTurnRunning: { ...buckets } }; const byDay = {};
  for (const u of users) {
    const d = u.at - u.enq; const key = runningAt(u.enq - 1) ? "turnRunning" : "noTurnRunning";
    byStart[key][bucket(d)]++; const k = day(new Date(u.enq).toISOString()); (byDay[k] ??= { n: 0, over15m: 0, maxSec: 0 }).n++;
    if (d >= 9e5) byDay[k].over15m++; byDay[k].maxSec = Math.max(byDay[k].maxSec, Math.round(d / 1000));
  }
  return {
    delayBuckets: byStart, byDay,
    input: { sha256: "(not computed: file is large; use size+mtime)", bytes: fs.statSync(file).size, mtime: fs.statSync(file).mtime.toISOString() },
    turns: turns.length, userMessages: { queuedV7: users.length, ownerV4: v4, other },
    queuedIdleMs: round(stats(idleDelay)), queuedHeldMs: round(stats(heldDelay)),
    held: held.sort((a, b) => b.heldSec - a.heldSec)
  };
}

const [mode, file] = process.argv.slice(2);
if (!file || !["ledger", "rollout"].includes(mode)) { console.error("usage: baseline.mjs ledger|rollout <file>"); process.exit(2); }
console.log(JSON.stringify(mode === "ledger" ? await ledger(file) : await rollout(file), null, 2));
