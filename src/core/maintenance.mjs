import path from "node:path";
import { archiveClosedDays } from "./archive.mjs";
import { backupArchives } from "./backup.mjs";
import { DEFAULT_BODY_RETENTION_DAYS, expireInboundBodies } from "./retention.mjs";
import { sweepOrphanBodies } from "./orphans.mjs";

// The daily housekeeping the daemon runs (hourly check, work only when a day has closed):
// closed copies first, then the body expiry, then the off-machine backup. It never touches the
// send path. Each step's failure is an alarm and does not stop the next unless it must: expiry
// runs only after the day's copy exists, and nothing is deleted if the ledger will not record it.
export const ARCHIVE_DIRNAME = "archive";
export const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export function maintenanceConfig(env = process.env) {
  const raw = env.UNIVERSAL_PEER_BODY_RETENTION_DAYS;
  const days = raw === undefined || raw === "" ? DEFAULT_BODY_RETENTION_DAYS : Number(raw);
  return {
    retentionDays: Number.isFinite(days) ? days : DEFAULT_BODY_RETENTION_DAYS,
    backupDestination: env.UNIVERSAL_PEER_ARCHIVE_BACKUP || null
  };
}

export async function runMaintenance({ root, store, alerts, now = Date.now(), config = maintenanceConfig(), backup = backupArchives }) {
  const directory = path.join(root, ARCHIVE_DIRNAME);
  const report = { at: new Date(now).toISOString(), archived: [], late: [], expiry: null, backup: null, errors: [] };
  const alarm = async (kind, key, code) => { try { await alerts?.raise({ kind, key, code }); } catch {} };
  let archiveOk = false;
  try {
    const { written, late } = await archiveClosedDays({ directory, events: store.events, now });
    for (const manifest of written) {
      await store.append("ledger_archived", { day: manifest.day, firstSeq: manifest.firstSeq, lastSeq: manifest.lastSeq, rows: manifest.rows, sha256: manifest.sha256, gzSha256: manifest.gzSha256 });
      report.archived.push(manifest.day);
    }
    for (const item of late) { report.late.push(item.day); await alarm("archive_late_rows", `archive_late_rows:${item.day}`, String(item.seqs.length)); }
    archiveOk = true;
  } catch (error) {
    report.errors.push({ step: "archive", code: codeOf(error) });
    await alarm("archive_failed", `archive_failed:${report.at.slice(0, 10)}`, codeOf(error));
  }
  if (archiveOk) {
    try {
      report.expiry = await expireInboundBodies({ root, store, alerts, now, days: config.retentionDays });
      if (report.expiry.stoppedBy) await alarm("retention_stopped", `retention_stopped:${report.at.slice(0, 10)}`, report.expiry.stoppedBy);
    } catch (error) { report.errors.push({ step: "expiry", code: codeOf(error) }); await alarm("retention_stopped", `retention_stopped:${report.at.slice(0, 10)}`, codeOf(error)); }
  }
  try { report.orphans = await sweepOrphanBodies({ root, store, alerts, now }); }
  catch (error) { report.errors.push({ step: "orphans", code: codeOf(error) }); }
  if (config.backupDestination) {
    try {
      report.backup = await backup({ directory, destination: config.backupDestination });
      if (report.backup.error || report.backup.invalid?.length || report.backup.conflicts?.length) await alarm("backup_failed", `backup_failed:${report.at.slice(0, 10)}`, report.backup.error ?? (report.backup.invalid?.length ? "ARCHIVE_INVALID" : "DESTINATION_CONFLICT"));
    } catch (error) { report.errors.push({ step: "backup", code: codeOf(error) }); await alarm("backup_failed", `backup_failed:${report.at.slice(0, 10)}`, codeOf(error)); }
  } else report.backup = { configured: false };
  return report;
}

function codeOf(error) { return typeof error?.code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : "FAILED"; }
