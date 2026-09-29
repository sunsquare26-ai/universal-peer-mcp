import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import { AlertSink } from "../../src/core/alerts.mjs";
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { runMaintenance } from "../../src/core/maintenance.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { openStore, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const DAY = 86_400_000;

async function stand() {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  await store.append("daemon_started", {});
  const spooled = await new InboundSpool(statePaths(root)).write("PEER_POST v=1\n본문");
  await store.append("peer_frame_uncorrelated", { reason: "no_reply_marker", ...spooled });
  const alerts = new AlertSink({ file: path.join(root, "alerts.jsonl") });
  return { root, store, alerts, ledgerBytes: await fsp.readFile(statePaths(root).events) };
}

test("a day later: the closed day is copied and recorded, the ledger only grows, no body is expired yet", async () => {
  const s = await stand();
  const report = await runMaintenance({ root: s.root, store: s.store, alerts: s.alerts, now: Date.now() + DAY, config: { retentionDays: 30, backupDestination: null } });
  expect(report.archived).toHaveLength(1); expect(report.errors).toEqual([]);
  expect(report.expiry.expired).toBe(0);
  const after = await fsp.readFile(statePaths(s.root).events);
  expect(Buffer.compare(after.subarray(0, s.ledgerBytes.length), s.ledgerBytes)).toBe(0);
  expect(s.store.events.at(-1)).toMatchObject({ type: "ledger_archived", firstSeq: 1, lastSeq: 2, rows: 2 });
});

test("31 days later with a backup disk: copy, expire, back up", async () => {
  const s = await stand(); const disk = path.join(s.root, "disk"); await fsp.mkdir(disk, { mode: 0o700 });
  const report = await runMaintenance({ root: s.root, store: s.store, alerts: s.alerts, now: Date.now() + 31 * DAY, config: { retentionDays: 30, backupDestination: disk } });
  expect(report.expiry.expired).toBe(1);
  expect(report.backup).toMatchObject({ configured: true, copied: 2 });
  expect((await fsp.readdir(disk)).length).toBe(2);
});

test("a backup that fails raises one alarm and does not stop the copy", async () => {
  const s = await stand();
  const report = await runMaintenance({ root: s.root, store: s.store, alerts: s.alerts, now: Date.now() + DAY, config: { retentionDays: 30, backupDestination: path.join(s.root, "not-mounted") } });
  expect(report.archived).toHaveLength(1);
  const alerts = (await fsp.readFile(path.join(s.root, "alerts.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(alerts.map((a) => [a.kind, a.code])).toEqual([["backup_failed", "DESTINATION_MISSING"]]);
});

test("a dead ledger: archive step fails and alarms, nothing is expired", async () => {
  const s = await stand();
  await fsp.chmod(statePaths(s.root).events, 0o400);
  const report = await runMaintenance({ root: s.root, store: s.store, alerts: s.alerts, now: Date.now() + 31 * DAY, config: { retentionDays: 30, backupDestination: null } });
  await fsp.chmod(statePaths(s.root).events, 0o600);
  expect(report.errors.map((e) => e.step)).toEqual(["archive"]);
  expect(report.expiry).toBeNull();
  expect((await fsp.readdir(path.join(s.root, "inbound"))).length).toBe(1);
});
