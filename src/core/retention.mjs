import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_INBOUND_BODY_BYTES } from "./inbound-spool.mjs";
import { maskFirstLine } from "./mask.mjs";
import { INBOUND_DIRNAME } from "./state-paths.mjs";

// Spooled bodies are kept for `days` (default 30) and then deleted; the ledger row that named the
// file stays forever with its length, digest and masked first line. The order is the safety:
//
//   1. read the file and check its digest against the row that named it — a file that does not
//      match is not the body the row describes, and it is kept and reported, not deleted;
//   2. write `inbound_body_expired` (masked first line, digest, the source row's seq) — if the
//      ledger will not take the row, nothing is deleted;
//   3. only then unlink.
//
// `days <= 0` switches deletion off.
export const DEFAULT_BODY_RETENTION_DAYS = 30;
const SELF = new Set(["inbound_body_expired", "inbound_body_expire_skipped", "inbound_body_read"]);
const NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}\.txt$/;

export function expiredBodyFiles(events) {
  return new Set(events.filter((row) => row.type === "inbound_body_expired" && typeof row.bodyFile === "string").map((row) => row.bodyFile));
}

export async function expireInboundBodies({ root, store, now = Date.now(), days = DEFAULT_BODY_RETENTION_DAYS, limit = 500 }) {
  const result = { expired: 0, skipped: 0, missing: 0, stoppedBy: null };
  if (!(days > 0)) return { ...result, disabled: true };
  const cutoff = now - days * 86_400_000;
  const done = expiredBodyFiles(store.events);
  const skippedBefore = new Set(store.events.filter((row) => row.type === "inbound_body_expire_skipped").map((row) => row.sourceSeq));
  for (const row of store.events.slice()) {
    if (result.expired >= limit) break;
    // Only rows that spooled a body name one with its digest. Rows this module writes also carry
    // `bodyFile` and are never sources; a row with no digest cannot prove the file is its body, so
    // it never leads to a deletion.
    if (typeof row.bodyFile !== "string" || typeof row.bodySha256 !== "string" || SELF.has(row.type) || done.has(row.bodyFile)) continue;
    if (!(Date.parse(row.at) < cutoff)) continue;
    const name = row.bodyFile.startsWith(`${INBOUND_DIRNAME}/`) ? row.bodyFile.slice(INBOUND_DIRNAME.length + 1) : null;
    if (!name || !NAME.test(name)) continue;
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
      if (error.code === "ENOENT") { result.missing += 1; continue; }
      if (!skippedBefore.has(row.seq)) { try { await store.append("inbound_body_expire_skipped", { sourceSeq: row.seq, bodyFile: row.bodyFile, reason: "unreadable" }); skippedBefore.add(row.seq); } catch (e) { result.stoppedBy = "ledger_append_failed"; return result; } }
      result.skipped += 1; continue;
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== row.bodySha256) {
      if (!skippedBefore.has(row.seq)) { try { await store.append("inbound_body_expire_skipped", { sourceSeq: row.seq, bodyFile: row.bodyFile, reason: "digest_mismatch" }); skippedBefore.add(row.seq); } catch { result.stoppedBy = "ledger_append_failed"; return result; } }
      result.skipped += 1; continue;
    }
    let firstLine = null;
    try { firstLine = maskFirstLine(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {}
    try {
      await store.append("inbound_body_expired", { sourceSeq: row.seq, bodyFile: row.bodyFile, bodySha256: digest, bodyBytes: bytes.byteLength, ...(firstLine === null ? {} : { firstLine }) });
    } catch { result.stoppedBy = "ledger_append_failed"; return result; }
    await fsp.unlink(file);
    done.add(row.bodyFile); result.expired += 1;
  }
  return result;
}
