import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { test } from "bun:test";

import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { receiverOptionsForState, receiverSocketPath, reclaimStaleRegistrations, startReceiver } from "../src/adapters/claude-native-v1/receiver.mjs";
import { SENDER_PRODUCT_NAME } from "../src/adapters/claude-native-v1/protocol.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { EventStore } from "../src/core/events.mjs";
import { settleAllWithin } from "../src/core/wait.mjs";

// Every directory this file uses is created here and removed here. AF_UNIX paths are short on
// macOS, so the socket directory has to sit directly under /tmp; the prefix is this file's own so
// the leftovers of a crashed run are identifiable, and `cleanup` removes them on the way out.
const temporaryDirectories = new Set();
async function fixture() {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "upm-lcd26-"));
  const socketDir = await fsp.mkdtemp("/tmp/upm-lcv26-");
  temporaryDirectories.add(root); temporaryDirectories.add(socketDir);
  const sessionsDir = path.join(root, "sessions");
  const stateRoot = path.join(root, "state");
  await Promise.all([sessionsDir, stateRoot].map((directory) => fsp.mkdir(directory, { mode: 0o700 })));
  await fsp.chmod(socketDir, 0o700);
  return { root, sessionsDir, socketDir, stateRoot };
}
// A state root short enough to hold an AF_UNIX path. `fixture()` puts its root under
// `os.tmpdir()`, which on macOS is a ~50-character private path — fine for a socket directory
// passed in separately, but the daemon's control socket lives *inside* the state root, and
// `/var/folders/.../T/upm-lcd26-XXXXXX/state/control.sock` is close enough to the 104-byte
// sun_path limit to be a coin toss. These go directly under /private/tmp instead. Not `/tmp`:
// that is a symlink on macOS and `ensurePrivateDirectory` refuses a root that traverses one.
async function shortRootFixture() {
  const root = await fsp.mkdtemp("/private/tmp/upm-lcu26-");
  const socketDir = await fsp.mkdtemp("/private/tmp/upm-lct26-");
  temporaryDirectories.add(root); temporaryDirectories.add(socketDir);
  const sessionsDir = path.join(root, "sessions");
  const stateRoot = path.join(root, "state");
  await Promise.all([sessionsDir, stateRoot].map((directory) => fsp.mkdir(directory, { mode: 0o700 })));
  await fsp.chmod(root, 0o700); await fsp.chmod(socketDir, 0o700);
  return { root, sessionsDir, socketDir, stateRoot };
}

async function cleanup(paths) {
  await fsp.chmod(paths.sessionsDir, 0o700).catch(() => {});
  for (const directory of [paths.root, paths.socketDir]) {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    temporaryDirectories.delete(directory);
  }
}

function artifacts({ sessionsDir, socketDir, stateRoot }, pid) {
  const socketPath = receiverSocketPath(stateRoot, socketDir);
  const keyName = `${pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`;
  return { socketPath, registryPath: path.join(sessionsDir, `${pid}.json`), keyPath: path.join(sessionsDir, keyName) };
}

// The identity a frame is accepted under. The real reader asks the kernel for the writer's pid;
// these tests are about the shutdown window, not about that read, so they answer for this process.
const localIdentity = () => ({ pid: process.pid, uid: process.getuid(), procStart: processStart() });

async function connectAndAuthenticate(paths, pid = process.pid) {
  const { socketPath, keyPath } = artifacts(paths, pid);
  const { peerToken } = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  const client = net.createConnection({ path: socketPath });
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write(`${JSON.stringify({ type: "auth", token: peerToken })}\n`);
  return client;
}

// ---------------------------------------------------------------------------------------------
// [S] A frame that was accepted is recorded, or the shutdown says it was not.
// ---------------------------------------------------------------------------------------------

test("a frame that arrives as the receiver closes is still recorded", async () => {
  const paths = await fixture();
  const recorded = [];
  // Slow on purpose. The defect was that close() did not wait for this at all, so any handler
  // that is not instantaneous — which the real one, an fsync-ing ledger append, is not — loses
  // the frame. 20 ms is wide enough that a close which does not drain cannot pass by luck.
  const receiver = await startReceiver(
    async (frame) => { await new Promise((resolve) => setTimeout(resolve, 20)); recorded.push(frame); },
    { ...paths, peerIdentityReader: localIdentity }
  );
  const client = await connectAndAuthenticate(paths);
  client.write(`${JSON.stringify({ type: "reply", n: 1 })}\n`);
  // Delay zero: close in the same turn as the write, which is the measured loss case.
  const result = await receiver.close();
  assert.deepEqual(recorded, [{ type: "reply", n: 1 }]);
  assert.deepEqual(result, { stranded: 0, unreadBytes: 0 });
  client.destroy();
  await cleanup(paths);
});

