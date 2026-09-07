// What the receiver knows about who wrote each frame, pinned against the two ways it can be
// wrong.
//
// getsockopt(LOCAL_PEERPID) does not answer "the process that connected". It answers the peer
// socket's last_pid, and that changes when another process inherits or is passed the
// descriptor and writes on it. Reading it once at accept and reusing the answer therefore
// attributes a child's frames to its parent, and no test that keeps one process on one
// connection can see the difference. The first test below hands a live connection to a child
// and checks that the frames it writes are named after the child.
//
// The same call answers ENOTCONN once the writer is gone. That used to fall back to the read
// taken at accept, labelled as weaker evidence. Measured, that fallback handed a closed
// child's frames to its parent and the parent's identity carried them through core, milestone
// and code review to a delivered ACK and a passing review — a label does not separate
// identity strength. The fallback is gone: a frame whose writer cannot be named with the
// frame is refused, and the refusal is recorded. The second test is that whole path.
//
// The cost is deliberate and is documented in docs/known-issues.md: a third party that writes
// and closes in one breath has its frames refused. The shipped sender holds the connection open,
// which is what keeps its writer nameable — a hold, not an exemption: when our own hold bound
// ends before the receiver has read the frames, they meet this same rule.
//
// These tests use the shipped identity reader and a separate sending process on purpose. The
// transport tests stub the reader, which is why this gap survived until a real round trip ran.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { frameObserver, PeerCore } from "../src/core/peer-core.mjs";
import { sha256 } from "../src/core/dedupe.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { CodeReviewExtension } from "../src/extensions/code-review/index.mjs";
import { MilestoneExtension } from "../src/extensions/milestone/index.mjs";
import { defaultPeerIdentity, startReceiver } from "../src/adapters/claude-native-v1/receiver.mjs";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

const SENDER = path.resolve(new URL("./peer-sender.mjs", import.meta.url).pathname);
const ARTIFACT_HASH = "0f".repeat(32);
const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function workspace() {
  // short prefix on purpose: a unix socket path has 104 bytes, and the temporary directory
  // on this platform already spends half of them
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-rid-"));
  cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
  const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  return root;
}

async function receiver(options = {}) {
  const root = await workspace();
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets");
  await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
  const frames = []; const refusals = [];
  const started = await startReceiver((frame, peer) => { frames.push({ frame, peer }); }, {
    sessionsDir, socketDir, onFrameRefused: (refusal) => { refusals.push(refusal); }, ...options
  });
  cleanups.push(() => started.close());
  const socketPath = started.address.slice("uds:".length);
  return { frames, refusals, root, socketPath, token: await tokenOf(sessionsDir, socketPath) };
}

