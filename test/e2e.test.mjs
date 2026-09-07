// End to end from a clean clone. Every step below runs for real: git clone, npm pack,
// npm install into an empty prefix, the installed bin, the singleton daemon, the
// authenticated control socket, the claude-native-v1 registry and the UDS write.
//
// One thing is a stand-in, and only one: the peer on the other end of the socket is
// test/e2e-claude-host.mjs, not a running Claude Code session, and the MCP client is raw
// JSONL on stdin, not Codex. Everything the server checks about that peer — uid, pid,
// process start time, permission argv, socket mode, auth key — is checked against a real
// process for real. A live Claude Code or Codex round trip needs a person at the machine
// and is not attempted here.
//
// The run is isolated: HOME and the state directory point into one temporary tree, so the
// developer's own session registry is never read or written. The one path this build
// cannot redirect is the shared peer socket directory, which the receiver hard codes; the
// tests below assert that the only entries this run adds there are its own daemons and
// that all of them are gone at the end.
import { afterAll, expect, test } from "bun:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateSchema } from "../src/mcp/schema-validator.mjs";
import { procStartOf, signalChild, signalOwned } from "./owned-signal.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const HOST_SCRIPT = path.join(ROOT, "test", "e2e-claude-host.mjs");
const REAL_SESSIONS = path.join(os.homedir(), ".claude", "sessions");
const SHARED_SOCKETS = "/tmp/cc-socks";
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const META = { [PROTOCOL_KEY]: "2026-07-28", [CAPS_KEY]: {} };
const CORE_TOOLS = ["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status"];
const MILESTONE_TOOLS = ["milestone_status", "milestone_list", "milestone_wait", "milestone_recover_ack"];
const REVIEW_TOOLS = ["code_review_status", "code_review_list", "code_review_wait", "code_review_request"];
const fx = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// pid -> the process start time read when that pid was first seen. Nothing here is ever
// signalled on the pid alone; see test/owned-signal.mjs for why.
const steps = []; const daemonPids = new Map(); const children = new Set();

// ---------------------------------------------------------------- workspace

const work = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "peer-e2e-")));
await fsp.chmod(work, 0o700);
const dirs = Object.fromEntries(["home", "state", "project", "sockets", "tarball", "prefix", "clone", "cache", "logs"].map((name) => [name, path.join(work, name)]));
dirs.sessions = path.join(dirs.home, ".claude", "sessions");
for (const dir of Object.values(dirs)) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
await fsp.chmod(dirs.sessions, 0o700); await fsp.chmod(dirs.sockets, 0o700); await fsp.chmod(dirs.state, 0o700);
const readyFile = path.join(work, "peer-ready.json");
const hostLog = path.join(work, "peer-frames.jsonl");
const bin = path.join(dirs.prefix, "bin", "claude-peer-mcp");
const installed = path.join(dirs.prefix, "lib", "node_modules", "claude-peer-mcp");

const baseline = { sessions: await names(REAL_SESSIONS), sockets: await names(SHARED_SOCKETS), tree: await treeHash(ROOT) };

