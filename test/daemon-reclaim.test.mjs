// Reclaiming a state directory is the one operation here that deletes. Everything it deletes
// belongs to whoever holds the exclusive lock, so it has exactly two ways to be wrong: decide a
// running daemon is gone, or let go of the lock while it is still deleting. These tests are those
// two, plus the case it is actually for.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { reclaimDeadDaemon } from "../src/core/control.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const roots = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function stateDir(prefix) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(made);
  await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  return { root, paths: statePaths(root) };
}
function sleeper() { const child = spawn("sleep", ["45"], { stdio: "ignore" }); children.push(child); return child; }
async function gonePid() {
  const child = spawn("sleep", ["45"], { stdio: "ignore" });
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}
async function writePrivate(file, value) { await fsp.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600); }
const exists = (file) => fsp.lstat(file).then(() => true, () => false);

describe("a live pid is never treated as gone", () => {
  // The upgrade case. A daemon started by the build that wrote start times in the reader's local
  // zone is still running; this build renders that same instant differently, so the record it left
  // no longer matches. What that proves is that we cannot identify the process — not that it is
  // dead. Deleting its lock, socket, token and record here would let a second daemon stand up in
  // the same directory and append to the same ledger, and an append-only ledger with two writers
  // is not one ledger. So the doubt goes to a person.
  test("refuses a daemon record whose live pid renders a different start time, and deletes nothing", async () => {
    const { paths } = await stateDir("peer-reclaim-ambiguous-");
    const stranger = sleeper();
    await writePrivate(paths.daemon, { pid: stranger.pid, procStart: "Mon Sep 7 16:43:02 2026", socketPath: paths.controlSocket });
    await writePrivate(paths.daemonLock, { pid: stranger.pid, procStart: "Mon Sep 7 16:43:02 2026" });
    await writePrivate(paths.controlToken, "kept");
    await expect(reclaimDeadDaemon(paths)).rejects.toThrow("cleared by hand");
    expect(await exists(paths.daemon)).toBeTrue();
    expect(await exists(paths.daemonLock)).toBeTrue();
    expect(await exists(paths.controlToken)).toBeTrue();
    expect(() => process.kill(stranger.pid, 0)).not.toThrow();
  });

  test("refuses a lock whose live pid renders a different start time, and deletes nothing", async () => {
    const { paths } = await stateDir("peer-reclaim-ambiguous-lock-");
    const stranger = sleeper();
    await writePrivate(paths.daemonLock, { pid: stranger.pid, procStart: "Mon Sep 7 16:43:02 2026" });
    await writePrivate(paths.controlToken, "kept");
    await expect(reclaimDeadDaemon(paths)).rejects.toThrow("cleared by hand");
    expect(await exists(paths.daemonLock)).toBeTrue();
    expect(await exists(paths.controlToken)).toBeTrue();
  });

  test("refuses a record this build can authenticate, which is a daemon that is simply running", async () => {
    const { paths } = await stateDir("peer-reclaim-live-");
    const stranger = sleeper();
    await writePrivate(paths.daemon, { pid: stranger.pid, procStart: processStart(stranger.pid), socketPath: paths.controlSocket });
    await expect(reclaimDeadDaemon(paths)).rejects.toThrow("alive but could not be authenticated");
    expect(await exists(paths.daemon)).toBeTrue();
  });
});

describe("what reclaiming is for", () => {
  test("clears every artifact of a daemon whose pid is gone", async () => {
    const { paths } = await stateDir("peer-reclaim-gone-");
    const pid = await gonePid();
    await writePrivate(paths.daemon, { pid, procStart: "Mon Sep 7 07:43:02 2026", socketPath: paths.controlSocket });
    await writePrivate(paths.daemonLock, { pid, procStart: "Mon Sep 7 07:43:02 2026" });
    await writePrivate(paths.controlToken, "stale");
    await writePrivate(paths.controlSocket, "stale");
    await reclaimDeadDaemon(paths);
    for (const file of [paths.daemon, paths.daemonLock, paths.controlToken, paths.controlSocket]) expect(await exists(file)).toBeFalse();
  });

  test("leaves an untouched directory untouched, and takes no lock to do it", async () => {
    const { paths } = await stateDir("peer-reclaim-empty-");
    await reclaimDeadDaemon(paths);
    expect(await exists(paths.daemonLock)).toBeFalse();
  });
});

describe("the lock is held through the whole cleanup", () => {
  // The window. Reclaiming deletes four files, and between the first and the last a daemon can
  // start: it takes the lock, writes its token and its record, and the reclaimer — still working
  // from the list it made before — deletes them under it. The daemon stays up with no token and no
  // record, and the next caller reads an empty directory and starts a second one. So the lock is
  // taken first and released last, and nothing is deleted by anyone who does not hold it.
  test("a daemon that starts during a reclaim keeps the files it publishes", async () => {
    const { paths } = await stateDir("peer-reclaim-race-");
    const pid = await gonePid();
    await writePrivate(paths.daemon, { pid, procStart: "Mon Sep 7 07:43:02 2026", socketPath: paths.controlSocket });
    await writePrivate(paths.daemonLock, { pid, procStart: "Mon Sep 7 07:43:02 2026" });
    await writePrivate(paths.controlToken, "stale");
    await writePrivate(paths.controlSocket, "stale");

    const TOKEN = "competitor-token\n";
    let settled = false;
    const attempts = [];
    // A daemon starting up, doing exactly what src/daemon.mjs does in the same order: take the
    // lock with O_EXCL, then publish the token and the record. It spins on the lock from the first
    // turn of the loop, so it is present for every moment the reclaimer is not holding it.
    const competitor = (async () => {
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        let handle;
        try { handle = await fsp.open(paths.daemonLock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
        catch (error) { if (error.code !== "EEXIST") throw error; attempts.push({ won: false, settled }); continue; }
        const wonAfterReclaim = settled;
        attempts.push({ won: true, settled });
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, procStart: processStart() })}\n`);
        await handle.close();
        await fsp.writeFile(paths.controlToken, TOKEN, { mode: 0o600 });
        await writePrivate(paths.daemon, { pid: process.pid, procStart: processStart(), socketPath: paths.controlSocket, holder: "competitor" });
        return wonAfterReclaim;
      }
    })();

    const outcome = await reclaimDeadDaemon(paths).then(() => "reclaimed", (error) => error.message);
    settled = true;
    const wonAfterReclaim = await competitor;

    // Either the reclaimer held the lock for the whole cleanup and the daemon came up after it let
    // go, or the daemon took the lock first and the reclaimer stood down without deleting a thing.
    // There is no third outcome in which files were deleted by a process that did not hold the lock.
    if (outcome === "reclaimed") {
      expect(wonAfterReclaim).toBeTrue();
      expect(attempts.some((attempt) => !attempt.won && !attempt.settled)).toBeTrue();
    } else {
      expect(outcome).toContain("daemon lock");
    }
    expect(await fsp.readFile(paths.controlToken, "utf8")).toBe(TOKEN);
    expect(JSON.parse(await fsp.readFile(paths.daemon, "utf8")).holder).toBe("competitor");
  });
});