async function tokenOf(sessionsDir, socketPath) {
  const keyPath = path.join(sessionsDir, `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  return JSON.parse(await fsp.readFile(keyPath, "utf8")).peerToken;
}

// Every read is numbered and the number travels with the frame, so a frame carries the
// ordinal of the read that produced it. One read reused for everything shows up as the same
// ordinal on every frame; a read per frame shows up as increasing ordinals.
function counted(reader = defaultPeerIdentity) {
  const state = { reads: 0 };
  state.read = (socket) => { state.reads += 1; return { ...reader(socket), read: state.reads }; };
  return state;
}

// A receiver that is busy when the bytes land. This is not a stub of the identity read: the
// shipped reader still runs, it just runs late, the way it does when the loop was blocked by
// the previous connection's lookup.
function stalling(ms, reader = defaultPeerIdentity) {
  return (socket) => { const until = Date.now() + ms; while (Date.now() < until) {} return reader(socket); };
}

// A receiver that gets to the rest of the connection only after the sender has really closed
// it. The shipped reader runs for every read, including the first; what is arranged here is
// when the receiver gets there, and it waits for the state instead of sleeping towards it.
function stallUntilClosed(file, reader = defaultPeerIdentity, capMs = 20_000) {
  let waited = false;
  return (socket) => {
    try { return reader(socket); }
    finally { if (!waited) { waited = true; const until = Date.now() + capMs; while (!fs.existsSync(file) && Date.now() < until) {} } }
  };
}

function spawnSender(socketPath, mode, root, extra = []) {
  const framesFile = path.join(root, "frames.json"); const report = path.join(root, "report.json");
  const child = spawn(process.execPath, [SENDER, "--socket", socketPath, "--frames", framesFile, "--report", report, "--mode", mode, ...extra], { stdio: ["ignore", "ignore", "inherit"] });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch {} });
  const done = new Promise((resolve) => child.once("exit", resolve)).then(async () => {
    let reported = null; try { reported = JSON.parse(await fsp.readFile(report, "utf8")); } catch {}
    return { pid: child.pid, reported };
  });
  return { child, framesFile, done };
}

async function sender(socketPath, mode, batches, root, extra = []) {
  const framesFile = path.join(root, "frames.json");
  await fsp.writeFile(framesFile, JSON.stringify(batches));
  const { child, done } = spawnSender(socketPath, mode, root, extra);
  const result = await done;
  return { ...result, pid: child.pid };
}

async function settle(frames, wanted) {
  for (let attempt = 0; attempt < 200 && frames.length < wanted; attempt += 1) await Bun.sleep(10);
  await Bun.sleep(80);
}

const auth = (token) => ({ type: "auth", token });
const status = (id) => ({ type: "control", action: "peer_message_status", orig_msg_id: id, status: "delivered" });
const text = (body) => ({ type: "user", message: { role: "user", content: body } });
const idle = (id) => ({ type: "control", action: "peer_idle_notice", orig_msg_id: id, state: "idle" });

test("a frame written by a process that inherited the connection is named after that process", async () => {
  const identity = counted();
  const { frames, socketPath, token, root } = await receiver({ peerIdentityReader: identity.read });
  const sent = await sender(socketPath, "child", { first: [auth(token), status("one")], second: [text("written by the child")] }, root);
  await settle(frames, 2);

  expect(sent.reported?.childPid).toBeInteger();
  expect(sent.reported.childPid).not.toBe(sent.pid);
  expect(frames.map((entry) => entry.frame.type)).toEqual(["control", "user"]);
  // the whole finding in two lines: same connection, two writers, two identities
  expect(frames[0].peer.pid).toBe(sent.pid);
  expect(frames[1].peer.pid).toBe(sent.reported.childPid);
  expect(frames.map((entry) => entry.peer.identitySource)).toEqual(["frame", "frame"]);
  // ps reports whole seconds, so two processes started in the same second share a procStart;
  // the pid is what separates them here and the pid is what the ledger and PeerCore compare.
  expect(frames.every((entry) => typeof entry.peer.procStart === "string")).toBe(true);
}, 30_000);

// The other half of the same finding, end to end: a child writes the last frames, the
// connection is really closed, and the process that opened it is still running — which is
// exactly the shape in which a read taken at accept still answers, with the wrong process.
// The frames are the three that decide a delivered ACK, a passing review and a reply.
test("a frame written by a process that has closed the connection is refused, not credited to the opener", async () => {
  const root = await workspace();
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets");
  await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
  const closedFile = path.join(root, "closed"); const goFile = path.join(root, "go");
  const targetSocketPath = path.join(root, "target.sock");

  const delivered = []; const refusals = [];
  let store = null; let core = null; let milestone = null; let review = null;
  // the handler the daemon installs, not a hand copy of it: core first, then the extensions,
  // and the refusal hook writing to the same ledger. core and the store are read when a frame
  // arrives, which is why the handler can be built before either exists.
  const observe = frameObserver({
    store: { append: (type, data) => store.append(type, data) },
    core: { acceptFrame: (frame, peer) => core.acceptFrame(frame, peer) },
    observers: [(frame, peer) => milestone.observeFrame(frame, peer), (frame, peer) => review.observeFrame(frame, peer)]
  });
  const started = await startReceiver(async (frame, peer, context) => {
    delivered.push({ frame, peer });
    return observe(frame, peer, context);
  }, {
    sessionsDir, socketDir, peerIdentityReader: stallUntilClosed(closedFile),
    onFrameRefused: async (refusal) => { refusals.push(refusal); await store.append("peer_frame_refused", refusal); }
  });
  cleanups.push(() => started.close());
  const socketPath = started.address.slice("uds:".length);
  const token = await tokenOf(sessionsDir, socketPath);

  const { child, framesFile, done } = spawnSender(socketPath, "child-close", root, ["--wait-file", goFile, "--closed-file", closedFile, "--hold-ms", "600", "--child-hold-ms", "0"]);
  const senderProcStart = processStart(child.pid);
  const peerOfSender = { pid: child.pid, procStart: senderProcStart };

  store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: crypto.randomUUID(), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: child.pid, procStart: senderProcStart, socketPath: targetSocketPath, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  core = new PeerCore({ targets: { worker: target }, store, address: `uds:${socketPath}`, resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 }) });
  milestone = new MilestoneExtension({ store, core }); review = new CodeReviewExtension({ store, core });

  // an instruction, its milestone completion and the ACK reservation the completion produced
  const instructionId = crypto.randomUUID(); const threadId = crypto.randomUUID();
  await core.send({ alias: "worker", messageId: instructionId, threadId, kind: "work", body: "Do one bounded task." });
  const completionMessageId = crypto.randomUUID();
  const payload = { instruction_id: instructionId, attempt_id: crypto.randomUUID(), milestone_id: "M-1", files: ["src/example.mjs"], tests: [{ command: "bun test", scope: "milestone", pass: 7, fail: 0, skip: 0 }], blockers: [], last_signal_at: "2026-09-03T00:00:00Z" };
  const completionFrame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${targetSocketPath}`, message: { content: `MILESTONE_COMPLETED v=1 message_id=${completionMessageId} thread_id=${threadId} reply_to=${instructionId}\n${JSON.stringify(payload)}` } };
  await core.acceptFrame(completionFrame, peerOfSender); await milestone.observeFrame(completionFrame, peerOfSender);
  const ackTransportMessageId = store.events.find((event) => event.type === "milestone_ack_send_reserved").ackTransportMessageId;

  // an open code review round
  const reviewId = crypto.randomUUID(); const requestMessageId = crypto.randomUUID(); const reviewThreadId = crypto.randomUUID();
  await review.request({ alias: "worker", reviewId, requestMessageId, threadId: reviewThreadId, targetKind: "implementation", artifactHash: ARTIFACT_HASH, scope: ["src/example.mjs"], nonGoals: [], evidence: [{ command: "bun test", summary: "1 pass, 0 fail" }] });

  const receiptPayload = { review_id: reviewId, verdict: "pass", review_thread_id: "thread-1", rounds: 1, reviewed_at: "2026-09-03T00:00:00Z", artifact_hash: ARTIFACT_HASH, mandatory_changes: [], unresolved: [] };
  const receiptFrame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${targetSocketPath}`, message: { content: `CODE_REVIEW_RECEIPT v=1 message_id=${crypto.randomUUID()} thread_id=${reviewThreadId} reply_to=${requestMessageId}\n${JSON.stringify(receiptPayload)}` } };
  const replyFrame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${targetSocketPath}`, message: { content: `PEER_REPLY v=1 message_id=${crypto.randomUUID()} thread_id=${threadId} reply_to=${instructionId} verdict=pass` } };
  const statusFrame = { type: "control", action: "peer_message_status", orig_msg_id: ackTransportMessageId, status: "delivered", from: `uds:${targetSocketPath}` };

  await fsp.writeFile(framesFile, JSON.stringify({ first: [auth(token)], second: [statusFrame, receiptFrame, replyFrame] }));
  await fsp.writeFile(goFile, "go\n");
  const sent = await done;
  await settle(delivered, 1);

  // the frames really were written by a different process, and they never arrived as anyone's
  expect(sent.reported?.childPid).toBeInteger();
  expect(sent.reported.childPid).not.toBe(child.pid);
  expect(delivered).toEqual([]);
  expect(refusals).toHaveLength(1);
  expect(refusals[0].reason).toBe("identity_unavailable");
  expect(refusals[0].connectionId).toBe(1);                        // local to this receiver, not an identifier
  expect(refusals[0].frameOrdinal).toBeGreaterThanOrEqual(1);
  expect(store.events.filter((event) => event.type === "peer_frame_refused")).toHaveLength(1);
  expect(store.events.map((event) => event.type)).not.toContain("peer_message_status");
  expect(store.events.map((event) => event.type)).not.toContain("peer_reply");
  expect(store.events.map((event) => event.type)).not.toContain("milestone_ack_delivered");
  expect(store.events.map((event) => event.type)).not.toContain("code_review_receipt_accepted");
  expect(milestone.status({ completionMessageId })).toMatchObject({ complete: false, state: "ack_reserved" });
  expect(review.status({ reviewId })).toMatchObject({ passed: false, state: "awaiting_receipt" });
  expect(await core.wait({ messageId: instructionId, require: "reply", timeoutMs: 200 })).toMatchObject({ timedOut: true });

  // The positive control is the test below and not three calls here: handing an identity in
  // proves that the correlation and the state transitions are sound, which is worth having, but
  // it does not prove that a frame time read ever succeeds. That one has to come off the wire.
}, 60_000);

