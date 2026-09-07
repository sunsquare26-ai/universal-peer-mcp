import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalSend, sha256 } from "../src/core/dedupe.mjs";
import { EventStore } from "../src/core/events.mjs";
import { controlCall } from "../src/core/control.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const roots = []; const daemonPids = [];
afterEach(async () => { for (const pid of daemonPids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch {} } await Bun.sleep(30); for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

async function runRaw(input, expectedCount, extraEnv = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-stdio-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const child = spawn("bun", ["src/server.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ...extraEnv, UNIVERSAL_PEER_MCP_STATE_DIR: root } });
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const deadline = Date.now() + 10_000; while (stdout.split("\n").filter(Boolean).length < expectedCount && Date.now() < deadline) await Bun.sleep(10);
  child.kill("SIGTERM");
  let daemon = null; try { daemon = JSON.parse(await fsp.readFile(path.join(root, "daemon.json"), "utf8")); daemonPids.push(daemon.pid); } catch {}
  if (stderr) throw new Error(stderr); return { stdout, rows: stdout.split("\n").filter(Boolean).map(JSON.parse), daemon };
}

// What the façade puts on a command that can reach a target: the daemon it just read and the
// table that daemon says it is holding. A command that carries none is refused before dispatch
// (src/daemon.mjs), so a caller standing where the façade stands carries one. The daemon is
// restarted between rounds below, so it is taken again each time rather than once.
function checkedAgainst(status) { return { daemonPid: status.pid, daemonProcStart: status.procStart, targetsDigest: status.targetsDigest }; }

async function startDaemon(root, extension = "") {
  const daemon = spawn("bun", ["src/daemon.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: root, CLAUDE_PEER_MCP_EXTENSIONS: extension } });
  daemonPids.push(daemon.pid); const file = statePaths(root).daemon;
  for (let i = 0; i < 200 && !(await Bun.file(file).exists()); i += 1) await Bun.sleep(10);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function stopDaemon(root, pid) {
  try { process.kill(pid, "SIGTERM"); } catch {}
  const index = daemonPids.indexOf(pid); if (index >= 0) daemonPids.splice(index, 1);
  const file = statePaths(root).daemon; for (let i = 0; i < 200 && await Bun.file(file).exists(); i += 1) await Bun.sleep(10);
}

test("modern stateless raw stdio list and call", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const { rows } = await runRaw([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } })
  ].join("\n") + "\n", 2);
  expect(rows).toHaveLength(2); expect(rows[0].result.tools).toHaveLength(6); expect(rows[1].result.structuredContent.running).toBe(true);
});

test("legacy raw stdio output is byte-identical, including final newlines", async () => {
  const input = await fsp.readFile(new URL("../fixtures/mcp/legacy-input.jsonl", import.meta.url), "utf8");
  const expected = await fsp.readFile(new URL("../fixtures/mcp/legacy-output.golden.jsonl", import.meta.url), "utf8");
  const { stdout } = await runRaw(input, 3);
  expect(Buffer.from(stdout)).toEqual(Buffer.from(expected));
});

test("milestone-enabled stateless call is byte-identical to its golden", async () => {
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }, name: "milestone_status", arguments: { completionMessageId: "10000000-0000-4000-8000-000000000099" } } })}\n`;
  const expected = await fsp.readFile(new URL("../fixtures/mcp/milestone-output.golden.jsonl", import.meta.url), "utf8");
  const { stdout } = await runRaw(input, 1, { CLAUDE_PEER_MCP_EXTENSIONS: "milestone" });
  expect(Buffer.from(stdout)).toEqual(Buffer.from(expected));
});

test("admin tool visibility comes from authenticated daemon status", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })}\n`;
  const { rows } = await runRaw(input, 1, { CLAUDE_PEER_MCP_ADMIN: "1" });
  expect(rows[0].result.tools.map((tool) => tool.name)).toEqual(["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status", "daemon_shutdown"]);
});

