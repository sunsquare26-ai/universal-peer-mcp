// Why 192 green tests never saw this. Every identity fixture in the suite hands one literal to
// both sides of the comparison — test/registry.test.mjs writes "fixture-start" into the registry
// row and then answers the start-time read with that same string — and the end to end stand-in
// renders its registry row with a copy of the reader the product uses, so both sides agreed by
// construction. No test ever put a value rendered by one clock against a value rendered by
// another, and that is the only shape the defect has: Claude Code records the UTC rendering of a
// process start time and `ps` renders the reader's local zone, so on any machine that is not on
// UTC every candidate was discarded and no session ever resolved. The second half is padding:
// `ps` pads a single digit day to two columns ("Mon Sep  7"), the product squeezed that on the
// value it read and not on the value it had been given, so days 1 through 9 stayed broken even
// once the zone matched.
//
// These tests are the missing shape. Each one reads one side and writes the other.
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { normalizeProcStart, processIdentity, processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { resolveTarget } from "../src/adapters/claude-native-v1/registry.mjs";
import { ensureDaemon } from "../src/core/control.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const cleanups = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch {} }
  for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch {} }
});

// The two renderings of one fact, produced the way the two sides of the real system produce
// them: Claude Code records the UTC one with its padding intact, `ps` on this machine renders
// the local one. Neither goes through the code under test.
function renderedInZone(pid, zone) {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: zone } }).trim();
}
function withZone(zone, body) {
  const before = process.env.TZ;
  try { process.env.TZ = zone; return body(); }
  finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}
function sleeper() {
  const child = spawn("sleep", ["45"], { stdio: "ignore" });
  children.push(child);
  return child;
}

