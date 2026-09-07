import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startReceiver } from "../src/adapters/claude-native-v1/receiver.mjs";
import { resolveTarget, reverifyTarget } from "../src/adapters/claude-native-v1/registry.mjs";
import { outboundFrames } from "../src/adapters/claude-native-v1/protocol.mjs";
import { directSend } from "../src/adapters/claude-native-v1/transport.mjs";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

// The identity reader is stubbed in this file so the wire contract can be tested without the
// kernel. That stub hides the connection lifetime, which is where the real fault was, so the
// unstubbed proof lives in test/receiver-identity.test.mjs: a separate sending process, the
// shipped reader, a real write and a real close. Do not read a pass here as evidence about
// identity.

test("authenticated local UDS sends once after identity recheck", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-transport-")); cleanups.push(() => fsp.rm(made, { recursive: true, force: true })); const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets"); await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
  const framesSeen = []; const receiver = await startReceiver((frame) => framesSeen.push(frame), { sessionsDir, socketDir, peerIdentityReader: () => ({ pid: process.pid, uid: process.getuid(), procStart: processStart() }) }); cleanups.push(() => receiver.close());
  const expected = { sessionId: receiver.sessionId, cwd: process.cwd(), expectedDisplayName: "Changed label", permissionMode: "prompting" };
  const options = { sessionsDir, argvReader: () => [process.execPath, "--permission-mode", "default"], startReader: processStart };
  const target = await resolveTarget(expected, options);
  const frames = outboundFrames({ token: target.token, targetSessionId: target.sessionId, senderAddress: receiver.address, permissionMode: "prompting", messageId: "10000000-0000-4000-8000-000000000030", subscriptionId: "10000000-0000-4000-8000-000000000031", content: "fixture" });
  const result = await directSend(target, frames, { reverify: () => reverifyTarget(target, expected, options) });
  expect(result.bytesWritten).toBeGreaterThan(0);
  await Bun.sleep(20); expect(framesSeen.map((frame) => frame.type)).toEqual(["user", "control"]);
});

test("receiver close destroys an authenticated connection that stays open", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-receiver-close-")); cleanups.push(() => fsp.rm(made, { recursive: true, force: true })); const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets"); await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
  const receiver = await startReceiver(() => {}, { sessionsDir, socketDir, peerIdentityReader: () => ({ pid: process.pid, uid: process.getuid(), procStart: processStart() }) });
  const socket = net.createConnection({ path: receiver.address.slice(4) }); await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  await Promise.race([receiver.close(), Bun.sleep(500).then(() => { throw new Error("receiver close timed out"); })]);
});

// What the hold is and what it is not. It is not a delivery guarantee: the bound stops a hold
// that would otherwise never end, and a receiver that gets to the bytes after it loses them —
// test/receiver-identity.test.mjs runs that case with a real separate sender, and
// docs/known-issues.md carries the residual in words. What is pinned here is the bound itself:
// the normal end is the receiver's close and is silent, the abnormal end is ours and is not.

async function workspace(prefix) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), prefix)); cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
  const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets");
  await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
  return { root, sessionsDir, socketDir };
}
async function tokenOf(sessionsDir, socketPath) {
  const keyPath = path.join(sessionsDir, `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  return JSON.parse(await fsp.readFile(keyPath, "utf8")).peerToken;
}
const selfTarget = (socketPath) => ({ pid: process.pid, procStart: processStart(), socketPath, token: "1".repeat(32), permission: { mode: "prompting" } });
const line = (body) => [{ type: "user", message: { role: "user", content: body } }];

test("the hold ends on the receiver's own close and nothing is reported", async () => {
  const { root } = await workspace("peer-hold-closed-");
  const socketPath = path.join(root, "peer.sock");
  // a receiver that reads and then closes, which is the normal end of a hold
  const server = net.createServer((socket) => { socket.on("data", () => socket.destroy()); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const bounded = [];
  const target = selfTarget(socketPath);
  await directSend(target, line("held then closed by the receiver"), { reverify: async () => target, holdBoundMs: 5_000, onHoldBound: (detail) => bounded.push(detail) });
  await Bun.sleep(150);
  expect(bounded).toEqual([]);
});

test("when the receiver never closes, our own bound ends the hold, once, and says so", async () => {
  const { sessionsDir, socketDir } = await workspace("peer-hold-bound-");
  const framesSeen = [];
  const receiver = await startReceiver((frame) => framesSeen.push(frame), { sessionsDir, socketDir, peerIdentityReader: () => ({ pid: process.pid, uid: process.getuid(), procStart: processStart() }) });
  cleanups.push(() => receiver.close());
  const socketPath = receiver.address.slice("uds:".length);
  const frames = [{ type: "auth", token: await tokenOf(sessionsDir, socketPath) }, ...line("the receiver keeps this connection open")];
  const bounded = []; const target = selfTarget(socketPath);
  const started = Date.now();
  const result = await directSend(target, frames, { reverify: async () => target, holdBoundMs: 200, onHoldBound: (detail) => bounded.push(detail) });
  // the caller is not charged for the hold: the promise settles on the flush, the hold runs on
  const settledAfter = Date.now() - started;
  expect(settledAfter).toBeLessThan(200);
  await Bun.sleep(500);
  expect(framesSeen.map((frame) => frame.type)).toEqual(["user"]);
  expect(bounded).toHaveLength(1);
  expect(bounded[0]).toMatchObject({ reason: "hold_bound_reached", holdBoundMs: 200, bytesWritten: result.bytesWritten, targetPid: process.pid });
  expect(bounded[0].heldMs).toBeGreaterThanOrEqual(200);
  expect(typeof bounded[0].targetProcStart).toBe("string");
});
