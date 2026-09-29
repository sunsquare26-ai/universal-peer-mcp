// The target table used to be read once, at startup, and reduced to a digest that never moved.
// Every call that can reach a target is refused unless the digest its caller checked equals the
// daemon's, and the caller reads the file per request — so the instant `targets.json` changed, every
// send was refused until the daemon was restarted. Repairing an alias by hand cost a restart, and
// the restart is what made leaving it broken cheaper than fixing it.
//
// These hold the new fixed point: the file as it is now, invalidated by content and not by size.
// A session id swapped for another session id is the same number of bytes written over the same
// bytes, which is exactly the rewrite a size-watching cache serves stale for ever, so the in-place
// case is here with its mtime put back as well.
import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { controlCall } from "../src/core/control.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { countChangedAliases, TargetTableWatch } from "../src/core/target-table.mjs";
import { atomicPrivateWrite } from "../src/core/state-paths.mjs";
import { targetTableDigest } from "../src/core/target-config.mjs";

const A = "aaaaaaaa-1111-4000-8000-000000000001";
const B = "bbbbbbbb-2222-4000-8000-000000000002";
const C = "cccccccc-3333-4000-8000-000000000003";

const roots = []; const daemons = [];
afterEach(async () => {
  for (const root of daemons.splice(0)) {
    try { await controlCall("daemon_shutdown", {}, { root }); } catch {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await fsp.lstat(statePaths(root).daemon); await Bun.sleep(25); } catch { break; }
    }
  }
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function stand() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-table-")));
  roots.push(root); await fsp.chmod(root, 0o700);
  return { root, paths: statePaths(root) };
}
const row = (root, sessionId) => ({ sessionId, cwd: root, permissionMode: "bypass" });
async function write(file, table) { await fsp.writeFile(file, `${JSON.stringify(table, null, 2)}\n`); await fsp.chmod(file, 0o600); }

test("R2 a table rewritten while the process runs is read on the next call", async () => {
  const it = await stand();
  const watch = new TargetTableWatch({ file: it.paths.targets });
  expect((await watch.read()).table).toEqual({});

  await write(it.paths.targets, { "friday-main": row(it.root, A) });
  const first = await watch.read();
  expect(first.changed).toBe(true); expect(first.digestChanged).toBe(true);
  expect(first.table["friday-main"].sessionId).toBe(A);
  expect(first.changedAliases).toBe(1);
  expect(first.digest).toBe(targetTableDigest(first.table));

  // Reading again without touching the file must not re-read or re-report it.
  expect((await watch.read()).changed).toBe(false);

  await write(it.paths.targets, { "friday-main": row(it.root, B), "erp": row(it.root, C) });
  const second = await watch.read();
  expect(second.digestChanged).toBe(true);
  expect(second.previousDigest).toBe(first.digest);
  expect(second.changedAliases).toBe(2);
  expect(Object.keys(second.table).sort()).toEqual(["erp", "friday-main"]);
});

test("R2 an in-place rewrite of the same byte count, inode and mtime is still seen", async () => {
  const it = await stand();
  await write(it.paths.targets, { "friday-main": row(it.root, A) });
  // Pinned to a whole millisecond before anything is measured. `fsp.utimes` stores whole
  // milliseconds and a freshly written file carries sub-millisecond precision, so "put the mtime
  // back" on an unpinned file moves it — ...283.505 becomes ...283 — and the invalidation this test
  // is about was being done by the mtime rather than by the content. Pinning first makes restoring
  // exact, and the assertions below compare the raw float the watch itself reads.
  const pinned = new Date(1_700_000_000_000);
  await fsp.utimes(it.paths.targets, pinned, pinned);

  const watch = new TargetTableWatch({ file: it.paths.targets });
  const before = await watch.read();
  expect(before.table["friday-main"].sessionId).toBe(A);

  const original = await fsp.stat(it.paths.targets);
  expect(original.mtimeMs).toBe(pinned.getTime());
  const text = await fsp.readFile(it.paths.targets, "utf8");
  const rewritten = text.replace(A, B);
  expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(text));

  // Over the same bytes, in place — not a temporary file and a rename, so the inode does not move
  // either — and then the modification time is put back where it was.
  const handle = await fsp.open(it.paths.targets, "r+");
  try { await handle.write(Buffer.from(rewritten), 0, Buffer.byteLength(rewritten), 0); } finally { await handle.close(); }
  await fsp.utimes(it.paths.targets, pinned, pinned);

  // Everything the watch looks at besides the content is identical, asserted on the same values it
  // reads and with no rounding applied to any of them. Whatever invalidates below, it is not these.
  const after = await fsp.stat(it.paths.targets);
  expect(after.ino).toBe(original.ino);
  expect(after.size).toBe(original.size);
  expect(after.mtimeMs).toBe(original.mtimeMs);
  expect(`${after.ino}:${after.size}:${after.mtimeMs}`).toBe(`${original.ino}:${original.size}:${original.mtimeMs}`);
  expect(await fsp.readFile(it.paths.targets, "utf8")).not.toBe(text);

  // So only the content hash can be doing this. Disable the sha256 component of the watch's
  // fingerprint and this assertion is the one that goes red — verified 2026-09-11 by running a copy
  // of src/core/target-table.mjs with the digest dropped from the fingerprint string.
  const reading = await watch.read();
  expect(reading.changed).toBe(true);
  expect(reading.digestChanged).toBe(true);
  expect(reading.table["friday-main"].sessionId).toBe(B);
});

