import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_INBOUND_BODY_BYTES } from "./inbound-spool.mjs";
import { INBOUND_DIRNAME } from "./state-paths.mjs";

// Spooled bodies and when they may go. A body is deleted automatically only when
//
//   - it is older than `days` (off unless configured: `days <= 0`, the M1 default), and
//   - the message it belongs to is concluded: a `peer_ack` or `peer_reply` exists for its messageId,
//     or someone recorded it as processed (`inbound_body_disposition`, disposition "processed").
//
// A body past the age that is not concluded — unmatched, unread, unanswered — is kept. The ledger
// gets one `inbound_body_retention_exceeded` row for it and one alarm is raised, once per body.
// It leaves only through the explicit procedure `disposeInboundBody(..., "discard")` (CLI
// `universal-peer-mcp body-dispose`), which is itself recorded.
//
// Deletion, automatic or explicit, is always: digest checked against the row that named the file
// (a mismatch keeps the file and is reported once), then the `inbound_body_expired` row, then the
// unlink. If the row cannot be written nothing is deleted.
export const DEFAULT_BODY_RETENTION_DAYS = 0;
export const EXCEEDED_ALERTS_PER_RUN = 5;
const SELF = new Set(["inbound_body_expired", "inbound_body_expire_skipped", "inbound_body_read", "inbound_body_disposition", "inbound_body_retention_exceeded"]);
const NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}\.txt$/;

export function expiredBodyFiles(events) {
  return new Set(events.filter((row) => row.type === "inbound_body_expired" && typeof row.bodyFile === "string").map((row) => row.bodyFile));
}

function isSource(row) { return typeof row.bodyFile === "string" && typeof row.bodySha256 === "string" && !SELF.has(row.type); }

export function concludedState(events) {
  const concluded = new Set(); const processed = new Set(); const exceeded = new Set(); const skipped = new Set();
  for (const row of events) {
    if ((row.type === "peer_ack" || row.type === "peer_reply") && typeof row.messageId === "string") concluded.add(row.messageId.toLowerCase());
    if (row.type === "inbound_body_disposition" && row.disposition === "processed") processed.add(row.sourceSeq);
    if (row.type === "inbound_body_retention_exceeded") exceeded.add(row.sourceSeq);
    if (row.type === "inbound_body_expire_skipped") skipped.add(row.sourceSeq);
  }
  return { concluded, processed, exceeded, skipped };
}

export function isConcluded(row, state) {
  return (typeof row.messageId === "string" && state.concluded.has(row.messageId.toLowerCase())) || state.processed.has(row.seq);
}

// Digest check -> record -> unlink. Returns "expired" | "missing" | "skipped" | "ledger_append_failed".
async function deleteBody({ root, store, row, reason, skipped }) {
  const name = row.bodyFile.startsWith(`${INBOUND_DIRNAME}/`) ? row.bodyFile.slice(INBOUND_DIRNAME.length + 1) : null;
  if (!name || !NAME.test(name)) return "skipped";
  const file = path.join(root, INBOUND_DIRNAME, name);
  let bytes;
  try {
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > MAX_INBOUND_BODY_BYTES) throw Object.assign(new Error("not a private spool file"), { code: "NOT_PRIVATE" });
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    return (await skip(store, row, "unreadable", skipped)) ? "skipped" : "ledger_append_failed";
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== row.bodySha256) return (await skip(store, row, "digest_mismatch", skipped)) ? "skipped" : "ledger_append_failed";
  try {
    await store.append("inbound_body_expired", { sourceSeq: row.seq, bodyFile: row.bodyFile, bodySha256: digest, bodyBytes: bytes.byteLength, reason, ...(row.header ? { header: row.header } : {}) });
  } catch { return "ledger_append_failed"; }
  await fsp.unlink(file);
  return "expired";
}

async function skip(store, row, reason, skipped) {
  if (skipped.has(row.seq)) return true;
  try { await store.append("inbound_body_expire_skipped", { sourceSeq: row.seq, reason }); skipped.add(row.seq); return true; } catch { return false; }
}