// The positive control, and the reason the refusal above is the only thing standing in the way.
// The same three frames, from a process that is alive when the receiver reads them and is the
// process the instruction was sent to, complete the milestone, pass the review and answer the
// reply. Every identity here comes from the shipped frame time read; nothing is handed in.
test("the same frames, written by a living process the kernel can name, complete the milestone and pass the review", async () => {
  const root = await workspace();
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets");
  await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });
  const goFile = path.join(root, "go"); const targetSocketPath = path.join(root, "target.sock");

  const delivered = []; const refusals = [];
  const store = new EventStore(statePaths(root)); await store.init();
  let core = null; let milestone = null; let review = null;
  const observe = frameObserver({
    store, core: { acceptFrame: (frame, peer) => core.acceptFrame(frame, peer) },
    observers: [(frame, peer) => milestone.observeFrame(frame, peer), (frame, peer) => review.observeFrame(frame, peer)]
  });
  const started = await startReceiver(async (frame, peer, context) => {
    delivered.push({ frame, peer });
    return observe(frame, peer, context);
  }, { sessionsDir, socketDir, onFrameRefused: async (refusal) => { refusals.push(refusal); await store.append("peer_frame_refused", refusal); } });
  cleanups.push(() => started.close());
  const socketPath = started.address.slice("uds:".length);
  const token = await tokenOf(sessionsDir, socketPath);

  // the writer is spawned first because it is the target: the instruction is addressed to this
  // pid, and the frames that answer it have to come from this pid to be worth anything
  const { child, framesFile, done } = spawnSender(socketPath, "hold", root, ["--wait-file", goFile, "--hold-ms", "3000"]);
  const senderProcStart = processStart(child.pid);
  const target = { sessionId: crypto.randomUUID(), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: child.pid, procStart: senderProcStart, socketPath: targetSocketPath, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  core = new PeerCore({ targets: { worker: target }, store, address: `uds:${socketPath}`, resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 }) });
  milestone = new MilestoneExtension({ store, core }); review = new CodeReviewExtension({ store, core });

  const instructionId = crypto.randomUUID(); const threadId = crypto.randomUUID();
  await core.send({ alias: "worker", messageId: instructionId, threadId, kind: "work", body: "Do one bounded task." });
  const completionMessageId = crypto.randomUUID();
  const payload = { instruction_id: instructionId, attempt_id: crypto.randomUUID(), milestone_id: "M-1", files: ["src/example.mjs"], tests: [{ command: "bun test", scope: "milestone", pass: 7, fail: 0, skip: 0 }], blockers: [], last_signal_at: "2026-09-03T00:00:00Z" };
  const completionFrame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${targetSocketPath}`, message: { content: `MILESTONE_COMPLETED v=1 message_id=${completionMessageId} thread_id=${threadId} reply_to=${instructionId}\n${JSON.stringify(payload)}` } };
  // setup, not the control: this one frame is handed the writer's identity so that the ACK the
  // completion reserves exists before the three frames under test are written. Those three come
  // off the wire, and the identity they carry is read from the kernel with each of them.
  await observe(completionFrame, { pid: child.pid, procStart: senderProcStart, identitySource: "frame" });
  const ackTransportMessageId = store.events.find((event) => event.type === "milestone_ack_send_reserved").ackTransportMessageId;

  const reviewId = crypto.randomUUID(); const requestMessageId = crypto.randomUUID(); const reviewThreadId = crypto.randomUUID();
  await review.request({ alias: "worker", reviewId, requestMessageId, threadId: reviewThreadId, targetKind: "implementation", artifactHash: ARTIFACT_HASH, scope: ["src/example.mjs"], nonGoals: [], evidence: [{ command: "bun test", summary: "1 pass, 0 fail" }] });
  const receiptPayload = { review_id: reviewId, verdict: "pass", review_thread_id: "thread-1", rounds: 1, reviewed_at: "2026-09-03T00:00:00Z", artifact_hash: ARTIFACT_HASH, mandatory_changes: [], unresolved: [] };
  const receiptFrame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${targetSocketPath}`, message: { content: `CODE_REVIEW_RECEIPT v=1 message_id=${crypto.randomUUID()} thread_id=${reviewThreadId} reply_to=${requestMessageId}\n${JSON.stringify(receiptPayload)}` } };
  const replyFrame = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${targetSocketPath}`, message: { content: `PEER_REPLY v=1 message_id=${crypto.randomUUID()} thread_id=${threadId} reply_to=${instructionId} verdict=pass` } };
  const statusFrame = { type: "control", action: "peer_message_status", orig_msg_id: ackTransportMessageId, status: "delivered", from: `uds:${targetSocketPath}` };

  await fsp.writeFile(framesFile, JSON.stringify({ first: [auth(token)], second: [statusFrame, receiptFrame, replyFrame] }));
  await fsp.writeFile(goFile, "go\n");
  await settle(delivered, 3);

  // three frames, three frame time reads, and every one of them names the process that wrote
  expect(delivered.map((entry) => entry.frame.type)).toEqual(["control", "user", "user"]);
  expect(delivered.every((entry) => entry.peer.pid === child.pid)).toBe(true);
  expect(delivered.map((entry) => entry.peer.identitySource)).toEqual(["frame", "frame", "frame"]);
  expect(refusals).toEqual([]);
  expect(store.events.map((event) => event.type)).not.toContain("peer_frame_uncorrelated");
  expect(milestone.status({ completionMessageId })).toMatchObject({ complete: true, state: "ack_delivered" });
  expect(review.status({ reviewId })).toMatchObject({ passed: true, state: "passed" });
  expect(await core.wait({ messageId: instructionId, require: "reply", timeoutMs: 200 })).toMatchObject({ event: { type: "peer_reply", verdict: "pass" } });
  await done;
}, 60_000);

test("the identity is read once for every frame and never once for the connection", async () => {
  const identity = counted();
  const { frames, socketPath, token, root } = await receiver({ peerIdentityReader: identity.read });
  await sender(socketPath, "hold", { first: [auth(token), status("one")], second: [text("one line of text"), idle("one")] }, root, ["--hold-ms", "400"]);
  await settle(frames, 3);

  expect(frames.map((entry) => entry.frame.type)).toEqual(["control", "user", "control"]);
  expect(identity.reads).toBe(4);                                  // four lines, four reads
  expect(frames.map((entry) => entry.peer.read)).toEqual([2, 3, 4]);
  expect(new Set(frames.map((entry) => entry.peer.pid))).toEqual(new Set([frames[0].peer.pid]));
  expect(frames[0].peer.uid).toBe(process.getuid());
  expect(typeof frames[0].peer.procStart).toBe("string");
}, 30_000);

test("the shipped sender is still there to be read when a busy receiver gets to its frames", async () => {
  const { frames, refusals, socketPath, token, root } = await receiver({ peerIdentityReader: stalling(30) });
  const target = { pid: process.pid, procStart: processStart(), token, permission: { mode: "prompting" } };
  const sent = await sender(socketPath, "direct", { target, first: [auth(token), status("one")], second: [text("one line of text"), idle("one")] }, root, ["--hold-ms", "1400"]);
  await settle(frames, 3);

  expect(sent.reported?.bytesWritten).toBeGreaterThan(0);
  expect(frames.map((entry) => entry.frame.type)).toEqual(["control", "user", "control"]);
  expect(frames.map((entry) => entry.peer.identitySource)).toEqual(["frame", "frame", "frame"]);
  expect(frames.every((entry) => entry.peer.pid === sent.pid)).toBe(true);
  expect(refusals).toEqual([]);
}, 30_000);

test("a sender that closes in the write callback is refused and the refusal is reported", async () => {
  const { frames, refusals, socketPath, token, root } = await receiver({ peerIdentityReader: stalling(30) });
  await sender(socketPath, "close", { first: [auth(token), status("one")], second: [text("written and closed")] }, root);
  await settle(frames, 2);

  // The kernel cannot name a peer that is gone, so nothing is delivered — and the refusal is
  // an event, not a silence. This is the documented cost of the frame time read.
  expect(frames).toEqual([]);
  expect(refusals.length).toBeGreaterThanOrEqual(1);
  expect(refusals.every((refusal) => refusal.reason === "identity_unavailable")).toBe(true);
  expect(new Set(refusals.map((refusal) => refusal.connectionId)).size).toBe(1);
}, 30_000);

test("a writer the kernel can no longer describe is refused, not credited to the opener", async () => {
  let reads = 0;
  const real = defaultPeerIdentity;
  // the fourth line is written by a process the kernel can still name and ps can no longer
  // describe: the identity for that frame does not exist, so the frame does not either
  const peerIdentityReader = (socket) => { reads += 1; if (reads > 3) throw new Error("process identity unavailable"); return real(socket); };
  const { frames, refusals, socketPath, token, root } = await receiver({ peerIdentityReader });
  await sender(socketPath, "hold", { first: [auth(token), status("one")], second: [text("one line of text"), idle("one")] }, root, ["--hold-ms", "400"]);
  await settle(frames, 2);
  expect(frames.map((entry) => entry.frame.type)).toEqual(["control", "user"]);
  expect(refusals).toHaveLength(1);
  expect(refusals[0].reason).toBe("identity_unavailable");
}, 30_000);

test("nothing is delivered when the frame read cannot name the sender", async () => {
  let reads = 0;
  const { frames, refusals, socketPath, token, root } = await receiver({ peerIdentityReader: () => { reads += 1; throw new Error("LOCAL_PEERPID failed (57)"); } });
  await sender(socketPath, "hold", { first: [auth(token), status("one")], second: [text("one line of text")] }, root, ["--hold-ms", "300"]);
  await settle(frames, 1);
  expect(frames).toEqual([]);
  expect(reads).toBe(1);                                           // the auth line, and no more
  expect(refusals).toHaveLength(1);
  expect(refusals[0].reason).toBe("identity_unavailable");
}, 30_000);

test("a uid that changes mid connection ends the connection instead of the frame", async () => {
  let reads = 0;
  const real = defaultPeerIdentity;
  const reader = (socket) => { reads += 1; const peer = real(socket); return reads > 2 ? { ...peer, uid: peer.uid + 1 } : peer; };
  const { frames, refusals, socketPath, token, root } = await receiver({ peerIdentityReader: reader });
  await sender(socketPath, "hold", { first: [auth(token), status("one")], second: [text("one line of text"), idle("one")] }, root, ["--hold-ms", "400"]);
  await settle(frames, 2);
  expect(frames.map((entry) => entry.frame.type)).toEqual(["control"]);
  expect(refusals).toHaveLength(1);
  expect(refusals[0].reason).toBe("identity_foreign_uid");
}, 30_000);

test("a wrong token is refused before any frame is delivered, and the refusal says so", async () => {
  const { frames, refusals, socketPath, root } = await receiver();
  await sender(socketPath, "hold", { first: [auth("0".repeat(32))], second: [idle("one")] }, root, ["--hold-ms", "300"]);
  await settle(frames, 1);
  expect(frames).toEqual([]);
  expect(refusals).toHaveLength(1);
  expect(refusals[0].reason).toBe("authentication_failed");
}, 30_000);

test("an identity from another uid is refused before any frame is delivered", async () => {
  const { frames, refusals, socketPath, token, root } = await receiver({ peerIdentityReader: () => ({ pid: process.pid, uid: process.getuid() + 1, procStart: "other" }) });
  await sender(socketPath, "hold", { first: [auth(token)], second: [idle("one")] }, root, ["--hold-ms", "300"]);
  await settle(frames, 1);
  expect(frames).toEqual([]);
  expect(refusals).toHaveLength(1);
  expect(refusals[0].reason).toBe("identity_foreign_uid");
}, 30_000);

test("the receiver survives a peer that resets the connection instead of closing it", async () => {
  const { frames, socketPath, token } = await receiver();
  const socket = net.createConnection({ path: socketPath });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`${JSON.stringify(auth(token))}\n${JSON.stringify(status("one"))}\n`);
  await Bun.sleep(120);
  socket.resetAndDestroy();
  await Bun.sleep(120);
  expect(frames.map((entry) => entry.frame.type)).toEqual(["control"]);
}, 30_000);