// clone the repository from a local path, never a remote, then bring the working tree over
// it. The overlay is here because the milestone under review is not committed yet; the
// assertion right after it is what makes the tarball trustworthy — the packed tree is
// byte for byte the tree on disk.
await step("git clone", "git", ["clone", "--no-hardlinks", "--quiet", ROOT, dirs.clone]);
for (const file of execFileSync("git", ["-C", ROOT, "ls-files", "-z", "-c", "-o", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
  const to = path.join(dirs.clone, file);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(path.join(ROOT, file), to);
}
const cloneTree = await treeHash(dirs.clone);
const packed = await step("npm pack", "npm", npmArgs(["pack", "--pack-destination", dirs.tarball, "--json"]), { cwd: dirs.clone });
const tarball = path.join(dirs.tarball, JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0].filename);
await step("npm install -g", "npm", npmArgs(["install", "-g", "--prefix", dirs.prefix, tarball]), { cwd: work });

// SIGTERM first on purpose: a killed daemon cannot unlink the socket it published in the
// shared directory, and this run must not leave one there. Every signal goes through the
// ownership check, so a pid this run has finished with is left alone even if it is alive
// again as something else.
afterAll(async () => {
  for (const child of children) signalChild(child, "SIGTERM");
  signalOwned(daemonPids, "SIGTERM");
  await Bun.sleep(400);
  for (const child of children) signalChild(child, "SIGKILL");
  signalOwned(daemonPids, "SIGKILL");
  await Bun.sleep(50);
  if (process.env.PEER_E2E_KEEP) console.log(`e2e: kept ${work}`);
  else await fsp.rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1. clean install

test("a clean clone packs, installs into an empty prefix and starts with no user state", async () => {
  expect(steps.map((entry) => entry.code)).toEqual([0, 0, 0]);
  expect(cloneTree.hash).toBe(baseline.tree.hash);
  expect(cloneTree.files).toBe(baseline.tree.files);
  // packing and installing must not touch the tree they read
  expect(await treeHash(dirs.clone)).toEqual(cloneTree);

  expect((await fsp.stat(path.join(dirs.prefix, "bin", "claude-peer-mcp"))).isFile() || (await fsp.lstat(bin)).isSymbolicLink()).toBeTrue();
  for (const shipped of ["src/cli.mjs", "src/daemon.mjs", "src/doctor.mjs", "README.md", "LICENSE", "SECURITY.md", "targets.example.json"]) {
    expect((await fsp.stat(path.join(installed, shipped))).isFile()).toBeTrue();
  }
  for (const absent of ["test", "fixtures", "node_modules", "package-lock.json"]) expect(await missing(path.join(installed, absent))).toBeTrue();

  // doctor writes nothing, and the state directory it names is the one the environment
  // chose, not the developer's.
  const report = await run(bin, ["doctor"], { env: env({ CLAUDE_PEER_MCP_STATE_DIR: dirs.state }) });
  expect(report.code).toBe(0); expect(report.stderr).toBe("");
  const document = JSON.parse(report.stdout);
  expect(document.state).toMatchObject({ present: true });
  expect(document.claudeRegistry.present).toBeTrue();
  expect(JSON.stringify(document)).not.toContain(work);
  expect(JSON.stringify(document)).not.toContain(os.homedir());

  // with no override the default is under the redirected home, which is the proof that the
  // isolation is real and not a naming coincidence.
  const bare = await run(bin, ["doctor"], { env: env() });
  expect(bare.code).toBe(0);
  expect(JSON.parse(bare.stdout).stateDirectory).toBe("~/Library/Application Support/claude-peer-mcp");
  expect(await missing(path.join(dirs.home, "Library", "Application Support", "claude-peer-mcp"))).toBeTrue();
}, 300_000);

// ---------------------------------------------------------------- 2. wire contracts

test("both wires answer from the installed bin, and the optional tool lists toggle on one empty store", async () => {
  const legacyInput = await fsp.readFile(new URL("../fixtures/mcp/legacy-input.jsonl", import.meta.url), "utf8");
  const legacyGolden = await fsp.readFile(new URL("../fixtures/mcp/legacy-output.golden.jsonl", import.meta.url), "utf8");
  const legacy = await raw(legacyInput, 3);
  expect(Buffer.from(legacy.stdout)).toEqual(Buffer.from(legacyGolden));

  const schema = JSON.parse(await fsp.readFile(new URL("../fixtures/mcp/official-schema-2026-07-28.json", import.meta.url), "utf8"));
  const modernInput = await fsp.readFile(new URL("../fixtures/mcp/modern-input.jsonl", import.meta.url), "utf8");
  const modern = await raw(`${modernInput}${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: META, name: "daemon_status", arguments: {} } })}\n`, 3);
  for (const [definition, value] of [["DiscoverResultResponse", modern.rows[0]], ["ListToolsResultResponse", modern.rows[1]], ["CallToolResultResponse", modern.rows[2]]]) {
    expect(validateSchema(schema.$defs[definition], value, { root: schema })).toEqual({ valid: true, errors: [] });
  }
  const mismatch = await raw(await fsp.readFile(new URL("../fixtures/mcp/version-mismatch-input.jsonl", import.meta.url), "utf8"), 1);
  expect(mismatch.rows[0].error).toEqual({ code: -32022, message: "UnsupportedProtocolVersion", data: { requested: "2099-01-01", supported: ["2026-07-28"] } });
  expect(validateSchema(schema.$defs.UnsupportedProtocolVersionError, mismatch.rows[0], { root: schema }).valid).toBeTrue();

  // off, on, on, both, off — all against the same state directory, which is still empty.
  const list = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } })}\n`;
  expect((await raw(list, 1)).rows[0].result.tools.map((tool) => tool.name)).toEqual(CORE_TOOLS);
  expect((await raw(list, 1, { enable: ["milestone"] })).rows[0].result.tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...MILESTONE_TOOLS]);
  expect((await raw(list, 1, { enable: ["code-review"] })).rows[0].result.tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...REVIEW_TOOLS]);
  expect((await raw(list, 1, { enable: ["milestone", "code-review"], admin: true })).rows[0].result.tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...MILESTONE_TOOLS, ...REVIEW_TOOLS, "daemon_shutdown"]);
  expect((await raw(list, 1)).rows[0].result.tools.map((tool) => tool.name)).toEqual(CORE_TOOLS);

  // golden bytes for each optional tool, still on the same empty store
  const milestone = await raw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: META, name: "milestone_status", arguments: { completionMessageId: fx(99) } } })}\n`, 1, { enable: ["milestone"] });
  expect(Buffer.from(milestone.stdout)).toEqual(Buffer.from(await fsp.readFile(new URL("../fixtures/mcp/milestone-output.golden.jsonl", import.meta.url), "utf8")));
  const review = await raw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: META, name: "code_review_status", arguments: { reviewId: fx(199) } } })}\n`, 1, { enable: ["code-review"] });
  expect(Buffer.from(review.stdout)).toEqual(Buffer.from(await fsp.readFile(new URL("../fixtures/mcp/code-review-output.golden.jsonl", import.meta.url), "utf8")));

  expect(await ledger()).toHaveLength(0);
  await stopDaemon();
}, 300_000);

// ---------------------------------------------------------------- 3. modern round trip

test("modern wire: register a target, send once, and read the delivery, ACK, reply and idle back", async () => {
  await fsp.writeFile(path.join(dirs.state, "targets.json"), `${JSON.stringify({ review: { sessionId: fx(1), cwd: dirs.project, expectedDisplayName: "Peer review", permissionMode: "prompting" } })}\n`, { mode: 0o600 });
  await startHost();
  await stopDaemon();

  const session = await open();
  expect(await session.call("peer_targets", {})).toEqual([{ alias: "review", connected: false, permissionMode: "prompting", expectedDisplayName: "Peer review", observedDisplayName: null }]);

  const host = JSON.parse(await fsp.readFile(readyFile, "utf8"));
  const status = await session.call("peer_status", { alias: "review" });
  expect(status).toMatchObject({ alias: "review", connected: true, sessionId: fx(1), cwdMatches: true, observedDisplayName: "Peer session", pid: host.pid });
  expect(status.permission).toEqual({ mode: "prompting", verifiedBy: "kern_procargs2" });

  const sent = await session.call("peer_send", { alias: "review", messageId: fx(10), threadId: fx(11), kind: "question", body: "please answer once" });
  expect(sent).toMatchObject({ replay: false, messageId: fx(10), status: "written", alias: "review" });
  expect(sent.requestHash).toMatch(/^[0-9a-f]{64}$/);

  const ack = await session.call("peer_wait", { messageId: fx(10), require: "ack", timeoutMs: 20_000 });
  expect(ack.event).toMatchObject({ type: "peer_ack", messageId: fx(10), threadId: fx(11), evidence: "application_ack" });
  const reply = await session.call("peer_wait", { messageId: fx(10), require: "reply", timeoutMs: 20_000 });
  expect(reply.event).toMatchObject({ type: "peer_reply", messageId: fx(10), verdict: "pass" });
  const idle = await session.call("peer_wait", { messageId: fx(10), require: "idle", timeoutMs: 20_000 });
  expect(idle.event).toMatchObject({ type: "peer_idle_notice", state: "idle", evidence: "idle_notice" });

  const listing = await session.call("peer_list_events", { messageId: fx(10) });
  expect(listing.events.map((event) => event.type)).toEqual(["send_requested", "socket_write_complete", "peer_message_status", "peer_ack", "peer_reply", "peer_idle_notice"]);
  expect(listing.events.map((event) => event.seq)).toEqual([...listing.events.map((event) => event.seq)].sort((a, b) => a - b));
  expect(listing.events.find((event) => event.type === "peer_message_status").status).toBe("delivered");
  expect((await ledger()).some((event) => event.type === "display_name_observed")).toBeTrue();
  // the stand-in peer really closes its reply connection, and the daemon still read the writer
  // out of the kernel for every one of those frames: not one of them was refused, and there is
  // no other way for a frame to have got here.
  expect((await ledger()).filter((event) => event.type === "peer_frame_refused")).toEqual([]);

  // the same id twice is one send; the same id with a different body is refused.
  expect(await session.call("peer_send", { alias: "review", messageId: fx(10), threadId: fx(11), kind: "question", body: "please answer once" })).toMatchObject({ replay: true, status: "replied" });
  const conflict = await session.raw("peer_send", { alias: "review", messageId: fx(10), threadId: fx(11), kind: "question", body: "a different body" });
  expect(conflict.result.isError).toBeTrue();
  expect(conflict.result.structuredContent).toEqual({ reason: "message_id_conflict" });

  // nothing private crosses the wire
  const bytes = session.transcript();
  for (const secret of [work, os.homedir(), ".sock", "peerToken", "control.token"]) expect(bytes).not.toContain(secret);

  const frames = (await fsp.readFile(hostLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const answered = frames.find((entry) => entry.event === "answered");
  expect(answered).toMatchObject({ messageId: fx(10), mode: "prompting", name: "Claude MCP" });
  expect(frames.some((entry) => entry.event === "authenticated")).toBeTrue();
  await session.close();
}, 300_000);

// ---------------------------------------------------------------- 4. legacy round trip

test("legacy wire: the same daemon answers an initialize client with its own codec", async () => {
  const session = await open({ era: "legacy" });
  const hello = await session.send({ jsonrpc: "2.0", id: 101, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  expect(hello.result).toEqual({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "claude-peer-mcp", version: "0.1.0" } });
  session.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = await session.send({ jsonrpc: "2.0", id: 102, method: "tools/list", params: {} });
  expect(tools.result.tools.map((tool) => tool.name)).toEqual(CORE_TOOLS);
  expect(tools.result.resultType).toBeUndefined();
  expect(tools.result._meta).toBeUndefined();
  expect(tools.result.tools[1].inputSchema.properties.alias.enum).toEqual(["review"]);

  const sent = await session.call("peer_send", { alias: "review", messageId: fx(20), threadId: fx(21), kind: "question", body: "answer the legacy client once" });
  expect(sent).toMatchObject({ replay: false, messageId: fx(20), status: "written" });
  const reply = await session.call("peer_wait", { messageId: fx(20), require: "reply", timeoutMs: 20_000 });
  expect(reply.event).toMatchObject({ type: "peer_reply", messageId: fx(20), verdict: "pass" });

  // a legacy connection cannot borrow modern metadata half way through
  const mixed = await session.send({ jsonrpc: "2.0", id: 109, method: "tools/list", params: { _meta: META } });
  expect(mixed.error).toEqual({ code: -32602, message: "MCP eras cannot be mixed" });
  await session.close();
}, 300_000);

// ---------------------------------------------------------------- 5. restart

test("a restarted daemon replays the ledger, cleans its own artefacts and keeps the target usable", async () => {
  const before = await ledger();
  const row = JSON.parse(await fsp.readFile(path.join(dirs.state, "daemon.json"), "utf8"));
  const receiver = path.join(SHARED_SOCKETS, `${row.pid}.sock`);
  expect(await missing(receiver)).toBeFalse();

  // the redirect is real, not a naming coincidence: the daemon announced itself inside the
  // temporary home and nowhere near the developer's own registry
  const announced = (await fsp.readdir(dirs.sessions)).filter((name) => name.startsWith(`${row.pid}.`));
  expect(announced).toContain(`${row.pid}.json`);
  expect(announced).toHaveLength(2);
  expect(JSON.parse(await fsp.readFile(path.join(dirs.sessions, `${row.pid}.json`), "utf8")).messagingSocketPath).toBe(receiver);
  expect(await names(REAL_SESSIONS)).not.toContain(`${row.pid}.json`);

  await stopDaemon();
  for (const artefact of ["daemon.json", "daemon.lock", "control.sock", "control.token"]) expect(await missing(path.join(dirs.state, artefact))).toBeTrue();
  expect(await missing(receiver)).toBeTrue();
  expect(await missing(path.join(dirs.sessions, `${row.pid}.json`))).toBeTrue();
  expect((await fsp.readdir(dirs.sessions)).filter((name) => name.startsWith(`${row.pid}.`))).toEqual([]);

  const session = await open();
  const restarted = await session.call("daemon_status", {});
  expect(restarted.pid).not.toBe(row.pid);
  expect(restarted.eventSeq).toBe(before.length);
  expect(restarted.targetCount).toBe(1);

  const replayed = await session.call("peer_list_events", {});
  expect(replayed.events.map((event) => `${event.seq}:${event.type}`)).toEqual(before.map((event) => `${event.seq}:${event.type}`));
  expect(await session.call("peer_send", { alias: "review", messageId: fx(10), threadId: fx(11), kind: "question", body: "please answer once" })).toMatchObject({ replay: true, status: "replied" });
  expect((await ledger()).length).toBe(before.length);

  // the rebuilt receiver is announced again, so a new message still completes
  const sent = await session.call("peer_send", { alias: "review", messageId: fx(30), threadId: fx(31), kind: "question", body: "answer after the restart" });
  expect(sent).toMatchObject({ replay: false, status: "written" });
  const reply = await session.call("peer_wait", { messageId: fx(30), require: "reply", timeoutMs: 20_000 });
  expect(reply.event).toMatchObject({ type: "peer_reply", messageId: fx(30), verdict: "pass" });
  await session.close();
}, 300_000);

// ---------------------------------------------------------------- 6. optional extensions

test("optional extensions go off, on and off again over the same live store", async () => {
  const before = await ledger();
  expect(before.length).toBeGreaterThan(0);
  const seen = [];
  for (const enable of [[], ["milestone"], ["code-review"], ["milestone", "code-review"], []]) {
    await stopDaemon();
    const session = await open({ enable });
    const status = await session.call("daemon_status", {});
    expect(status.eventSeq).toBe(before.length);
    expect(status.targetCount).toBe(1);
    const names = (await session.send({ jsonrpc: "2.0", id: 900, method: "tools/list", params: { _meta: META } })).result.tools.map((tool) => tool.name);
    seen.push(names);
    expect(names).toEqual([...CORE_TOOLS, ...(enable.includes("milestone") ? MILESTONE_TOOLS : []), ...(enable.includes("code-review") ? REVIEW_TOOLS : [])]);

    // with the extension off its tool is not merely hidden, it is refused
    const probe = await session.send({ jsonrpc: "2.0", id: 901, method: "tools/call", params: { _meta: META, name: "milestone_status", arguments: { completionMessageId: fx(99) } } });
    if (enable.includes("milestone")) {
      const expected = (await fsp.readFile(new URL("../fixtures/mcp/milestone-output.golden.jsonl", import.meta.url), "utf8")).replace('"id":1,', '"id":901,').replace('"cursor":0', `"cursor":${before.length}`);
      expect(`${JSON.stringify(probe)}\n`).toBe(expected);
    } else {
      expect(probe.error).toEqual({ code: -32602, message: "invalid tools/call parameters" });
    }
    expect((await ledger()).length).toBe(before.length);
    await session.close();
  }
  expect(seen[0]).toEqual(seen[4]);
  expect(seen[0]).toEqual(CORE_TOOLS);
}, 300_000);

// ---------------------------------------------------------------- 7. removal

test("uninstall removes the package, keeps the user's state and leaves nothing behind", async () => {
  await stopDaemon();
  await stopHost();

  const uninstall = await run("npm", npmArgs(["uninstall", "-g", "--prefix", dirs.prefix, "claude-peer-mcp"]), { cwd: work });
  expect(uninstall.code).toBe(0);
  expect(await missing(installed)).toBeTrue();
  expect(await missing(bin)).toBeTrue();

  // user state is the user's: removal never deletes it
  expect((await fsp.stat(path.join(dirs.state, "targets.json"))).isFile()).toBeTrue();
  expect((await ledger()).length).toBeGreaterThan(0);

  // the repository gained and lost nothing: no tarball, no state file, no stray directory.
  // This compares the set of paths, not their content: a person editing an unrelated file
  // while the suite runs is not this test's business, but a new file is.
  const after = await treeHash(ROOT);
  expect(after.paths).toEqual(baseline.tree.paths);
  expect((await fsp.readdir(ROOT)).filter((name) => name.endsWith(".tgz"))).toEqual([]);

  // the developer's own registry and the shared socket directory are untouched: nothing of
  // the baseline was removed and nothing this run started is still there.
  const sessions = await names(REAL_SESSIONS); const sockets = await names(SHARED_SOCKETS);
  expect(baseline.sessions.filter((name) => !sessions.includes(name))).toEqual([]);
  expect(baseline.sockets.filter((name) => !sockets.includes(name))).toEqual([]);
  const ours = [...daemonPids.keys()].flatMap((pid) => [`${pid}.json`, `${pid}.sock`]);
  expect(ours.filter((name) => sessions.includes(name) || sockets.includes(name))).toEqual([]);
  console.log(`e2e: real sessions ${baseline.sessions.length}->${sessions.length}, shared sockets ${baseline.sockets.length}->${sockets.length}, daemons started ${daemonPids.size}, packed tree ${cloneTree.hash.slice(0, 12)} over ${after.files} repository files`);

  // the temporary tree is the only thing this test owns, and afterAll deletes it
  expect(work.startsWith(await fsp.realpath(os.tmpdir()))).toBeTrue();
}, 300_000);

// ---------------------------------------------------------------- helpers

function npmArgs(extra) {
  // offline with an empty cache and a closed port: a network attempt fails loudly here
  // instead of quietly succeeding.
  return [...extra, "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--cache", dirs.cache, "--logs-dir", dirs.logs, "--registry", "http://127.0.0.1:9/"];
}

function env(extra = {}) {
  const base = { ...process.env, HOME: dirs.home };
  for (const key of Object.keys(base)) if (key.startsWith("CLAUDE_PEER_MCP_")) delete base[key];
  return { ...base, ...extra };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

async function step(name, command, args, options) {
  const result = await run(command, args, options);
  steps.push({ name, code: result.code });
  if (result.code !== 0) throw new Error(`${name} failed (${result.code}): ${result.stderr.slice(0, 400)}`);
  return result;
}

function serveArgs({ enable = [] } = {}) { return ["serve", ...enable.flatMap((name) => ["--enable", name])]; }
function serveEnv({ admin = false } = {}) { return env({ CLAUDE_PEER_MCP_STATE_DIR: dirs.state, ...(admin ? { CLAUDE_PEER_MCP_ADMIN: "1" } : {}) }); }

// one shot: feed the façade a whole input and keep the exact bytes it wrote back
async function raw(input, expected, options = {}) {
  await stopDaemon();
  const child = spawn(bin, serveArgs(options), { cwd: work, env: serveEnv(options) });
  children.add(child);
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const deadline = Date.now() + 30_000;
  while (stdout.split("\n").filter(Boolean).length < expected && Date.now() < deadline) await Bun.sleep(10);
  signalChild(child, "SIGTERM"); children.delete(child);
  await noteDaemon();
  if (stderr) throw new Error(stderr);
  const rows = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  expect(rows).toHaveLength(expected);
  return { stdout, rows };
}

// a conversation: write one request, wait for the answer with that id, keep going
async function open({ enable = [], admin = false, era = "modern" } = {}) {
  const child = spawn(bin, serveArgs({ enable }), { cwd: work, env: serveEnv({ admin }) });
  children.add(child);
  let buffer = ""; let transcript = ""; let stderr = ""; let id = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk; transcript += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      pending.get(row.id)?.(row); pending.delete(row.id);
    }
  });
  const send = (request) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer for ${request.method} ${request.id}`)), 60_000);
    pending.set(request.id, (row) => { clearTimeout(timer); resolve(row); });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
  const session = {
    send,
    notify: (request) => child.stdin.write(`${JSON.stringify(request)}\n`),
    transcript: () => transcript,
    async raw(name, args) {
      id += 1;
      const params = era === "modern" ? { _meta: META, name, arguments: args } : { name, arguments: args };
      return send({ jsonrpc: "2.0", id, method: "tools/call", params });
    },
    async call(name, args) {
      const row = await session.raw(name, args);
      if (row.error) throw new Error(`${name}: ${row.error.message}`);
      if (row.result.isError) throw new Error(`${name}: ${JSON.stringify(row.result.structuredContent)}`);
      return row.result.structuredContent;
    },
    async close() {
      signalChild(child, "SIGTERM"); children.delete(child);
      await noteDaemon();
      if (stderr) throw new Error(stderr);
    }
  };
  if (era === "modern") {
    const info = await send({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: META } });
    expect(info.result._meta[SERVER_INFO_KEY]).toEqual({ name: "claude-peer-mcp", version: "0.1.0" });
  }
  await noteDaemon();
  return session;
}

