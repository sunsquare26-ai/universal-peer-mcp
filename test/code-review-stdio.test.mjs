import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { controlCall } from "../src/core/control.mjs";
import { canonicalSend, sha256 } from "../src/core/dedupe.mjs";
import { EventStore } from "../src/core/events.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { requestBody } from "../src/extensions/code-review/index.mjs";

const roots = []; const daemonPids = [];
afterEach(async () => { for (const pid of daemonPids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch {} } await Bun.sleep(30); for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const CORE_TOOLS = ["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status"];
const MILESTONE_TOOLS = ["milestone_status", "milestone_list", "milestone_wait", "milestone_recover_ack"];
const CODE_REVIEW_TOOLS = ["code_review_status", "code_review_list", "code_review_wait", "code_review_request"];
const fx = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function runRaw(input, expectedCount, extraEnv = {}, root = null) {
  if (!root) { const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-code-review-stdio-")); roots.push(made); await fsp.chmod(made, 0o700); root = await fsp.realpath(made); }
  const child = spawn("bun", ["src/server.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ...extraEnv, CLAUDE_PEER_MCP_STATE_DIR: root } });
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const deadline = Date.now() + 10_000; while (stdout.split("\n").filter(Boolean).length < expectedCount && Date.now() < deadline) await Bun.sleep(10);
  child.kill("SIGTERM");
  let daemon = null; try { daemon = JSON.parse(await fsp.readFile(path.join(root, "daemon.json"), "utf8")); if (!daemonPids.includes(daemon.pid)) daemonPids.push(daemon.pid); } catch {}
  if (stderr) throw new Error(stderr); return { stdout, rows: stdout.split("\n").filter(Boolean).map(JSON.parse), daemon, root };
}

async function startDaemon(root, extension = "") {
  const daemon = spawn("bun", ["src/daemon.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, CLAUDE_PEER_MCP_STATE_DIR: root, CLAUDE_PEER_MCP_EXTENSIONS: extension } });
  daemonPids.push(daemon.pid); const file = statePaths(root).daemon;
  for (let i = 0; i < 200 && !(await Bun.file(file).exists()); i += 1) await Bun.sleep(10);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function stopDaemon(root, pid) {
  try { process.kill(pid, "SIGTERM"); } catch {}
  const index = daemonPids.indexOf(pid); if (index >= 0) daemonPids.splice(index, 1);
  const file = statePaths(root).daemon; for (let i = 0; i < 200 && await Bun.file(file).exists(); i += 1) await Bun.sleep(10);
}

test("code-review tools are optional and sit after milestone tools with admin shutdown last", async () => {
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })}\n`;
  const off = await runRaw(input, 1); expect(off.rows[0].result.tools.map((tool) => tool.name)).toEqual(CORE_TOOLS);
  const on = await runRaw(input, 1, { CLAUDE_PEER_MCP_EXTENSIONS: "code-review" }); expect(on.rows[0].result.tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...CODE_REVIEW_TOOLS]);
  const both = await runRaw(input, 1, { CLAUDE_PEER_MCP_EXTENSIONS: "milestone,code-review", CLAUDE_PEER_MCP_ADMIN: "1" }); expect(both.rows[0].result.tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...MILESTONE_TOOLS, ...CODE_REVIEW_TOOLS, "daemon_shutdown"]);
  const legacy = await runRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`, 2, { CLAUDE_PEER_MCP_EXTENSIONS: "code-review" });
  expect(legacy.rows[1].result.tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...CODE_REVIEW_TOOLS]);
});

test("code-review-enabled stateless call is byte-identical to its golden", async () => {
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: "code_review_status", arguments: { reviewId: fx(199) } } })}\n`;
  const expected = await fsp.readFile(new URL("../fixtures/mcp/code-review-output.golden.jsonl", import.meta.url), "utf8");
  const { stdout } = await runRaw(input, 1, { CLAUDE_PEER_MCP_EXTENSIONS: "code-review" });
  expect(Buffer.from(stdout)).toEqual(Buffer.from(expected));
});

test("a running daemon is the code-review authority and a launch mismatch stays diagnostic", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-code-review-authority-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const daemon = await startDaemon(root, ""); expect(daemon.enabledExtensions).toEqual([]);
  const input = [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } }), JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: meta, name: "code_review_status", arguments: { reviewId: fx(199) } } })].join("\n") + "\n";
  const { rows } = await runRaw(input, 3, { CLAUDE_PEER_MCP_EXTENSIONS: "code-review" }, root); const byId = (id) => rows.find((row) => row.id === id);
  expect(byId(1).result.tools.map((tool) => tool.name)).toEqual(CORE_TOOLS); expect(byId(2).result.structuredContent).toMatchObject({ enabledExtensions: [], requestedExtensions: ["code-review"], extensionMismatch: true }); expect(byId(3).error.code).toBe(-32602);
  await expect(controlCall("code_review_status", { reviewId: fx(199) }, { root })).rejects.toThrow("unknown or unavailable daemon method");
});

test("the control channel records a hash-bound round durably, refuses foreign send options, and never opens a recovery transport", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-code-review-control-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
  await fsp.writeFile(paths.targets, `${JSON.stringify({ reviewer: { sessionId: fx(900), cwd: root, permissionMode: "prompting" } })}\n`, { mode: 0o600 });
  const daemon = await startDaemon(root, "code-review"); expect(daemon.enabledExtensions).toEqual(["code-review"]);
  const args = { alias: "reviewer", reviewId: fx(101), requestMessageId: fx(102), threadId: fx(103), targetKind: "design", artifactHash: "0f".repeat(32), scope: ["docs/design.md"], nonGoals: [], evidence: [] };
  expect(await controlCall("code_review_status", { reviewId: fx(101) }, { root })).toEqual({ found: false, passed: false, state: "not_found", cursor: 0 });
  await expect(controlCall("code_review_request", args, { root })).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  const recorded = await controlCall("code_review_status", { reviewId: fx(101) }, { root }); expect(recorded).toMatchObject({ found: true, passed: false, state: "awaiting_receipt", review: { round: 1, artifactHash: "0f".repeat(32) }, request: { delivery: "unsent", transportMessageId: null } });
  await expect(controlCall("code_review_request", { ...args, scope: ["docs/other.md"] }, { root })).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
  await expect(controlCall("code_review_request", { ...args, recovery: true }, { root })).rejects.toMatchObject({ code: "CODE_REVIEW_INVALID_ARGUMENTS" });
  await expect(controlCall("code_review_request", { ...args, afterReservation: "inject" }, { root })).rejects.toMatchObject({ code: "CODE_REVIEW_INVALID_ARGUMENTS" });
  const events = await controlCall("peer_list_events", {}, { root }); expect(events.events.map((event) => event.type)).toEqual(["code_review_requested"]); expect(events.events.some((event) => event.type === "send_recovery_reserved")).toBeFalse();
  const listed = await controlCall("code_review_list", { afterSeq: 0 }, { root }); expect(listed.rounds).toHaveLength(1); expect(listed.rounds[0].history).toEqual([{ round: 1, requestMessageId: fx(102), artifactHash: "0f".repeat(32), verdict: null, receiptMessageId: null, stale: false }]);
  const bytes = JSON.stringify([recorded, listed]); for (const value of ["targetPid", "targetSocketPath", "targetCwd", root]) expect(bytes).not.toContain(value);
});

test("legacy ledger through a real daemon: a receipt recorded under `verdict` replays as PASS, and peer_list_events never carries a code review verdict — extension off and on, modern and legacy", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-code-review-legacy-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
  await fsp.writeFile(paths.targets, `${JSON.stringify({ reviewer: { sessionId: fx(900), cwd: root, permissionMode: "prompting" } })}\n`, { mode: 0o600 });
  const hash = "0f".repeat(32); const socketPath = "/tmp/fake-legacy-reviewer.sock";
  const snapshot = { targetAlias: "reviewer", targetSessionId: fx(900), targetCwd: root, targetSocketPath: socketPath, targetPid: 77, targetProcStart: "start", targetPermissionMode: "prompting", targetPermissionVerifiedBy: "kern_procargs2" };
  const payload = { review_id: fx(101), target_kind: "implementation", artifact_hash: hash, scope: ["src/example/index.mjs"], non_goals: [], evidence: [] };
  const round = { reviewId: fx(101), round: 1, requestMessageId: fx(102), threadId: fx(103), targetAlias: "reviewer", targetKind: "implementation", artifactHash: hash, payloadHash: sha256(`{"artifact_hash":"${hash}","evidence":[],"non_goals":[],"review_id":"${fx(101)}","scope":["src/example/index.mjs"],"target_kind":"implementation"}`), payload };
  const receipt = { review_id: fx(101), verdict: "pass", review_thread_id: "thread-1", rounds: 2, reviewed_at: "2026-09-03T00:00:00Z", artifact_hash: hash, mandatory_changes: [], unresolved: [] };
  const store = new EventStore(paths); await store.init();
  await store.append("code_review_requested", round);
  await store.append("send_requested", { messageId: fx(102), transportMessageId: fx(102), threadId: fx(103), replyTo: null, kind: "code_review_request", alias: "reviewer", requestHash: sha256(canonicalSend({ alias: "reviewer", messageId: fx(102), threadId: fx(103), replyTo: null, kind: "code_review_request", body: requestBody(round) })), subscriptionId: fx(109), ...snapshot });
  await store.append("code_review_request_send_reserved", { reviewId: fx(101), round: 1, requestMessageId: fx(102), transportMessageId: fx(102), subscriptionId: fx(109), threadId: fx(103), artifactHash: hash, payloadHash: round.payloadHash, ...snapshot });
  await store.append("socket_write_complete", { messageId: fx(102), transportMessageId: fx(102), subscriptionId: fx(109), alias: "reviewer", bytesWritten: 42 });
  // The first writer recorded the receipt verdict under `verdict`; this is that event, byte for byte in shape.
  await store.append("code_review_receipt_accepted", { reviewId: fx(101), round: 1, requestMessageId: fx(102), receiptMessageId: fx(104), threadId: fx(103), verdict: "pass", reviewThreadId: "thread-1", rounds: 2, reviewedAt: "2026-09-03T00:00:00Z", artifactHash: hash, payloadHash: sha256(`{"artifact_hash":"${hash}","mandatory_changes":[],"review_id":"${fx(101)}","review_thread_id":"thread-1","reviewed_at":"2026-09-03T00:00:00Z","rounds":2,"unresolved":[],"verdict":"pass"}`), payload: receipt, transportMessageId: fx(700), peerPid: 77, peerProcStart: "start", sourceAddress: `uds:${socketPath}` });
  await store.close(); const ledgerBefore = await fsp.readFile(paths.events, "utf8"); expect(ledgerBefore).toContain('"verdict":"pass"'); expect(ledgerBefore).not.toContain("receiptVerdict");
  const types = ["code_review_requested", "send_requested", "code_review_request_send_reserved", "socket_write_complete", "code_review_receipt_accepted"];
  const listInput = (era) => era === "modern" ? `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: "peer_list_events", arguments: {} } })}\n` : `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "peer_list_events", arguments: {} } })}\n`;
  for (const extension of ["", "code-review"]) {
    const daemon = await startDaemon(root, extension); expect(daemon.enabledExtensions).toEqual(extension ? ["code-review"] : []);
    const raw = await controlCall("peer_list_events", {}, { root }); expect(raw.events.map((event) => event.type)).toEqual(types);
    expect(raw.events.filter((event) => event.type.startsWith("code_review_") && (Object.hasOwn(event, "verdict") || Object.hasOwn(event, "receiptVerdict")))).toEqual([]);
    for (const era of ["modern", "legacy"]) {
      const { rows } = await runRaw(listInput(era), era === "modern" ? 1 : 2, { CLAUDE_PEER_MCP_EXTENSIONS: extension }, root); const response = rows.at(-1);
      expect(response.result.isError).toBeUndefined(); const events = response.result.structuredContent.events; expect(events.map((event) => event.type)).toEqual(types);
      expect(events.filter((event) => Object.hasOwn(event, "verdict") && event.artifactHash === undefined)).toEqual([]);
      expect(events.filter((event) => event.type.startsWith("code_review_") && Object.hasOwn(event, "verdict"))).toEqual([]);
      expect(events.at(-1)).toEqual({ seq: 5, type: "code_review_receipt_accepted", at: raw.events.at(-1).at, threadId: fx(103) });
    }
    if (extension) {
      expect(await controlCall("code_review_status", { reviewId: fx(101) }, { root })).toMatchObject({ found: true, passed: true, state: "passed", stale: false, receipt: { receiptMessageId: fx(104), verdict: "pass", artifactHash: hash, rounds: 2 }, history: [{ round: 1, artifactHash: hash, verdict: "pass", receiptMessageId: fx(104), stale: false }], request: { delivery: "written", transportMessageId: fx(102) }, lastEvent: { type: "code_review_receipt_accepted", verdict: "pass", artifactHash: hash } });
      const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: "code_review_status", arguments: { reviewId: fx(101) } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: meta, name: "code_review_wait", arguments: { afterSeq: 0, reviewId: fx(101), timeoutMs: 100 } } })}\n`;
      const { rows } = await runRaw(input, 2, { CLAUDE_PEER_MCP_EXTENSIONS: "code-review" }, root); const byId = (id) => rows.find((row) => row.id === id);
      expect(byId(1).result.isError).toBeUndefined(); expect(byId(1).result.structuredContent).toMatchObject({ passed: true, state: "passed", receipt: { verdict: "pass", artifactHash: hash }, lastEvent: { type: "code_review_receipt_accepted", verdict: "pass", artifactHash: hash } });
      expect(byId(2).result.isError).toBeUndefined(); expect(byId(2).result.structuredContent.events.filter((event) => Object.hasOwn(event, "verdict"))).toEqual([expect.objectContaining({ type: "code_review_receipt_accepted", verdict: "pass", artifactHash: hash })]);
      const bytes = JSON.stringify(rows); for (const value of ["targetPid", "targetSocketPath", "peerPid", "sourceAddress", socketPath, root]) expect(bytes).not.toContain(value);
    }
    await stopDaemon(root, daemon.pid);
  }
  expect(await fsp.readFile(paths.events, "utf8")).toBe(ledgerBefore);
});