export async function expireInboundBodies({ root, store, alerts = null, now = Date.now(), days = DEFAULT_BODY_RETENTION_DAYS, limit = 500 }) {
  const result = { expired: 0, skipped: 0, missing: 0, unprocessed: 0, newlyExceeded: 0, stoppedBy: null };
  if (!(days > 0)) return { ...result, disabled: true };
  const cutoff = now - days * 86_400_000;
  const done = expiredBodyFiles(store.events);
  const state = concludedState(store.events);
  let alerted = 0; let unalerted = 0;
  for (const row of store.events.slice()) {
    if (result.expired >= limit) break;
    if (!isSource(row) || done.has(row.bodyFile) || !(Date.parse(row.at) < cutoff)) continue;
    if (!isConcluded(row, state)) {
      result.unprocessed += 1;
      if (state.exceeded.has(row.seq)) continue;
      try { await store.append("inbound_body_retention_exceeded", { sourceSeq: row.seq, ...(typeof row.messageId === "string" ? { messageId: row.messageId } : {}), days }); }
      catch { result.stoppedBy = "ledger_append_failed"; return result; }
      state.exceeded.add(row.seq); result.newlyExceeded += 1;
      // One alarm per body. A first run over an old spool would otherwise put hundreds of
      // notifications on the Air; past the per-run cap the rest are one summary alarm, and every
      // body still has its own ledger row.
      if (alerts && alerted < EXCEEDED_ALERTS_PER_RUN) {
        alerted += 1;
        const id = typeof row.messageId === "string" ? row.messageId.toLowerCase() : `seq-${row.seq}`;
        try { await alerts.raise({ kind: "retention_unprocessed", key: `retention_unprocessed:${id}`, code: `seq-${row.seq}` }); } catch {}
      } else unalerted += 1;
      continue;
    }
    const outcome = await deleteBody({ root, store, row, reason: "retention", skipped: state.skipped });
    if (outcome === "ledger_append_failed") { result.stoppedBy = outcome; return result; }
    if (outcome === "expired") { done.add(row.bodyFile); result.expired += 1; }
    else if (outcome === "missing") result.missing += 1;
    else result.skipped += 1;
  }
  if (alerts && unalerted > 0) {
    try { await alerts.raise({ kind: "retention_unprocessed", key: `retention_unprocessed:batch:${new Date(now).toISOString().slice(0, 10)}`, code: String(unalerted) }); } catch {}
  }
  return result;
}

// The explicit procedure. "processed": the body's message is handled; it becomes eligible for the
// automatic expiry. "discard": delete now, whatever its age or state, through the same
// digest-check -> record -> unlink path, recorded as a disposition first.
export async function disposeInboundBody({ root, store, sourceSeq, disposition }) {
  if (!Number.isInteger(sourceSeq) || sourceSeq < 1) throw Object.assign(new Error("sourceSeq must be a positive integer"), { code: "INVALID_CONTROL_ARGUMENTS" });
  if (!["processed", "discard"].includes(disposition)) throw Object.assign(new Error("disposition must be processed or discard"), { code: "INVALID_CONTROL_ARGUMENTS" });
  const row = store.events.find((event) => event.seq === sourceSeq);
  if (!row || !isSource(row)) throw Object.assign(new Error("no spooled body at that seq"), { code: "BODY_UNKNOWN" });
  if (expiredBodyFiles(store.events).has(row.bodyFile)) return { disposition, state: "already_expired" };
  const prior = store.events.find((event) => event.type === "inbound_body_disposition" && event.sourceSeq === sourceSeq && event.disposition === disposition);
  if (!prior) await store.append("inbound_body_disposition", { sourceSeq, disposition, ...(typeof row.messageId === "string" ? { messageId: row.messageId } : {}) });
  if (disposition === "processed") return { disposition, state: "recorded" };
  const outcome = await deleteBody({ root, store, row, reason: "discarded", skipped: concludedState(store.events).skipped });
  return { disposition, state: outcome };
}
