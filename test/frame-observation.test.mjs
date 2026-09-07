// The five ways a frame can end, and what each one leaves on the ledger.
//
// A refusal that is only a dropped connection is indistinguishable from a quiet afternoon, and
// the two are not the same fact. So every frame that does not end where it was aimed is written
// down, and the reason says which of the five it was:
//
//   a token that is not ours                 peer_frame_refused / authentication_failed
//   a writer the kernel cannot name          peer_frame_refused / identity_unavailable
//   authenticated, matching nothing          peer_frame_uncorrelated / unknown_*, no_reply_marker
//   authenticated, written by the wrong pid  peer_frame_refused / inbound_identity_mismatch
//   nothing arrived                          nothing
//
// The wiring here is the shipped one: startReceiver with the shipped identity reader, and the
// same frameObserver src/daemon.mjs installs. The writer is this test process, which is a real
// live process the kernel names for every frame; the mismatch case aims the message at another
// live process instead, so the identity that fails is a real identity and not a shape.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { frameObserver, PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { CodeReviewExtension } from "../src/extensions/code-review/index.mjs";
import { MilestoneExtension } from "../src/extensions/milestone/index.mjs";
import { startReceiver } from "../src/adapters/claude-native-v1/receiver.mjs";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { publicLedgerEvent } from "../src/extensions/code-review/index.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function harness({ targetPid = process.pid, ...options } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-obs-"));
  cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
  const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); const socketDir = path.join(root, "sockets");
  await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(socketDir, { mode: 0o700 });

  const store = new EventStore(statePaths(root)); await store.init();
  const targetSocketPath = path.join(root, "target.sock");
  const target = { sessionId: crypto.randomUUID(), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: targetPid, procStart: processStart(targetPid), socketPath: targetSocketPath, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  let core = null; let milestone = null; let review = null;
  const refusals = [];
  const started = await startReceiver(
    frameObserver({
      store,
      core: { acceptFrame: (frame, peer) => core.acceptFrame(frame, peer) },
      observers: [(frame, peer) => milestone.observeFrame(frame, peer), (frame, peer) => review.observeFrame(frame, peer)]
    }),
    { sessionsDir, socketDir, onFrameRefused: async (refusal) => { refusals.push(refusal); await store.append("peer_frame_refused", refusal); }, ...options }
  );
  cleanups.push(() => started.close());
  const socketPath = started.address.slice("uds:".length);
  core = new PeerCore({ targets: { worker: target }, store, address: `uds:${socketPath}`, resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 }) });
  milestone = new MilestoneExtension({ store, core }); review = new CodeReviewExtension({ store, core });
  const keyPath = path.join(sessionsDir, `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  const token = JSON.parse(await fsp.readFile(keyPath, "utf8")).peerToken;

  // Written from this process, so the frame time read names a process that is alive and is the
  // one that wrote. The answer is the rows the ledger grew by.
  async function write(frames, { authenticate = true } = {}) {
    const before = store.events.length;
    const socket = net.createConnection({ path: socketPath });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.on("error", () => {});
    socket.write(`${[...(authenticate ? [{ type: "auth", token }] : []), ...frames].map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    for (let attempt = 0; attempt < 200 && store.events.length === before; attempt += 1) await Bun.sleep(10);
    await Bun.sleep(80);
    socket.destroy(); await Bun.sleep(40);
    return store.events.slice(before);
  }

  return { core, milestone, review, refusals, root, socketPath, store, targetSocketPath, token, write };
}

const status = (id) => ({ type: "control", action: "peer_message_status", orig_msg_id: id, status: "delivered" });
const idle = (id) => ({ type: "control", action: "peer_idle_notice", orig_msg_id: id, state: "idle" });
const text = (body) => ({ type: "user", message: { role: "user", content: body } });
const kinds = (events) => events.map((event) => `${event.type}/${event.reason ?? ""}`);

async function instruction(harnessed) {
  const messageId = crypto.randomUUID(); const threadId = crypto.randomUUID();
  await harnessed.core.send({ alias: "worker", messageId, threadId, kind: "work", body: "Do one bounded task." });
  return { messageId, threadId };
}

