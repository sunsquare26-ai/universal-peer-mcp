import { afterEach, expect, test } from "bun:test";
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
