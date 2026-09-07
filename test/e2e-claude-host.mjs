#!/usr/bin/env bun
// A stand-in peer for the end to end test. It is not Claude Code and does not
// pretend to be: it publishes the same registry row, private key file and
// authenticated UDS that the claude-native-v1 adapter reads, and it answers one
// message with the documented ACK and REPLY markers.
//
// Everything the server verifies about this process is verified for real. That
// is why the launcher passes a genuine --permission-mode argument instead of a
// stubbed argv reader: the permission proof reads this process' own
// KERN_PROCARGS2 buffer, the socket check reads this process' own uid and mode,
// and the identity checks read this process' own start time.
//
// The helper deliberately re-implements the process start time reader instead of
// importing the one under test, so the value the server checks is produced by an
// independent path.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const options = parseArguments(process.argv.slice(2));
const sessionsDir = required("sessions-dir");
const socketDir = required("socket-dir");
const readyFile = required("ready-file");
const logFile = required("log-file");
const sessionId = required("session-id");
const cwd = await fsp.realpath(required("cwd"));
const displayName = options["display-name"] ?? "Peer session";

const procStart = processStart(process.pid);
const socketPath = path.join(socketDir, `${process.pid}.sock`);
const registryPath = path.join(sessionsDir, `${process.pid}.json`);
const keyPath = path.join(sessionsDir, `${process.pid}.${sha256(path.resolve(socketPath))}.key`);
const peerToken = crypto.randomBytes(16).toString("hex");
const address = `uds:${socketPath}`;
const open = new Set();
const replies = new Set();

const server = net.createServer((socket) => { open.add(socket); socket.once("close", () => open.delete(socket)); accept(socket); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
await fsp.chmod(socketPath, 0o600);
await writePrivate(keyPath, { peerToken, procStart, pidDomain: "darwin" });
await writePrivate(registryPath, {
  pid: process.pid, sessionId, cwd, procStart, peerProtocol: 1,
  peerFeatures: ["notify_idle", "reply_across_default_dirs"], pidDomain: "darwin",
  messagingSocketPath: socketPath, name: displayName, status: "idle", updatedAt: Date.now()
});
await writePrivate(readyFile, { pid: process.pid, sessionId, socketPath, procStart, displayName });

process.once("SIGTERM", stop); process.once("SIGINT", stop);

function accept(socket) {
  let authenticated = false; let buffer = ""; let pending = { message: null, subscriptionId: null };
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch { return socket.destroy(); }
      if (!authenticated) {
        if (frame.type !== "auth" || !equal(frame.token, peerToken)) { void log({ event: "auth_rejected" }); return socket.destroy(); }
        authenticated = true; void log({ event: "authenticated" }); continue;
      }
      void log({ event: "frame", frame });
      if (frame.type === "user") pending.message = readMessage(frame);
      if (frame.type === "control" && frame.action === "notify_when_idle") pending.subscriptionId = frame.msg_id;
      if (pending.message && pending.subscriptionId) { const answer = { ...pending }; pending = { message: null, subscriptionId: null }; void respond(answer); }
    }
  });
}

function readMessage(frame) {
  const content = frame?.message?.content;
  if (typeof content !== "string") return null;
  const lines = content.split("\n");
  const mode = /from-mode="([a-z]+)"/.exec(lines[0] ?? "")?.[1] ?? null;
  const name = /from-name="([^"]*)"/.exec(lines[0] ?? "")?.[1] ?? null;
  let body = null; try { body = JSON.parse(lines.slice(1, -1).join("\n")); } catch { return null; }
  if (typeof body?.messageId !== "string" || typeof body?.threadId !== "string") return null;
  return { transportMessageId: frame.msg_id, from: frame.from, mode, name, messageId: body.messageId, threadId: body.threadId, kind: body.kind };
}

async function respond({ message, subscriptionId }) {
  try {
    const target = message.from.slice("uds:".length);
    const senderPid = Number(path.basename(target, ".sock"));
    if (!Number.isInteger(senderPid) || senderPid <= 1) throw new Error("sender address is not a peer socket");
    const senderKey = path.join(sessionsDir, `${senderPid}.${sha256(path.resolve(target))}.key`);
    const token = JSON.parse(await fsp.readFile(senderKey, "utf8")).peerToken;
    const ackId = crypto.randomUUID(); const replyId = crypto.randomUUID();
    const frames = [
      { type: "auth", token },
      { type: "control", action: "peer_message_status", msgV: 1, msg_id: crypto.randomUUID(), orig_msg_id: message.transportMessageId, status: "delivered", session_id: sessionId, from: address },
      envelope(ackId, `PEER_ACK v=1 message_id=${ackId} thread_id=${message.threadId} reply_to=${message.messageId}`),
      envelope(replyId, `PEER_REPLY v=1 message_id=${replyId} thread_id=${message.threadId} reply_to=${message.messageId} verdict=pass\nthe stand-in peer answered one message`),
      { type: "control", action: "peer_idle_notice", msgV: 1, msg_id: crypto.randomUUID(), orig_msg_id: subscriptionId, state: "idle", session_id: sessionId, from: address }
    ];
    await write(target, frames);
    await log({ event: "answered", messageId: message.messageId, mode: message.mode, name: message.name });
  } catch (error) { await log({ event: "answer_failed", reason: error?.message ?? "unknown" }); }
}

function envelope(messageId, content) {
  return { type: "user", msgV: 1, msg_id: messageId, uuid: crypto.randomUUID(), session_id: sessionId, from: address, message: { role: "user", content } };
}

// The reply is written and then the connection is closed — really closed, on a bound, not
// held open until the process stops. That order is the contract the receiver depends on: it
// identifies the connected peer with LOCAL_PEERPID, and macOS answers that with ENOTCONN as
// soon as this side is gone, so the bytes have to outlive the write by long enough for the
// receiver to look their writer up. HOLD_BOUND_MS is the same bound the shipped sender uses,
// and like it, it is a stop against an unbounded hold and not a promise that the bytes were
// read — see docs/known-issues.md. A helper that held the connection open for the life of the
// process would hide exactly the fault this end to end run exists to catch.
const HOLD_BOUND_MS = 1_000;
function write(target, frames) {
  const wire = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target });
    replies.add(socket); socket.once("close", () => replies.delete(socket));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("reply timed out")); }, 10_000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => socket.write(wire, () => {
      clearTimeout(timer);
      const closing = setTimeout(() => socket.end(), HOLD_BOUND_MS);
      const gone = setTimeout(() => socket.destroy(), HOLD_BOUND_MS + 250);
      socket.once("close", () => { clearTimeout(closing); clearTimeout(gone); });
      void log({ event: "reply_written", bytes: Buffer.byteLength(wire), holdBoundMs: HOLD_BOUND_MS });
      resolve();
    }));
  });
}

async function stop() {
  const closed = new Promise((resolve) => server.close(resolve));
  for (const socket of [...open, ...replies]) socket.destroy();
  await closed;
  await Promise.allSettled([socketPath, registryPath, keyPath, readyFile].map((file) => fsp.unlink(file)));
  process.exit(0);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (typeof key !== "string" || !key.startsWith("--") || index + 1 >= argv.length) throw new Error("arguments must be --name value pairs");
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
}
function required(name) { const value = options[name]; if (!value) throw new Error(`missing --${name}`); return value; }
function processStart(pid) { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim().replace(/\s+/g, " "); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function equal(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function writePrivate(file, value) { await fsp.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600); }
async function log(entry) { try { await fsp.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 }); } catch {} }