test("an authenticated frame that matches nothing is written down as arrived and correlated to nothing", async () => {
  const harnessed = await harness();
  const unknown = await harnessed.write([status(crypto.randomUUID())]);

  expect(kinds(unknown)).toEqual(["peer_frame_uncorrelated/unknown_message_status"]);
  expect(unknown[0].connectionId).toBe(1);
  expect(unknown[0].frameOrdinal).toBe(2);                         // the auth line was the first
  // an unverified frame names an id we have never issued, and that claim is not written down
  expect(unknown[0].messageId).toBeUndefined();
  expect(harnessed.refusals).toEqual([]);

  const notice = await harnessed.write([idle(crypto.randomUUID())]);
  expect(kinds(notice)).toEqual(["peer_frame_uncorrelated/unknown_idle_notice"]);
  expect(notice[0].connectionId).toBe(2);                          // local to this receiver, and it counts

  const plain = await harnessed.write([text("a line with no marker in it at all")]);
  expect(kinds(plain)).toEqual(["peer_frame_uncorrelated/no_reply_marker"]);

  const { threadId } = await instruction(harnessed);
  const stray = `PEER_REPLY v=1 message_id=${crypto.randomUUID()} thread_id=${threadId} reply_to=${crypto.randomUUID()} verdict=pass`;
  expect(kinds(await harnessed.write([text(stray)]))).toEqual(["peer_frame_uncorrelated/unknown_reply_target"]);
}, 30_000);

test("a frame written by a process the message was not sent to is refused, and the refusal names that message", async () => {
  // aimed at another live process: the writer is nameable, and it is not the one we sent to
  const harnessed = await harness({ targetPid: process.ppid });
  const { messageId } = await instruction(harnessed);
  const refused = await harnessed.write([status(messageId)]);

  expect(kinds(refused)).toEqual(["peer_frame_refused/inbound_identity_mismatch"]);
  expect(refused[0].messageId).toBe(messageId);                    // ours, checked, and so recorded
  expect(refused[0].connectionId).toBe(1);
  expect(refused[0].frameOrdinal).toBe(2);
  expect(harnessed.store.events.map((event) => event.type)).not.toContain("peer_message_status");

  // and it is in front of a wait on that message rather than behind it
  const waited = await harnessed.core.wait({ messageId, require: "delivery", timeoutMs: 200 });
  expect(waited.timedOut).toBe(true);
  expect(kinds(waited.events)).toContain("peer_frame_refused/inbound_identity_mismatch");
}, 30_000);

test("a connection that authenticates and sends nothing leaves nothing", async () => {
  const harnessed = await harness();
  const before = harnessed.store.events.length;
  const socket = net.createConnection({ path: harnessed.socketPath });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`${JSON.stringify({ type: "auth", token: harnessed.token })}\n`);
  await Bun.sleep(250);
  socket.destroy(); await Bun.sleep(80);

  expect(harnessed.store.events.length).toBe(before);
  expect(harnessed.refusals).toEqual([]);
}, 30_000);

test("a token that is not ours and a writer that cannot be named are each refused with their own reason", async () => {
  const wrongToken = await harness();
  const refusedAuth = await wrongToken.write([idle(crypto.randomUUID())], { authenticate: false });
  expect(kinds(refusedAuth)).toEqual(["peer_frame_refused/authentication_failed"]);
  expect(refusedAuth[0].messageId).toBeUndefined();

  const unnameable = await harness({ peerIdentityReader: () => { throw new Error("LOCAL_PEERPID failed (57)"); } });
  const refusedIdentity = await unnameable.write([status(crypto.randomUUID())]);
  expect(kinds(refusedIdentity)).toEqual(["peer_frame_refused/identity_unavailable"]);
  expect(refusedIdentity[0].frameOrdinal).toBe(1);                 // the auth line never got through
}, 30_000);