// A sessions directory holding one registry row for a pid that is really running, with the
// private socket and private key file the adapter demands. Only argv is stubbed: this process
// was not started with --permission-mode and the proof reads argv for real.
async function sessions({ pid = process.pid, recordedStart, keyStart, ...overrides } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-procstart-"));
  cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
  const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); const cwd = path.join(root, "project");
  await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(cwd);
  const socketPath = path.join(root, "target.sock");
  const server = net.createServer(); await new Promise((resolve) => server.listen(socketPath, resolve));
  await fsp.chmod(socketPath, 0o600);
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const row = {
    pid, sessionId: "10000000-0000-4000-8000-000000000031", cwd, procStart: recordedStart,
    peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"],
    messagingSocketPath: socketPath, name: "Claude"
  };
  await fsp.writeFile(path.join(sessionsDir, `${pid}.json`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const keyPath = path.join(sessionsDir, `${pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await fsp.writeFile(keyPath, `${JSON.stringify({ procStart: keyStart ?? recordedStart, peerToken: "a".repeat(32) })}\n`, { mode: 0o600 });
  const expected = { sessionId: row.sessionId, cwd, expectedDisplayName: null, permissionMode: "prompting" };
  const options = { sessionsDir, argvReader: () => ["/opt/bin/claude", "--permission-mode", "default"], ...overrides };
  return { expected, options, row, socketPath };
}

describe("the squeeze itself", () => {
  test("takes the renderer's padding out and leaves the start time in", () => {
    expect(normalizeProcStart("Mon Sep  7 07:43:02 2026")).toBe("Mon Sep 7 07:43:02 2026");
    expect(normalizeProcStart("  Mon Sep  7 07:43:02 2026   \n")).toBe("Mon Sep 7 07:43:02 2026");
    expect(normalizeProcStart("Mon Sep 17 07:43:02 2026")).toBe("Mon Sep 17 07:43:02 2026");
    expect(normalizeProcStart(normalizeProcStart("Mon Sep  7 07:43:02 2026"))).toBe(normalizeProcStart("Mon Sep  7 07:43:02 2026"));
    expect(normalizeProcStart("Mon Sep  7 07:43:02 2026")).not.toBe(normalizeProcStart("Mon Sep  7 07:43:03 2026"));
    expect(normalizeProcStart("Mon Sep  7 07:43:02 2026")).not.toBe(normalizeProcStart("Mon Sep  7 16:43:02 2026"));
  });

  // A registry row is a file, and a file can hold anything. Only a string is a rendering.
  test("never turns something that is not a rendering into one", () => {
    const rendered = normalizeProcStart("Mon Sep 7 07:43:02 2026");
    for (const value of [["Mon Sep 7 07:43:02 2026"], { toString: () => "Mon Sep 7 07:43:02 2026" }, 20260907, null, undefined, true]) {
      expect(normalizeProcStart(value)).not.toBe(rendered);
    }
  });
});

describe("one process start time, one rendering", () => {
  // The reader's own zone is not part of the fact. Before the fix this returned Seoul time on a
  // Seoul machine and New York time on a New York machine, and the recorded UTC value matched
  // neither.
  test("the start time read is the same string in every zone the reader sits in", () => {
    const seoul = withZone("Asia/Seoul", () => processStart(process.pid));
    const newYork = withZone("America/New_York", () => processStart(process.pid));
    const utc = withZone("UTC", () => processStart(process.pid));
    expect(seoul).toBe(utc);
    expect(newYork).toBe(utc);
    expect(utc).toBe(renderedInZone(process.pid, "UTC").replace(/\s+/g, " "));
  });

  // The receiver reads an identity for every frame through this one, so it has to answer the
  // same string as the resolver did.
  test("the per-frame identity read agrees with the resolver's read, in every zone", () => {
    const seoul = withZone("Asia/Seoul", () => processIdentity(process.pid));
    const utc = withZone("UTC", () => processIdentity(process.pid));
    expect(seoul.procStart).toBe(utc.procStart);
    expect(seoul.procStart).toBe(processStart(process.pid));
    expect(seoul.uid).toBe(process.getuid());
  });
});

describe("a target recorded by one process and read by another", () => {
  // The reproduction. The registry row carries exactly what Claude Code writes — the UTC
  // rendering, padding untouched — and every reader is the real one.
  test("resolves a live session whose row was recorded in UTC while the reader sits in Seoul", async () => {
    const item = await sessions({ recordedStart: renderedInZone(process.pid, "UTC") });
    const target = await withZone("Asia/Seoul", () => resolveTarget(item.expected, item.options));
    expect(target.pid).toBe(process.pid);
    expect(target.procStart).toBe(processStart(process.pid));
    expect(target.permission).toEqual({ mode: "prompting", verifiedBy: "kern_procargs2" });
  });

  // Days 1 through 9 are padded to two columns by `ps`. This one does not depend on today's
  // date: it is the padded string against the squeezed one, which is what the two sides hold.
  test("resolves when the recorded day is padded and the read day is not", async () => {
    const padded = "Mon Sep  7 07:43:02 2026";
    const squeezed = "Mon Sep 7 07:43:02 2026";
    expect(padded).not.toBe(squeezed);
    const item = await sessions({
      pid: 4321, recordedStart: padded,
      processUidReader: () => process.getuid(), processStartReader: () => squeezed
    });
    const target = await resolveTarget(item.expected, item.options);
    expect(target.pid).toBe(4321);
    expect(target.procStart).toBe(squeezed);
  });

  // The key file and the registry row are two files written by the same process; padding is the
  // writer's, the start time is the fact.
  test("accepts a key file whose padding differs from the row's", async () => {
    const item = await sessions({
      pid: 4321, recordedStart: "Mon Sep  7 07:43:02 2026", keyStart: "Mon Sep 7 07:43:02 2026",
      processUidReader: () => process.getuid(), processStartReader: () => "Mon Sep  7 07:43:02 2026"
    });
    await expect(resolveTarget(item.expected, item.options)).resolves.toMatchObject({ pid: 4321 });
  });
});

describe("padding is forgiven, the start time is not", () => {
  // The zones are not converted, only pinned. A row recorded in local time is a row about a
  // different instant than the one the reader answers with, and it is still refused — this is
  // the test that would fail if the fix had been to stop comparing.
  test("refuses a row recorded in another zone than the one the reader is pinned to", async () => {
    const item = await sessions({
      pid: 4321, recordedStart: "Mon Sep  7 16:43:02 2026",
      processUidReader: () => process.getuid(), processStartReader: () => "Mon Sep 7 07:43:02 2026"
    });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live");
  });

  test("refuses a start time one second off, and a reused pid", async () => {
    let item = await sessions({
      pid: 4321, recordedStart: "Mon Sep  7 07:43:03 2026",
      processUidReader: () => process.getuid(), processStartReader: () => "Mon Sep 7 07:43:02 2026"
    });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live");
    item = await sessions({
      pid: 4321, recordedStart: "Mon Sep  7 07:43:02 2026",
      processUidReader: () => process.getuid(), processStartReader: () => "Tue Sep 8 07:43:02 2026"
    });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live");
  });

  test("refuses a key file that names a different start time than the row", async () => {
    const item = await sessions({
      pid: 4321, recordedStart: "Mon Sep  7 07:43:02 2026", keyStart: "Mon Sep  7 07:43:03 2026",
      processUidReader: () => process.getuid(), processStartReader: () => "Mon Sep 7 07:43:02 2026"
    });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("key identity mismatch");
  });

  // A start time is a string a process renders. A row that carries something else is not a row
  // about a process, and coercing it must not make it look like one.
  test("refuses a row whose start time is not a string", async () => {
    for (const recordedStart of [["Mon Sep 7 07:43:02 2026"], 20260907, null, { toString: () => "Mon Sep 7 07:43:02 2026" }]) {
      const item = await sessions({
        pid: 4321, recordedStart,
        processUidReader: () => process.getuid(), processStartReader: () => "Mon Sep 7 07:43:02 2026"
      });
      await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live");
    }
  });
});

describe("state written before the rendering was pinned", () => {
  // Upgrading leaves a daemon.json and a daemon.lock holding a local-time start, and the daemon
  // that wrote them may still be running. This build renders that instant differently, so it
  // cannot match the record — which tells it that it cannot identify the process, not that the
  // process is gone. Clearing those files would let a second daemon stand up beside the first in
  // the same directory, both appending to one ledger. So the upgrade stops here and says so.
  test("refuses a daemon record left in the old rendering instead of clearing it under a live daemon", async () => {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-procstart-daemon-"));
    cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
    await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
    const stranger = sleeper();
    const oldRendering = renderedInZone(stranger.pid, "Asia/Seoul").replace(/\s+/g, " ");  // what the pre-fix build wrote here
    expect(oldRendering).not.toBe(processStart(stranger.pid));
    await fsp.writeFile(paths.daemon, `${JSON.stringify({ pid: stranger.pid, procStart: oldRendering, socketPath: paths.controlSocket })}\n`, { mode: 0o600 });
    await fsp.writeFile(paths.daemonLock, `${JSON.stringify({ pid: stranger.pid, procStart: oldRendering })}\n`, { mode: 0o600 });

    await expect(ensureDaemon({ root })).rejects.toThrow("cleared by hand");
    expect(await Bun.file(paths.daemon).exists()).toBeTrue();
    expect(await Bun.file(paths.daemonLock).exists()).toBeTrue();
    expect(stranger.exitCode).toBe(null);
    expect(() => process.kill(stranger.pid, 0)).not.toThrow();
  });

  // And once the pid really is gone, the same old rendering is just an old file.
  test("clears the same record once the process behind it has exited", async () => {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-procstart-daemon-gone-"));
    cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
    await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
    const stranger = sleeper();
    const oldRendering = renderedInZone(stranger.pid, "Asia/Seoul").replace(/\s+/g, " ");
    await fsp.writeFile(paths.daemon, `${JSON.stringify({ pid: stranger.pid, procStart: oldRendering, socketPath: paths.controlSocket })}\n`, { mode: 0o600 });
    await fsp.writeFile(paths.daemonLock, `${JSON.stringify({ pid: stranger.pid, procStart: oldRendering })}\n`, { mode: 0o600 });
    stranger.kill("SIGKILL"); await new Promise((resolve) => stranger.once("exit", resolve));

    const daemon = await ensureDaemon({ root });
    cleanups.push(async () => { try { process.kill(daemon.pid, "SIGTERM"); } catch {} });
    expect(daemon.pid).not.toBe(stranger.pid);
    expect(daemon.procStart).toBe(processStart(daemon.pid));
  });

  // The other direction, and the one that must never bend: a record this build can authenticate
  // names a live process, and a live process is never treated as gone.
  test("refuses to reclaim a record that still names a live process", async () => {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-procstart-live-"));
    cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
    await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
    const stranger = sleeper();
    await fsp.writeFile(paths.daemon, `${JSON.stringify({ pid: stranger.pid, procStart: processStart(stranger.pid), socketPath: paths.controlSocket })}\n`, { mode: 0o600 });
    await expect(ensureDaemon({ root })).rejects.toThrow("alive but could not be authenticated");
    expect(() => process.kill(stranger.pid, 0)).not.toThrow();
  });
});
