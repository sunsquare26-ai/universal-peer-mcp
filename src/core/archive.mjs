import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { dayOf, DAY_OFFSET_MINUTES } from "./days.mjs";
import { atomicPrivateWrite, ensurePrivateDirectory } from "./state-paths.mjs";

// A closed copy of each finished day, beside the ledger and never instead of it.
//
// The ledger cannot be shortened: `EventStore.init` requires seq to run from 1 without a gap and
// refuses to start otherwise, and it refuses a file over 64 MiB. So nothing here deletes, rewrites
// or truncates `events.jsonl`, and there is no `baseSeq` yet; cutting the front of the ledger is a
// later change that needs a reader which understands a base and a recovery test from these copies.
//
// A day is closed when it is before today (Korea time). Its copy is the rows whose `at` falls in
// it, gzipped, plus a manifest written last: a manifest is the commit marker, so a crash between
// the two leaves a copy that is simply made again, never a manifest that names a missing file.
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const archiveNames = (day) => ({ data: `events-${day}.jsonl.gz`, manifest: `events-${day}.manifest.json` });

export async function readManifests(directory) {
  let names = [];
  try { names = await fsp.readdir(directory); } catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
  const out = new Map();
  for (const name of names) {
    const match = /^events-(\d{4}-\d{2}-\d{2})\.manifest\.json$/.exec(name);
    if (!match) continue;
    out.set(match[1], JSON.parse(await fsp.readFile(path.join(directory, name), "utf8")));
  }
  return out;
}

export async function archiveClosedDays({ directory, events, now = Date.now(), offsetMinutes = DAY_OFFSET_MINUTES }) {
  const today = dayOf(now, offsetMinutes);
  const byDay = new Map();
  for (const row of events) {
    const day = dayOf(row.at, offsetMinutes);
    if (!day || day >= today) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  await ensurePrivateDirectory(directory);
  const manifests = await readManifests(directory);
  const written = []; const late = [];
  for (const [day, rows] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const existing = manifests.get(day);
    if (existing) {
      // A row that lands in a day after that day was closed means the clock stepped back. It is not
      // added to the closed copy (that would change a file a backup already holds); it is reported.
      const extra = rows.filter((row) => row.seq > existing.lastSeq);
      if (extra.length) late.push({ day, seqs: extra.map((row) => row.seq) });
      continue;
    }
    const jsonl = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const gz = zlib.gzipSync(jsonl, { level: 9 });
    const names = archiveNames(day);
    await atomicPrivateWrite(path.join(directory, names.data), gz);
    const manifest = { schema: "universal-peer.archive/1", day, offsetMinutes, rows: rows.length, firstSeq: rows[0].seq, lastSeq: rows.at(-1).seq, sha256: sha256(jsonl), gzSha256: sha256(gz), gzBytes: gz.byteLength, createdAt: new Date(now).toISOString() };
    await atomicPrivateWrite(path.join(directory, names.manifest), `${JSON.stringify(manifest)}\n`);
    written.push(manifest);
  }
  return { written, late };
}

// Re-read one closed copy and check it against its manifest: the gzip digest, the content digest,
// the row count and that seq increases. Used by the backup step before it copies and by tests.
export async function verifyArchive(directory, day) {
  if (!DAY.test(day)) throw new Error("day must be YYYY-MM-DD");
  const names = archiveNames(day);
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, names.manifest), "utf8"));
  const gz = await fsp.readFile(path.join(directory, names.data));
  if (sha256(gz) !== manifest.gzSha256) return { ok: false, reason: "gz_digest_mismatch" };
  const jsonl = zlib.gunzipSync(gz);
  if (sha256(jsonl) !== manifest.sha256) return { ok: false, reason: "content_digest_mismatch" };
  const rows = jsonl.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (rows.length !== manifest.rows) return { ok: false, reason: "row_count_mismatch" };
  for (let i = 1; i < rows.length; i += 1) if (!(rows[i].seq > rows[i - 1].seq)) return { ok: false, reason: "seq_not_increasing" };
  return { ok: true, manifest, rows };
}

// Rows for a seq range read back from closed copies, for the day the active ledger no longer
// starts at seq 1. Today it always does, so trace reads the active ledger; this exists so the
// restore path is tested before anything is ever cut.
export async function readArchivedRows(directory) {
  const manifests = await readManifests(directory);
  const out = [];
  for (const day of [...manifests.keys()].sort()) {
    const checked = await verifyArchive(directory, day);
    if (!checked.ok) throw Object.assign(new Error(`archive ${day} failed verification`), { code: "ARCHIVE_INVALID", reason: checked.reason });
    out.push(...checked.rows);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
