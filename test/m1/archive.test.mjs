import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { archiveClosedDays, readArchivedRows, verifyArchive, archiveNames } from "../../src/core/archive.mjs";
import { backupArchives } from "../../src/core/backup.mjs";
import { ledger, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const rows = ledger([
  ["daemon_started", "2026-09-27T14:59:00.000Z", {}], // 09-27 KST
  ["send_requested", "2026-09-27T15:00:00.000Z", {}], // 09-28 KST
  ["peer_ack", "2026-09-28T10:00:00.000Z", {}],       // 09-28 KST
  ["send_requested", "2026-09-28T15:30:00.000Z", {}]  // 09-29 KST = today
]);
const NOW = Date.parse("2026-09-29T03:00:00.000Z");

test("closed days only, one copy each, manifest last, ledger rows untouched", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive");
  const before = JSON.stringify(rows);
  const { written, late } = await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  expect(written.map((m) => [m.day, m.firstSeq, m.lastSeq, m.rows])).toEqual([["2026-09-27", 1, 1, 1], ["2026-09-28", 2, 3, 2]]);
  expect(late).toEqual([]);
  expect(JSON.stringify(rows)).toBe(before);
  expect((await fsp.readdir(dir)).sort()).toEqual(["events-2026-09-27.jsonl.gz", "events-2026-09-27.manifest.json", "events-2026-09-28.jsonl.gz", "events-2026-09-28.manifest.json"]);
  for (const name of await fsp.readdir(dir)) expect((await fsp.stat(path.join(dir, name))).mode & 0o077).toBe(0);
  const checked = await verifyArchive(dir, "2026-09-28");
  expect(checked.ok).toBe(true); expect(checked.rows).toEqual(rows.slice(1, 3));
  // Idempotent: a second run writes nothing.
  expect((await archiveClosedDays({ directory: dir, events: rows, now: NOW })).written).toEqual([]);
  // Restoring from copies gives the closed rows back in order.
  expect(await readArchivedRows(dir)).toEqual(rows.slice(0, 3));
});

test("a row that lands in an already closed day is reported, and the closed copy is not rewritten", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive");
  await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  const gz = await fsp.readFile(path.join(dir, archiveNames("2026-09-28").data));
  const stepped = [...rows, { seq: 5, type: "peer_ack", at: "2026-09-28T11:00:00.000Z" }];
  const { written, late } = await archiveClosedDays({ directory: dir, events: stepped, now: NOW });
  expect(written).toEqual([]); expect(late).toEqual([{ day: "2026-09-28", seqs: [5] }]);
  expect(Buffer.compare(gz, await fsp.readFile(path.join(dir, archiveNames("2026-09-28").data)))).toBe(0);
});

test("a tampered copy fails verification", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive");
  await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  const file = path.join(dir, archiveNames("2026-09-27").data);
  const bytes = await fsp.readFile(file); bytes[bytes.length - 5] ^= 1; await fsp.writeFile(file, bytes);
  expect((await verifyArchive(dir, "2026-09-27")).ok).toBe(false);
  await expect(readArchivedRows(dir)).rejects.toThrow();
});

test("backup to a local directory copies verified archives, keeps existing files, reports conflicts", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive"); const dest = path.join(root, "disk");
  await fsp.mkdir(dest, { mode: 0o700 });
  await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  expect(await backupArchives({ directory: dir, destination: dest })).toMatchObject({ configured: true, copied: 4, invalid: [], conflicts: [] });
  expect(await backupArchives({ directory: dir, destination: dest })).toMatchObject({ copied: 0, conflicts: [] });
  await fsp.writeFile(path.join(dest, archiveNames("2026-09-27").manifest), "other");
  expect((await backupArchives({ directory: dir, destination: dest })).conflicts).toEqual([archiveNames("2026-09-27").manifest]);
  expect(await fsp.readFile(path.join(dest, archiveNames("2026-09-27").manifest), "utf8")).toBe("other");
});

test("backup to a missing disk is reported, not created", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive");
  await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  expect((await backupArchives({ directory: dir, destination: path.join(root, "Volumes-not-mounted") })).error).toBe("DESTINATION_MISSING");
});

test("backup over SSH is one rsync with a fixed argv that never replaces a file", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive");
  await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  const calls = [];
  const result = await backupArchives({ directory: dir, destination: "hyungseoklee@air:/Users/hyungseoklee/peer-archive", exec: async (...a) => { calls.push(a); return { stdout: "" }; } });
  expect(result).toMatchObject({ remote: true, copied: 4 });
  const [cmd, argv, opts] = calls[0];
  expect(cmd).toBe("/usr/bin/rsync");
  expect(argv.slice(0, 5)).toEqual(["-a", "--ignore-existing", "--chmod=F600,D700", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes"]);
  expect(argv.at(-1)).toBe("hyungseoklee@air:/Users/hyungseoklee/peer-archive/");
  expect(opts.shell).toBeUndefined();
  await expect(backupArchives({ directory: dir, destination: "air:/tmp;rm -rf ~" })).rejects.toThrow();
});

test("a sleeping Air fails this run and the next run sends every archive again", async () => {
  const root = await tempRoot(); roots.push(root); const dir = path.join(root, "archive");
  await archiveClosedDays({ directory: dir, events: rows, now: NOW });
  let asleep = true; const calls = [];
  const exec = async (cmd, argv) => { calls.push(argv); if (asleep) throw Object.assign(new Error("ssh: connect timed out"), { code: 255 }); return { stdout: "" }; };
  const first = await backupArchives({ directory: dir, destination: "hyungseoklee@macbookair.tail72dd63.ts.net:/Users/hyungseoklee/universal-peer-archive", exec });
  expect(first).toMatchObject({ remote: true, copied: 0, error: "255" });
  asleep = false;
  const second = await backupArchives({ directory: dir, destination: "hyungseoklee@macbookair.tail72dd63.ts.net:/Users/hyungseoklee/universal-peer-archive", exec });
  expect(second).toMatchObject({ remote: true, copied: 4 });
  expect(calls[1].filter((a) => a.endsWith(".gz") || a.endsWith(".json"))).toHaveLength(4);
});
