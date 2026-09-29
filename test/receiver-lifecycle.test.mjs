import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, afterAll } from "bun:test";

import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { receiverSocketPath, reclaimStaleRegistrations, startReceiver } from "../src/adapters/claude-native-v1/receiver.mjs";
import { SENDER_PRODUCT_NAME } from "../src/adapters/claude-native-v1/protocol.mjs";

const temporaryDirectories = new Set();
afterAll(async () => { for (const p of temporaryDirectories) await fsp.rm(p, { recursive: true, force: true }); });
async function fixture() {
  const temporary = await fsp.realpath(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(temporary, "upm-lc26-"));
  const sessionsDir = path.join(root, "sessions");
  // AF_UNIX paths are short on macOS. Keep the socket directory under the literal /tmp alias so
  // this lifecycle test exercises the product instead of failing on the fixture's path length.
  const socketDir = await fsp.mkdtemp("/tmp/upm-lcs26-");
  temporaryDirectories.add(root); temporaryDirectories.add(socketDir);
  const stateRoot = path.join(root, "state");
  await Promise.all([sessionsDir, stateRoot].map((directory) => fsp.mkdir(directory, { mode: 0o700 })));
  await fsp.chmod(socketDir, 0o700);
  return { root, sessionsDir, socketDir, stateRoot };
}

function receiverArtifacts({ sessionsDir, socketDir, stateRoot }, pid) {
  const socketPath = receiverSocketPath(stateRoot, socketDir);
  const keyName = `${pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`;
  return { socketPath, registryPath: path.join(sessionsDir, `${pid}.json`), keyPath: path.join(sessionsDir, keyName) };
}

async function spawnReceiverFixture(paths) {
  const fixtureScript = path.join(import.meta.dirname, "fixtures", "receiver-sigterm.mjs");
  const child = spawn(process.execPath, [fixtureScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEST_SESSIONS_DIR: paths.sessionsDir, TEST_SOCKET_DIR: paths.socketDir, TEST_STATE_ROOT: paths.stateRoot }
  });
  const ready = await new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
      stdout += chunk; const newline = stdout.indexOf("\n");
      if (newline >= 0) { try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); } }
    });
    child.once("error", reject); child.once("exit", (code) => reject(new Error(`receiver fixture exited before ready: ${code}: ${stderr}`)));
  });
  return { child, ready };
}

async function absent(file) {
  await assert.rejects(fsp.lstat(file), (error) => error?.code === "ENOENT", `${file} must be absent`);
}

test("one state root keeps one receiver address across process ids", async () => {
  const { socketDir, stateRoot } = await fixture();
  const first = receiverSocketPath(stateRoot, socketDir);
  const second = receiverSocketPath(stateRoot, socketDir);
  assert.equal(first, second);
  assert.match(path.basename(first), /^universal-peer-mcp-[0-9a-f]{24}\.sock$/);
});

test("startup removes dead product rows but preserves a live product row", async () => {
  const paths = await fixture();
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve, reject) => { exited.once("error", reject); exited.once("exit", resolve); });
  const deadPid = exited.pid;
  const dead = receiverArtifacts(paths, deadPid);
  const deadRow = {
    pid: deadPid, sessionId: crypto.randomUUID(), cwd: paths.root,
    procStart: "Thu Jan  1 00:00:00 1970", peerProtocol: 1,
    peerFeatures: ["notify_idle", "reply_across_default_dirs"],
    messagingSocketPath: dead.socketPath, name: SENDER_PRODUCT_NAME
  };
  await fsp.writeFile(dead.registryPath, `${JSON.stringify(deadRow)}\n`, { mode: 0o600 });
  await fsp.writeFile(dead.keyPath, `${JSON.stringify({ peerToken: "not-a-real-token", procStart: deadRow.procStart })}\n`, { mode: 0o600 });

  const liveRegistry = path.join(paths.sessionsDir, `${process.pid}.json`);
  await fsp.writeFile(liveRegistry, `${JSON.stringify({ ...deadRow, pid: process.pid, procStart: processStart() })}\n`, { mode: 0o600 });
  await reclaimStaleRegistrations(paths);

  await absent(dead.registryPath);
  await absent(dead.keyPath);
  assert.equal(JSON.parse(await fsp.readFile(liveRegistry, "utf8")).pid, process.pid);
});

test("close removes the registry, key and stable socket", async () => {
  const paths = await fixture();
  const receiver = await startReceiver(async () => {}, paths);
  const artifacts = receiverArtifacts(paths, process.pid);
  assert.equal(receiver.address, `uds:${artifacts.socketPath}`);
  for (const file of Object.values(artifacts)) await fsp.lstat(file);
  await receiver.close();
  for (const file of Object.values(artifacts)) await absent(file);
});

test("SIGTERM completes registry, socket and key cleanup before exit", async () => {
  const paths = await fixture();
  const { child, ready } = await spawnReceiverFixture(paths);
  const artifacts = receiverArtifacts(paths, ready.pid);
  assert.equal(ready.address, `uds:${artifacts.socketPath}`);
  child.kill("SIGTERM");
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null });
  for (const file of Object.values(artifacts)) await absent(file);
});

test("the next start reclaims artifacts left by a hard-killed receiver", async () => {
  const paths = await fixture();
  const { child, ready } = await spawnReceiverFixture(paths);
  const stale = receiverArtifacts(paths, ready.pid);
  child.kill("SIGKILL");
  const killed = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(killed, { code: null, signal: "SIGKILL" });
  for (const file of Object.values(stale)) await fsp.lstat(file);

  const replacement = await startReceiver(async () => {}, paths);
  const current = receiverArtifacts(paths, process.pid);
  assert.equal(replacement.address, `uds:${stale.socketPath}`);
  await absent(stale.registryPath);
  await absent(stale.keyPath);
  for (const file of Object.values(current)) await fsp.lstat(file);
  await replacement.close();
  for (const file of Object.values(current)) await absent(file);
});

test("startup refuses to reclaim a socket while its recorded receiver is alive", async () => {
  const paths = await fixture();
  const { child, ready } = await spawnReceiverFixture(paths);
  const live = receiverArtifacts(paths, ready.pid);
  await assert.rejects(startReceiver(async () => {}, paths), (error) => error?.code === "EADDRINUSE");
  assert.equal(child.exitCode, null);
  for (const file of Object.values(live)) await fsp.lstat(file);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  for (const file of Object.values(live)) await absent(file);
});