// The name an atomic write gives its temporary file has to be unique among every temporary this
// process makes. It was a pid and a millisecond, and two writes in one millisecond collide on
// `O_EXCL` with EEXIST — reproduced 3 times in 3 attempts on the succession path, where the error
// arrived at the caller as an unrecognised failure and was read back as "no live session", the
// opposite of what had just been proven. Sixteen writes started together land inside one
// millisecond reliably; with the old name this is the assertion that goes red.
test("FIX2 concurrent atomic writes to one path do not collide on their temporary name", async () => {
  const it = await stand();
  const file = path.join(it.root, "contended.json");
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => atomicPrivateWrite(file, `${index}\n`)));
  const refused = results.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason?.code ?? outcome.reason?.message);
  expect(refused).toEqual([]);
  expect((await fsp.stat(file)).isFile()).toBe(true);
  // And nothing is left behind under the temporary suffix.
  expect((await fsp.readdir(it.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("R2 a table that cannot be parsed keeps the last good one and says so", async () => {
  const it = await stand();
  await write(it.paths.targets, { "friday-main": row(it.root, A) });
  const watch = new TargetTableWatch({ file: it.paths.targets });
  const good = await watch.read();

  await fsp.writeFile(it.paths.targets, "{ not json");
  const broken = await watch.read();
  expect(broken.unreadable).not.toBeNull();
  expect(broken.digestChanged).toBe(false);
  expect(broken.table["friday-main"].sessionId).toBe(A);
  expect(broken.digest).toBe(good.digest);

  await write(it.paths.targets, { "friday-main": row(it.root, B) });
  expect((await watch.read()).table["friday-main"].sessionId).toBe(B);
});

test("R2 reformatting a table changes its bytes and not its routing", async () => {
  const it = await stand();
  await write(it.paths.targets, { "friday-main": row(it.root, A) });
  const watch = new TargetTableWatch({ file: it.paths.targets });
  const before = await watch.read();
  await fsp.writeFile(it.paths.targets, `${JSON.stringify({ "friday-main": row(it.root, A) })}\n`);
  const after = await watch.read();
  expect(after.changed).toBe(true);
  expect(after.digestChanged).toBe(false);
  expect(after.digest).toBe(before.digest);
  expect(countChangedAliases(before.table, after.table)).toBe(0);
});

// The end-to-end half: a real daemon process, with a table written after it was already running.
// It comes up on no table on purpose — a daemon with targets publishes a receiver row into the
// account's live `~/.claude/sessions`, and a test has no business writing there.
test("R2 a running daemon answers with the table on disk, with no restart in between", async () => {
  const it = await stand();
  daemons.push(it.root);
  const empty = await controlCall("daemon_status", {}, { root: it.root });
  expect(empty.targetCount).toBe(0);

  await write(it.paths.targets, { "friday-main": row(it.root, A) });
  const populated = await controlCall("daemon_status", {}, { root: it.root });
  expect(populated.pid).toBe(empty.pid);
  expect(populated.procStart).toBe(empty.procStart);
  expect(populated.targetCount).toBe(1);
  expect(populated.targetsDigest).not.toBe(empty.targetsDigest);
  expect(populated.targetsDigest).toBe(targetTableDigest({ "friday-main": row(it.root, A) }));

  // The binding check moved with it: a command checked against the reading the daemon no longer
  // holds is refused, and one checked against the reading it does hold gets past the check.
  const bound = { daemonPid: populated.pid, daemonProcStart: populated.procStart };
  await expect(controlCall("peer_status", { alias: "friday-main" }, { root: it.root, expect: { ...bound, targetsDigest: empty.targetsDigest } }))
    .rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  // Past the check, into the resolver, which finds the id is not live and — this daemon has the
  // succession path wired — that nothing in the lane proves it resumed that id.
  await expect(controlCall("peer_status", { alias: "friday-main" }, { root: it.root, expect: { ...bound, targetsDigest: populated.targetsDigest } }))
    .rejects.toMatchObject({ diagnostic: "rebind_no_proof" });

  // And the reload is on the record: which reading replaced which, and how many aliases moved.
  const store = new EventStore(it.paths); await store.init();
  const reloaded = store.events.filter((event) => event.type === "target_table_reloaded");
  expect(reloaded).toHaveLength(1);
  expect(reloaded[0]).toMatchObject({ previousDigest: empty.targetsDigest, targetsDigest: populated.targetsDigest, targetCount: 1, changedAliases: 1 });
}, 30_000);