test("a frame an enabled extension took is not on the uncorrelated list", async () => {
  const harnessed = await harness();
  const { messageId, threadId } = await instruction(harnessed);
  const completionMessageId = crypto.randomUUID();
  const payload = { instruction_id: messageId, attempt_id: crypto.randomUUID(), milestone_id: "M-1", files: ["src/example.mjs"], tests: [{ command: "bun test", scope: "milestone", pass: 7, fail: 0, skip: 0 }], blockers: [], last_signal_at: "2026-09-03T00:00:00Z" };
  const completion = { type: "user", msg_id: crypto.randomUUID(), from: `uds:${harnessed.targetSocketPath}`, message: { content: `MILESTONE_COMPLETED v=1 message_id=${completionMessageId} thread_id=${threadId} reply_to=${messageId}\n${JSON.stringify(payload)}` } };

  const written = await harnessed.write([completion]);
  // core has no reply marker to parse here; the extension answered, and that answer wins
  expect(written.map((event) => event.type)).toContain("milestone_completion_accepted");
  expect(written.map((event) => event.type)).not.toContain("peer_frame_uncorrelated");
  expect(harnessed.milestone.status({ completionMessageId })).toMatchObject({ found: true, state: "ack_reserved" });
}, 30_000);

// What the ledger keeps and what a caller is told are not the same thing. The diagnostics are
// the ledger's: the public event contract has no reason, no connection number and no ordinal,
// and the façade projects a result down to that contract before it validates it. So a diagnostic
// that would be hostile to a public contract — an ordinal of zero, a connection number written
// as a uuid by an older receiver, a reason carrying a socket path — cannot fail a caller's
// query, because it is never in the answer. The residual is written down in
// docs/known-issues.md: a caller reads these by reading the ledger, not over MCP.
test("the diagnostics stay on the ledger and reach neither public projection", async () => {
  const harnessed = await harness();
  await harnessed.write([status(crypto.randomUUID())]);
  await harnessed.store.append("peer_frame_refused", { connectionId: crypto.randomUUID(), frameOrdinal: 0, reason: `${harnessed.socketPath} rejected by ${os.homedir()}` });
  const tools = toolDefinitions(["worker"], { admin: false });
  const call = (facade, id, params) => facade.handle({ jsonrpc: "2.0", id, method: "tools/call", params });
  const listing = () => { const value = harnessed.core.events({}); return { ...value, events: value.events.map(publicLedgerEvent) }; };
  const options = { tools, callTool: async () => listing() };

  const modern = await call(createFacade(options), 1, { _meta: modernMeta(), name: "peer_list_events", arguments: {} });
  const legacyFacade = createFacade(options);
  await legacyFacade.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } } });
  const legacy = await call(legacyFacade, 2, { name: "peer_list_events", arguments: {} });

  for (const response of [modern, legacy]) {
    // the hostile diagnostics did not fail the query — they were not in it
    expect(response.result.isError).toBeUndefined();
    const published = response.result.structuredContent.events.filter((entry) => ["peer_frame_uncorrelated", "peer_frame_refused"].includes(entry.type));
    expect(published.map((entry) => entry.type)).toEqual(["peer_frame_uncorrelated", "peer_frame_refused"]);
    for (const entry of published) {
      expect(Object.keys(entry).sort()).toEqual(["at", "seq", "type"]);
      for (const key of ["reason", "connectionId", "frameOrdinal"]) expect(key in entry).toBe(false);
    }
    const bytes = JSON.stringify(response);
    expect(bytes).not.toContain(harnessed.socketPath);
    expect(bytes).not.toContain(os.homedir());
    expect(bytes).not.toContain(harnessed.token);
    expect(bytes).not.toContain(".sock");
    expect(bytes).not.toContain("unknown_message_status");
  }

  // and the ledger kept every one of them
  const ledger = harnessed.store.events.filter((event) => ["peer_frame_uncorrelated", "peer_frame_refused"].includes(event.type));
  expect(ledger.map((event) => event.reason)).toEqual(["unknown_message_status", `${harnessed.socketPath} rejected by ${os.homedir()}`]);
  expect(ledger[0]).toMatchObject({ connectionId: 1, frameOrdinal: 2 });
  expect(ledger[1].frameOrdinal).toBe(0);
  expect(typeof ledger[1].connectionId).toBe("string");
}, 30_000);