test("a frame the drain bound did not reach makes close fail and is named in the refusal channel", async () => {
  const paths = await fixture();
  const refusals = [];
  let entered;
  const accepted = new Promise((resolve) => { entered = resolve; });
  const receiver = await startReceiver(
    async (frame) => { entered(frame); await new Promise(() => {}); },
    { ...paths, peerIdentityReader: localIdentity, onFrameRefused: async (refusal) => { refusals.push(refusal); } }
  );
  const client = await connectAndAuthenticate(paths);
  client.write(`${JSON.stringify({ type: "reply", n: 2 })}\n`);
  await accepted;
  // Bound zero with one frame already in flight: the frame was accepted and cannot be recorded,
  // which is the case that used to exit 0 with nothing written anywhere.
  await assert.rejects(
    receiver.close({ drainMillis: 0 }),
    (error) => error?.code === "RECEIVER_DRAIN_INCOMPLETE" && error.stranded === 1
  );
  // The auth frame is ordinal 1, so the reply is ordinal 2.
  assert.deepEqual(refusals, [{ connectionId: 1, frameOrdinal: 2, reason: "shutdown_before_record" }]);
  client.destroy();
  await cleanup(paths);
});

// The one way to hold a connection in the listen backlog on purpose: stop this process' event loop.
// While it is stopped the receiver cannot call accept, so a connection the kernel has taken and the
// bytes written into it exist nowhere this process can see.
function blockThread(millis) { const until = Date.now() + millis; while (Date.now() < until) { /* deliberate */ } }

test("a frame still in the listen backlog when the close begins is not thrown away", async () => {
  const paths = await fixture();
  const recorded = [];
  const receiver = await startReceiver(async (frame) => { recorded.push(frame); }, { ...paths, peerIdentityReader: localIdentity });
  const { socketPath, keyPath } = artifacts(paths, process.pid);
  const { peerToken } = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  const marker = path.join(paths.root, "flushed");
  const frames = [{ type: "auth", token: peerToken }, { type: "reply", n: 3 }].map((frame) => `${JSON.stringify(frame)}\n`).join("");
  const writer = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", "backlog-writer.mjs")], {
    stdio: "ignore",
    env: { ...process.env, TEST_SOCKET_PATH: socketPath, TEST_FRAMES: frames, TEST_MARKER: marker }
  });

  // Blocking, not awaiting: an await here would hand the loop back and let the receiver accept,
  // which is the state this test exists to avoid being in.
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) blockThread(2);
  assert.ok(fs.existsSync(marker), "the writer must have flushed its frame before the close begins");
  // The precondition, asserted rather than assumed: nothing in this process has seen the frame.
  assert.deepEqual(recorded, [], "the connection must still be unaccepted when the close begins");

  const result = await receiver.close();
  assert.deepEqual(recorded, [{ type: "reply", n: 3 }], "a frame in the backlog must be accepted and recorded by the close");
  assert.equal(result.stranded, 0);
  writer.kill("SIGKILL");
  await new Promise((resolve) => writer.once("exit", resolve));
  await cleanup(paths);
});

// ---------------------------------------------------------------------------------------------
// [H] The close() hardening. Both halves of it, because a partial cleanup reported as success is
// how a dead socket stays selectable after a clean SIGTERM.
// ---------------------------------------------------------------------------------------------

test("close refuses to report success when the registry row cannot be removed", async () => {
  const paths = await fixture();
  const receiver = await startReceiver(async () => {}, { ...paths, peerIdentityReader: localIdentity });
  const files = artifacts(paths, process.pid);
  // The directory, not the file: unlink needs write permission on the parent, so this is an
  // EACCES on the removal itself rather than on the row.
  await fsp.chmod(paths.sessionsDir, 0o500);
  await assert.rejects(receiver.close(), (error) => error?.code === "EACCES");
  await fsp.chmod(paths.sessionsDir, 0o700);
  // The row it could not remove is still there — which is exactly why the close had to say so.
  await fsp.lstat(files.registryPath);
  await cleanup(paths);
});