// the daemon publishes its own start time next to its pid; that is the value the ownership
// check compares against later, and it is read here while the daemon is still running.
async function noteDaemon() {
  try { const row = JSON.parse(await fsp.readFile(path.join(dirs.state, "daemon.json"), "utf8")); rememberDaemon(row); } catch {}
}

function rememberDaemon(row) {
  if (!Number.isInteger(row?.pid)) return;
  const procStart = typeof row.procStart === "string" ? row.procStart : procStartOf(row.pid);
  if (procStart) daemonPids.set(row.pid, procStart);
}

async function stopDaemon() {
  let row = null;
  try { row = JSON.parse(await fsp.readFile(path.join(dirs.state, "daemon.json"), "utf8")); } catch { return null; }
  rememberDaemon(row);
  signalOwned(new Map([[row.pid, daemonPids.get(row.pid)]]), "SIGTERM");
  await until(async () => await missing(path.join(dirs.state, "daemon.json")), "daemon did not shut down");
  return row;
}

async function startHost() {
  const child = spawn(process.execPath, [
    HOST_SCRIPT, "--permission-mode", "default",
    "--sessions-dir", dirs.sessions, "--socket-dir", dirs.sockets, "--cwd", dirs.project,
    "--session-id", fx(1), "--display-name", "Peer session", "--ready-file", readyFile, "--log-file", hostLog
  ], { cwd: dirs.project, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child); hostChild = child;
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  await until(async () => !(await missing(readyFile)), () => `the stand-in peer did not start: ${stderr}`);
  return JSON.parse(await fsp.readFile(readyFile, "utf8"));
}

let hostChild = null;
async function stopHost() {
  if (!hostChild) return;
  signalChild(hostChild, "SIGTERM"); children.delete(hostChild);
  await until(async () => await missing(readyFile), "the stand-in peer did not clean up");
  hostChild = null;
}

async function ledger() {
  try { return (await fsp.readFile(path.join(dirs.state, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

async function until(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await Bun.sleep(20); }
  throw new Error(typeof message === "function" ? message() : message);
}

async function missing(file) { try { await fsp.lstat(file); return false; } catch { return true; } }
async function names(dir) { try { return (await fsp.readdir(dir)).sort(); } catch { return []; } }

// the same walk the release recipe uses: every regular file except the git directory and
// the build output, hashed in byte order.
async function treeHash(dir) {
  const files = [];
  const walk = async (rel) => {
    for (const entry of await fsp.readdir(path.join(dir, rel || "."), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && (entry.name === ".git" || entry.name === "dist")) continue;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) files.push(`./${next}`);
    }
  };
  await walk("");
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const outer = crypto.createHash("sha256");
  for (const file of files) outer.update(`${crypto.createHash("sha256").update(await fsp.readFile(path.join(dir, file))).digest("hex")}  ${file}\n`);
  return { hash: outer.digest("hex"), files: files.length, paths: files };
}
