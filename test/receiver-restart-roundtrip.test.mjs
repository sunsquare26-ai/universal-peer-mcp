import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { startReceiver, reclaimStaleRegistrations } from "../src/adapters/claude-native-v1/receiver.mjs";
import { SENDER_PRODUCT_NAME } from "../src/adapters/claude-native-v1/protocol.mjs";
import { hydrateInboundBodies } from "../src/core/inbound-hydrate.mjs";
import { publicResultSchema, toolDefinitions } from "../src/mcp/tools.mjs";
import { projectSchema, validateSchema } from "../src/mcp/schema-validator.mjs";
import { redactPublic } from "../src/mcp/redact.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function bounded(promise, ms = 4000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture timeout")), ms); })]); } finally { clearTimeout(timer); } }
async function fixture() {
  const root = await fsp.mkdtemp("/private/tmp/upm-lcr26-");
  const result = { root, stateRoot: path.join(root, "state"), sessionsDir: path.join(root, "sessions"), socketDir: path.join(root, "s") };
  for (const p of [result.stateRoot, result.sessionsDir, result.socketDir]) await fsp.mkdir(p, { mode: 0o700 });
  return result;
}
async function launch(configFile) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/restart-receiver.mjs"), configFile], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = await bounded(new Promise((resolve, reject) => { let out = ""; child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); }); child.once("error", reject); child.once("exit", () => reject(new Error("fixture exited before ready"))); }));
  return { child, ready };
}
async function stop(child, signal = "SIGTERM") { if (child.exitCode !== null || child.signalCode) return; const exited = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, sig }))); child.kill(signal); return bounded(exited); }
async function key(paths, pid, address) {
  const socket = address.slice(4);
  return JSON.parse(await fsp.readFile(path.join(paths.sessionsDir, `${pid}.${crypto.createHash("sha256").update(socket).digest("hex")}.key`), "utf8"));
}
async function write(address, token, content) {
  const socket = net.createConnection(address.slice(4)); socket.on("error", () => {});
  await bounded(new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); }));
  socket.write(JSON.stringify({ type: "auth", token }) + "\n" + JSON.stringify({ type: "message", message: { content } }) + "\n");
  return socket;
}
async function eventUntil(paths, predicate) {
  return bounded((async () => { for (;;) { const rows = (await fsp.readFile(path.join(paths.stateRoot, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); const row = rows.find(predicate); if (row) return row; await sleep(10); } })());
}
for (const signal of ["SIGTERM", "SIGKILL"]) test(`pending reply survives ${signal} restart with fresh key, durable correlation and public inline body`, async () => {
  const paths = await fixture(); const children = []; const sockets = [];
  try {
    const messageId = crypto.randomUUID(); const threadId = crypto.randomUUID();
    const configFile = path.join(paths.root, "config.json");
    await fsp.writeFile(configFile, JSON.stringify({ ...paths, request: { messageId, threadId, targetPid: process.pid, targetProcStart: processStart(), targetProcStartRendering: "utc0-c-squeezed", targetAlias: "test", requestHash: "a".repeat(64) } }), { mode: 0o600 });
    const first = await launch(configFile); children.push(first.child);
    const registry = JSON.parse(await fsp.readFile(path.join(paths.sessionsDir, `${first.ready.pid}.json`), "utf8"));
    assert.equal(typeof registry.startedAt, "number"); assert.equal(registry.startedAt, registry.updatedAt);
    assert.ok(registry.startedAt > Date.now() - 5000 && registry.startedAt <= Date.now());
    const oldKey = await key(paths, first.ready.pid, first.ready.address);
    await stop(first.child, signal);
    const second = await launch(configFile); children.push(second.child);
    assert.equal(second.ready.address, first.ready.address); assert.equal(second.ready.requests, 1); assert.notEqual(second.ready.pid, first.ready.pid);
    const newKey = await key(paths, second.ready.pid, second.ready.address); assert.notEqual(newKey.peerToken, oldKey.peerToken);
    const body = `PEER_REPLY v=1 message_id=${crypto.randomUUID()} thread_id=${threadId} reply_to=${messageId} verdict=pass\n재시작 뒤 응답\n` + "x".repeat(6200);
    sockets.push(await write(second.ready.address, oldKey.peerToken, body));
    await eventUntil(paths, (e) => e.type === "peer_frame_refused" && e.reason === "authentication_failed");
    const writerConfig = path.join(paths.root, "writer.json");
    const socketPath = second.ready.address.slice(4);
    await fsp.writeFile(writerConfig, JSON.stringify({ socketPath, keyPath: path.join(paths.sessionsDir, `${second.ready.pid}.${crypto.createHash("sha256").update(socketPath).digest("hex")}.key`), body }), { mode: 0o600 });
    const wrongWriter = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/restart-writer.mjs"), writerConfig], { stdio: "ignore" }); children.push(wrongWriter);
    await eventUntil(paths, (e) => e.type === "peer_frame_refused" && e.reason === "inbound_identity_mismatch");
    sockets.push(await write(second.ready.address, newKey.peerToken, body));
    const reply = await eventUntil(paths, (e) => e.type === "peer_reply");
    assert.equal(reply.messageId, messageId); assert.equal(reply.threadId, threadId); assert.equal(reply.peerPid, process.pid);
    assert.equal(await fsp.readFile(path.join(paths.stateRoot, reply.bodyFile), "utf8"), body);
    const events = await hydrateInboundBodies([reply], { root: paths.stateRoot });
    assert.equal(events[0].body, body);
    const schema = publicResultSchema(toolDefinitions([]).find((tool) => tool.name === "peer_list_events"));
    const projected = redactPublic(projectSchema(schema, { events, cursor: reply.seq }));
    assert.deepEqual(validateSchema(schema, projected).errors, []); assert.equal(projected.events[0].body, body);
    assert.equal((await stop(second.child)).code, 0);
  } finally { for (const s of sockets) s.destroy(); for (const child of children) await stop(child, "SIGKILL"); await fsp.rm(paths.root, { recursive: true, force: true }); }
}, 12000);

test("cleanup preserves replacement inode and treats live PID with old start as live", async () => {
  const paths = await fixture(); let receiver;
  try {
    const rowFile = path.join(paths.sessionsDir, `${process.pid}.json`);
    const row = JSON.stringify({ pid: process.pid, procStart: "Thu Jan 1 00:00:00 1970", name: SENDER_PRODUCT_NAME });
    await fsp.writeFile(rowFile, row, { mode: 0o600 });
    await reclaimStaleRegistrations(paths); assert.equal(await fsp.readFile(rowFile, "utf8"), row);
    receiver = await startReceiver(async () => {}, paths);
    await fsp.rename(rowFile, rowFile + ".old");
    await fsp.writeFile(rowFile, "replacement", { mode: 0o600 });
    await assert.rejects(receiver.close(), /artifact changed/); receiver = null;
    assert.equal(await fsp.readFile(rowFile, "utf8"), "replacement");
  } finally { if (receiver) await receiver.close().catch(() => {}); await fsp.rm(paths.root, { recursive: true, force: true }); }
});

test("an orphan socket without a verified dead owner record is preserved", async () => {
  const paths = await fixture(); let child;
  try {
    const { receiverSocketPath } = await import("../src/adapters/claude-native-v1/receiver.mjs");
    const socketPath = receiverSocketPath(paths.stateRoot, paths.socketDir);
    child = spawn(process.execPath, ["-e", 'import net from "node:net"; import fs from "node:fs"; const s=net.createServer(); s.listen(process.env.TEST_SOCKET,()=>{fs.chmodSync(process.env.TEST_SOCKET,0o600);process.stdout.write("ready\\n")});'], { env: { ...process.env, TEST_SOCKET: socketPath }, stdio: ["ignore", "pipe", "ignore"] });
    await bounded(new Promise((resolve) => child.stdout.once("data", resolve)));
    await stop(child, "SIGKILL");
    const before = await fsp.lstat(socketPath);
    await assert.rejects(startReceiver(async () => {}, paths), (error) => error.code === "EADDRINUSE");
    const after = await fsp.lstat(socketPath); assert.equal(after.ino, before.ino);
  } finally { if (child) await stop(child, "SIGKILL"); await fsp.rm(paths.root, { recursive: true, force: true }); }
});