test("a close that closed nothing is not reported as a clean close", async () => {
  const paths = await fixture();
  const receiver = await startReceiver(async () => {}, { ...paths, peerIdentityReader: localIdentity });
  await receiver.close();
  // The second close finds no listening server. Its error used to be discarded by passing the
  // callback straight to resolve, so a close that did nothing answered the same as one that did.
  await assert.rejects(receiver.close(), (error) => error?.code === "ERR_SERVER_NOT_RUNNING");
  await cleanup(paths);
});

test("a receiver that cannot finish its cleanup exits non-zero on SIGTERM", async () => {
  const paths = await fixture();
  const fixtureScript = path.join(import.meta.dirname, "fixtures", "receiver-sigterm.mjs");
  const child = spawn(process.execPath, [fixtureScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEST_SESSIONS_DIR: paths.sessionsDir, TEST_SOCKET_DIR: paths.socketDir, TEST_STATE_ROOT: paths.stateRoot }
  });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = ""; child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited before ready: ${code}`)));
  });
  await fsp.chmod(paths.sessionsDir, 0o500);
  child.kill("SIGTERM");
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await fsp.chmod(paths.sessionsDir, 0o700);
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.match(stderr, /SIGTERM/);
  await cleanup(paths);
});

// ---------------------------------------------------------------------------------------------
// [H] The stateRoot wiring, which is the one line that makes the address stable in production.
// ---------------------------------------------------------------------------------------------

test("the daemon's receiver options carry the state root, so the address is the stable one", () => {
  const paths = statePaths("/tmp/upm-lcv26-wiring-check");
  const options = receiverOptionsForState(paths);
  assert.equal(options.stateRoot, paths.root);
  const address = receiverSocketPath(options.stateRoot, "/tmp/upm-lcv26-wiring-check-sockets");
  assert.match(path.basename(address), /^universal-peer-mcp-[0-9a-f]{24}\.sock$/);
  // The address the defect produced, for contrast: a pid in the name goes stale at every restart.
  assert.notEqual(path.basename(address), `${process.pid}.sock`);
});

test("a receiver started without a state root refuses to start", async () => {
  const paths = await fixture();
  await assert.rejects(
    startReceiver(async () => {}, { sessionsDir: paths.sessionsDir, socketDir: paths.socketDir, peerIdentityReader: localIdentity }),
    /receiver state root is required/
  );
  // It failed before it published anything, so there is nothing to discover and nothing to clean.
  assert.deepEqual(await fsp.readdir(paths.sessionsDir), []);
  assert.deepEqual(await fsp.readdir(paths.socketDir), []);
  await cleanup(paths);
});

// ---------------------------------------------------------------------------------------------
// [H] One lane's leftover is one lane's problem.
// ---------------------------------------------------------------------------------------------

test("a leftover pointing at another lane's live socket does not stop this lane from starting", async () => {
  const paths = await fixture();
  // Lane A: a real receiver, live, on its own state root.
  const laneA = { ...paths, stateRoot: path.join(paths.root, "state-a") };
  await fsp.mkdir(laneA.stateRoot, { mode: 0o700 });
  const fixtureScript = path.join(import.meta.dirname, "fixtures", "receiver-sigterm.mjs");
  const child = spawn(process.execPath, [fixtureScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEST_SESSIONS_DIR: laneA.sessionsDir, TEST_SOCKET_DIR: laneA.socketDir, TEST_STATE_ROOT: laneA.stateRoot }
  });
  const ready = await new Promise((resolve, reject) => {
    let stdout = ""; child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); });
    child.once("error", reject); child.once("exit", (code) => reject(new Error(`lane A exited before ready: ${code}`)));
  });
  const live = artifacts(laneA, ready.pid);

  // The leftover: a dead process' row naming lane A's live socket. This is the shape that used to
  // fail the start of every other lane — the socket is alive, so reclaiming it fails closed, and
  // that refusal used to propagate out of the loop.
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve, reject) => { exited.once("error", reject); exited.once("exit", resolve); });
  const leftoverPath = path.join(paths.sessionsDir, `${exited.pid}.json`);
  await fsp.writeFile(leftoverPath, `${JSON.stringify({
    pid: exited.pid, sessionId: crypto.randomUUID(), cwd: paths.root, procStart: "Thu Jan  1 00:00:00 1970",
    peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"],
    messagingSocketPath: live.socketPath, name: SENDER_PRODUCT_NAME
  })}\n`, { mode: 0o600 });

  // Lane B: a different state root, its own free address, same shared sessions directory.
  const laneB = { ...paths, stateRoot: path.join(paths.root, "state-b") };
  await fsp.mkdir(laneB.stateRoot, { mode: 0o700 });
  const skipped = [];
  const receiver = await startReceiver(async () => {}, { ...laneB, peerIdentityReader: localIdentity, onReclaimSkipped: async (detail) => { skipped.push(detail); } });

  assert.equal(receiver.address, `uds:${receiverSocketPath(laneB.stateRoot, paths.socketDir)}`);
  // The liveness check did not get looser: lane A's socket was refused, not stolen, and every one
  // of its artifacts is untouched with its process still running.
  assert.deepEqual(skipped, []); // other state lanes are outside this reclaimer's ownership
  for (const file of Object.values(live)) await fsp.lstat(file);
  assert.equal(child.exitCode, null);
  // And the leftover row it could not clean up is still there rather than half-removed.
  await fsp.lstat(leftoverPath);

  await receiver.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await cleanup(paths);
});

test("a malformed leftover key is skipped, not fatal, and is left where it is", async () => {
  const paths = await fixture();
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve, reject) => { exited.once("error", reject); exited.once("exit", resolve); });
  const dead = artifacts(paths, exited.pid);
  await fsp.writeFile(dead.registryPath, `${JSON.stringify({
    pid: exited.pid, sessionId: crypto.randomUUID(), cwd: paths.root, procStart: "Thu Jan  1 00:00:00 1970",
    peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"],
    messagingSocketPath: dead.socketPath, name: SENDER_PRODUCT_NAME
  })}\n`, { mode: 0o600 });
  await fsp.writeFile(dead.keyPath, "this is not json\n", { mode: 0o600 });

  const skipped = [];
  const result = await reclaimStaleRegistrations({ ...paths, onReclaimSkipped: async (detail) => { skipped.push(detail); } });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].pid, exited.pid);
  assert.deepEqual(result.skipped, skipped);
  // Unverifiable is not deletable: a key whose contents could not be read is not unlinked.
  await fsp.lstat(dead.keyPath);
  await cleanup(paths);
});

// ---------------------------------------------------------------------------------------------
// [H] The refusal report is bounded. A reporter that never settles is not the same failure as one
// that throws, and only the throwing one used to be handled.
//
// Why this class and not just the one line: the production reporter is `EventStore.append`, which
// chains onto the ledger write chain. Measured on the code before this correction, with that chain
// wedged on a readerless FIFO and the daemon's shutdown sequence replayed: SIGTERM did not exit
// within 20 s and needed SIGKILL, with nothing on stderr. The same run with only `receiver.close`
// bounded *also* hung for 20 s, at `store.close()` — which is why the bound exists in two places.
// ---------------------------------------------------------------------------------------------

test("a refusal reporter that never settles does not hold the close open", async () => {
  const paths = await fixture();
  let reporterEntered = 0;
  let entered;
  const accepted = new Promise((resolve) => { entered = resolve; });
  const receiver = await startReceiver(
    async (frame) => { entered(frame); await new Promise(() => {}); },
    {
      ...paths, peerIdentityReader: localIdentity,
      // Never settles, and never rejects either: the shape a wedged ledger append has. A
      // `try/catch` around an `await` on this does nothing at all.
      onFrameRefused: async () => { reporterEntered += 1; await new Promise(() => {}); }
    }
  );
  const client = await connectAndAuthenticate(paths);
  client.write(`${JSON.stringify({ type: "reply", n: 4 })}\n`);
  await accepted;
  const files = artifacts(paths, process.pid);

  const startedAt = Date.now();
  const error = await receiver.close({ drainMillis: 0, refusalReportMillis: 60 }).then(
    (value) => new Error(`close resolved with ${JSON.stringify(value)} instead of rejecting`),
    (reason) => reason
  );
  const elapsed = Date.now() - startedAt;

  // It was tried, it did not finish, and the close still ended.
  assert.equal(reporterEntered, 1);
  assert.equal(error.code, "RECEIVER_DRAIN_INCOMPLETE");
  assert.equal(error.stranded, 1);
  // The count is the point: a refusal that could not be written down is not passed over in silence.
  assert.equal(error.refusalsReported, 0);
  assert.equal(error.refusalsUnreported, 1);
  // Bounded, and generously asserted so a loaded machine cannot fail it for being slow. Before the
  // bound this did not finish at 15 s, which is 7.5x the default drain.
  assert.ok(elapsed < 5000, `close took ${elapsed} ms`);
  // And the cleanup still ran. Trading the hang for a socket left selectable after a clean SIGTERM
  // would be the other half of this defect rather than a fix for it.
  for (const file of Object.values(files)) await assert.rejects(fsp.lstat(file), (problem) => problem.code === "ENOENT");

  client.destroy();
  await cleanup(paths);
});

test("a reporter that throws is still counted as unreported and still lets the cleanup through", async () => {
  const paths = await fixture();
  let entered;
  const accepted = new Promise((resolve) => { entered = resolve; });
  const receiver = await startReceiver(
    async (frame) => { entered(frame); await new Promise(() => {}); },
    { ...paths, peerIdentityReader: localIdentity, onFrameRefused: async () => { throw new Error("reporter is broken"); } }
  );
  const client = await connectAndAuthenticate(paths);
  client.write(`${JSON.stringify({ type: "reply", n: 5 })}\n`);
  await accepted;
  const error = await receiver.close({ drainMillis: 0 }).then((value) => new Error(`resolved: ${JSON.stringify(value)}`), (reason) => reason);
  assert.equal(error.code, "RECEIVER_DRAIN_INCOMPLETE");
  assert.equal(error.refusalsReported, 0);
  assert.equal(error.refusalsUnreported, 1);
  const files = artifacts(paths, process.pid);
  for (const file of Object.values(files)) await assert.rejects(fsp.lstat(file), (problem) => problem.code === "ENOENT");
  client.destroy();
  await cleanup(paths);
});

test("a wedged ledger, the production reporter, still reaches the refusal and the cleanup", async () => {
  const paths = await shortRootFixture();
  const statePathsForRoot = statePaths(paths.stateRoot);
  const store = new EventStore(statePathsForRoot);
  await store.init();
  // It appends before the wedge, so the wedge is the variable under test and not a broken fixture.
  await store.append("test_precheck", {});

  let entered;
  const accepted = new Promise((resolve) => { entered = resolve; });
  const receiver = await startReceiver(
    async (frame) => { entered(frame); await new Promise(() => {}); },
    {
      sessionsDir: paths.sessionsDir, socketDir: paths.socketDir, stateRoot: paths.stateRoot,
      peerIdentityReader: localIdentity,
      // The wiring src/daemon.mjs uses, not a stand-in for it.
      onFrameRefused: async (refusal) => { await store.append("peer_frame_refused", refusal); }
    }
  );
  const client = await connectAndAuthenticate({ ...paths, stateRoot: paths.stateRoot });
  client.write(`${JSON.stringify({ type: "reply", n: 6 })}\n`);
  await accepted;

  // The event log becomes a pipe nobody reads. `EventStore#write` opens that path O_WRONLY on every
  // append and that open does not return until a reader appears, so the chain stops with no error
  // to catch and every later append — the refusal among them — queues behind it for ever.
  await fsp.rm(statePathsForRoot.events);
  execFileSync("/usr/bin/mkfifo", ["-m", "600", statePathsForRoot.events]);
  const wedge = store.append("test_wedge", {});
  wedge.catch(() => {});

  const startedAt = Date.now();
  const error = await receiver.close({ drainMillis: 0, refusalReportMillis: 60 }).then(
    (value) => new Error(`close resolved with ${JSON.stringify(value)} instead of rejecting`),
    (reason) => reason
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(error.code, "RECEIVER_DRAIN_INCOMPLETE");
  assert.equal(error.refusalsUnreported, 1);
  assert.ok(elapsed < 5000, `close took ${elapsed} ms with a wedged ledger`);
  const files = artifacts({ ...paths, stateRoot: paths.stateRoot }, process.pid);
  for (const file of Object.values(files)) await assert.rejects(fsp.lstat(file), (problem) => problem.code === "ENOENT");

  client.destroy();
  await cleanup(paths);
});