test("milestone tools are optional and one durable store replays across off-on-off daemon restarts", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-stdio-replay-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
  const sessionId = crypto.randomUUID(); await fsp.writeFile(paths.targets, `${JSON.stringify({ worker: { sessionId, cwd: root, permissionMode: "prompting" } })}\n`, { mode: 0o600 });
  const args = { alias: "worker", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "work", body: "durable replay" };
  const store = new EventStore(paths); await store.init(); await store.append("send_requested", { messageId: args.messageId, transportMessageId: args.messageId, threadId: args.threadId, replyTo: null, kind: args.kind, alias: args.alias, requestHash: sha256(canonicalSend(args)), subscriptionId: crypto.randomUUID() }); await store.close();
  for (const extension of ["", "milestone", ""]) {
    const daemon = await startDaemon(root, extension);
    const status = await controlCall("daemon_status", {}, { root }); expect(status.enabledExtensions).toEqual(extension ? ["milestone"] : []);
    const sending = { root, expect: checkedAgainst(status) };
    const before = (await controlCall("peer_list_events", { messageId: args.messageId }, { root })).events.length;
    for (const extra of [{ recovery: true }, { afterReservation: "inject" }]) await expect(controlCall("peer_send", { ...args, ...extra }, sending)).rejects.toMatchObject({ code: "INVALID_CONTROL_ARGUMENTS" });
    expect((await controlCall("peer_list_events", { messageId: args.messageId }, { root })).events).toHaveLength(before);
    expect(await controlCall("peer_send", args, sending)).toMatchObject({ replay: true, messageId: args.messageId });
    expect((await controlCall("peer_list_events", { messageId: args.messageId }, { root })).events.some((event) => event.type === "send_recovery_reserved")).toBeFalse();
    await stopDaemon(root, daemon.pid);
  }
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })}\n`;
  const off = await runRaw(input, 1); const on = await runRaw(input, 1, { CLAUDE_PEER_MCP_EXTENSIONS: "milestone", CLAUDE_PEER_MCP_ADMIN: "1" });
  expect(off.rows[0].result.tools.map((tool) => tool.name)).toEqual(["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status"]);
  expect(on.rows[0].result.tools.map((tool) => tool.name)).toEqual(["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status", "milestone_status", "milestone_list", "milestone_wait", "milestone_recover_ack", "daemon_shutdown"]);
});

test("a running daemon is the extension authority and reports launch mismatch", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-stdio-authority-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const daemon = spawn("bun", ["src/daemon.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: root } }); daemonPids.push(daemon.pid);
  const daemonFile = path.join(root, "daemon.json"); for (let i = 0; i < 200 && !(await Bun.file(daemonFile).exists()); i += 1) await Bun.sleep(10);
  const child = spawn("bun", ["src/server.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: root, CLAUDE_PEER_MCP_EXTENSIONS: "milestone" } });
  let stdout = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } })].join("\n") + "\n");
  for (let i = 0; i < 200 && stdout.split("\n").filter(Boolean).length < 2; i += 1) await Bun.sleep(10); child.kill("SIGTERM"); const rows = stdout.split("\n").filter(Boolean).map(JSON.parse);
  expect(rows[0].result.tools).toHaveLength(6); expect(rows[1].result.structuredContent).toMatchObject({ enabledExtensions: [], requestedExtensions: ["milestone"], extensionMismatch: true });
});

test("an extension-enabled daemon reports a reverse launch mismatch without losing its tools", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-stdio-reverse-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const daemon = spawn("bun", ["src/daemon.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: root, CLAUDE_PEER_MCP_EXTENSIONS: "milestone" } }); daemonPids.push(daemon.pid);
  const daemonFile = path.join(root, "daemon.json"); for (let i = 0; i < 200 && !(await Bun.file(daemonFile).exists()); i += 1) await Bun.sleep(10);
  const child = spawn("bun", ["src/server.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: root, CLAUDE_PEER_MCP_EXTENSIONS: "" } });
  let stdout = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } })].join("\n") + "\n");
  for (let i = 0; i < 200 && stdout.split("\n").filter(Boolean).length < 2; i += 1) await Bun.sleep(10); child.kill("SIGTERM"); const rows = stdout.split("\n").filter(Boolean).map(JSON.parse);
  expect(rows[0].result.tools.map((tool) => tool.name)).toEqual(["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status", "milestone_status", "milestone_list", "milestone_wait", "milestone_recover_ack"]);
  expect(rows[1].result.structuredContent).toMatchObject({ enabledExtensions: ["milestone"], requestedExtensions: [], extensionMismatch: true });
});

test("a non-admin daemon rejects daemon_shutdown and stays alive", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: "daemon_shutdown", arguments: {} } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } })
  ].join("\n") + "\n";
  const { rows } = await runRaw(input, 2); expect(rows[0].error.code).toBe(-32602); expect(rows[1].result.structuredContent.running).toBe(true);
});

test("rejects an oversized frame before parsing and resumes on the next frame", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const oversized = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { body: "x".repeat(1024 * 1024) } })}\n`;
  const valid = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } })}\n`;
  const { rows } = await runRaw(oversized + valid, 2);
  expect(rows[0].error).toEqual({ code: -32700, message: "frame too large" }); expect(rows[1].result.tools).toHaveLength(6);
});

test("closing the façade stdin does not shut down the daemon", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const { daemon } = await runRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })}\n`, 1);
  expect(daemon?.pid).toBeInteger(); expect(() => process.kill(daemon.pid, 0)).not.toThrow();
});