// ---------------------------------------------------------------------------------------------
// [H] The daemon's own waits. `receiver.close()` was one of three, and bounding only it leaves the
// shutdown stopped at the next one.
// ---------------------------------------------------------------------------------------------

test("settleAllWithin reports what did not finish instead of waiting for it", async () => {
  const results = await settleAllWithin([
    ["finished", Promise.resolve("value")],
    ["failed", Promise.reject(Object.assign(new Error("no"), { code: "NOPE" }))],
    ["never", new Promise(() => {})]
  ], 40);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected"]);
  assert.equal(results[0].value, "value");
  assert.equal(results[1].reason.code, "NOPE");
  assert.equal(results[2].reason.code, "SHUTDOWN_WAIT_TIMEOUT");
  assert.equal(results[2].reason.label, "never");
  // The label is a fixed word from the call site, never anything a peer supplied.
  assert.match(results[2].reason.message, /^never did not finish within 40 ms of the shutdown$/);
});

test("a bound that has already run out still answers for every entry", async () => {
  const results = await settleAllWithin([["never", new Promise(() => {})]], -1);
  assert.equal(results.length, 1);
  assert.equal(results[0].reason.code, "SHUTDOWN_WAIT_TIMEOUT");
});

test("a daemon shutdown with a wedged ledger exits non-zero in bounded time and says what stopped", async () => {
  const paths = await shortRootFixture();
  const fixtureScript = path.join(import.meta.dirname, "fixtures", "daemon-shutdown.mjs");
  const child = spawn(process.execPath, [fixtureScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TEST_SESSIONS_DIR: paths.sessionsDir, TEST_SOCKET_DIR: paths.socketDir, TEST_STATE_ROOT: paths.stateRoot,
      // drain 100 + refusal 60 = 160, comfortably under the 800 ms daemon bound, so `receiver_close`
      // finishes on its own and the only thing the bound catches is the wedged ledger. A budget
      // below drain + refusal would truncate the healthy half and hide the half under test.
      TEST_STALL_LEDGER: "1", TEST_SHUTDOWN_WAIT_MILLIS: "800",
      TEST_DRAIN_MILLIS: "100", TEST_REFUSAL_REPORT_MILLIS: "60"
    }
  });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = ""; child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited before ready: ${code}`)));
  });

  const startedAt = Date.now();
  child.kill("SIGTERM");
  // A hang is what this guards, so the wait for the exit is itself bounded: without it a regression
  // here would not fail the suite, it would stop it.
  const exit = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "TIMEOUT" }), 15_000))
  ]);
  const elapsed = Date.now() - startedAt;
  if (exit.signal === "TIMEOUT") child.kill("SIGKILL");

  assert.deepEqual(exit, { code: 1, signal: null }, `SIGTERM must reach an exit; stderr was ${JSON.stringify(stderr)}`);
  assert.ok(elapsed < 8000, `SIGTERM to exit took ${elapsed} ms`);
  // Both halves named: the frame that was lost, and the wait that had to be abandoned to say so.
  assert.match(stderr, /RECEIVER_DRAIN_INCOMPLETE/);
  assert.match(stderr, /SHUTDOWN_WAIT_TIMEOUT: event_store_close did not finish/);
  await cleanup(paths);
});

test("a daemon shutdown with a healthy ledger still exits on the frame it could not record", async () => {
  const paths = await shortRootFixture();
  const fixtureScript = path.join(import.meta.dirname, "fixtures", "daemon-shutdown.mjs");
  const child = spawn(process.execPath, [fixtureScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TEST_SESSIONS_DIR: paths.sessionsDir, TEST_SOCKET_DIR: paths.socketDir, TEST_STATE_ROOT: paths.stateRoot,
      TEST_STALL_LEDGER: "0", TEST_SHUTDOWN_WAIT_MILLIS: "8000",
      TEST_DRAIN_MILLIS: "100", TEST_REFUSAL_REPORT_MILLIS: "60"
    }
  });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = ""; child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited before ready: ${code}`)));
  });
  child.kill("SIGTERM");
  const exit = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "TIMEOUT" }), 20_000))
  ]);
  if (exit.signal === "TIMEOUT") child.kill("SIGKILL");
  assert.deepEqual(exit, { code: 1, signal: null });
  // No bound was reached, so nothing reports a timeout: a healthy shutdown is not made to look
  // like a stalled one by the guard that catches stalled ones.
  assert.match(stderr, /RECEIVER_DRAIN_INCOMPLETE/);
  assert.doesNotMatch(stderr, /SHUTDOWN_WAIT_TIMEOUT/);
  await cleanup(paths);
});

test("every temporary directory this file made has been removed", async () => {
  assert.deepEqual([...temporaryDirectories], []);
});
