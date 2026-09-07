import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { statePaths } from "../src/core/state-paths.mjs";

// Two readings of the target table can differ in a way counting cannot see. Point one alias at
// another session and there are as many rows as there were, the alias is still allowlisted, and
// the daemon — which read the file once, when it started — sends to the row it has. Before this
// was closed, `peer_status` on that alias answered with the *old* session's id and
// `daemon_status` said `targetCountMismatch: false` while it did so. That is not a stale number,
// it is a message addressed to a session the caller did not name.
//
// So this file uses two live stand-in peers rather than fixtures: what is asserted is which
// session the answer names, and there is no way to assert that without two of them. The peer is
// test/e2e-claude-host.mjs — not Claude Code, but everything the resolver checks about it (uid,
// pid, process start time, permission argv, socket mode, auth key) is checked against a real
// process for real. HOME is redirected into a temporary tree, so the developer's own session
// registry is neither read nor written.
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const HOST = path.join(ROOT, "test", "e2e-claude-host.mjs");
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const children = new Set(); const roots = [];

afterAll(async () => {
  for (const child of children) { try { child.kill("SIGTERM"); } catch {} }
  await Bun.sleep(200);
  for (const root of roots) {
    try { process.kill(JSON.parse(await fsp.readFile(statePaths(path.join(root, "state")).daemon, "utf8")).pid, "SIGTERM"); } catch {}
  }
  await Bun.sleep(400);
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
});

async function until(check, label, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(25); }
  throw new Error(typeof label === "function" ? label() : label);
}

async function startHost(dirs, { sessionId, cwd, ready, name }) {
  const child = spawn(process.execPath, [
    HOST, "--permission-mode", "default", "--sessions-dir", dirs.sessions, "--socket-dir", dirs.sockets,
    "--cwd", cwd, "--session-id", sessionId, "--display-name", name, "--ready-file", ready, "--log-file", path.join(dirs.logs, `${name}.jsonl`)
  ], { cwd, env: { ...process.env, HOME: dirs.home }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  await until(async () => Bun.file(ready).exists(), () => `the stand-in peer did not start: ${stderr}`);
  return JSON.parse(await fsp.readFile(ready, "utf8"));
}

async function writeTargets(file, table) { await fsp.writeFile(file, `${JSON.stringify(table)}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600); }

// One server on its own state directory, spoken to the way a host speaks to it: one framed
// request written to stdin, one framed response read back off stdout.
async function openServer(dirs) {
  const child = spawn("bun", ["src/server.mjs"], { cwd: ROOT, env: { ...process.env, HOME: dirs.home, UNIVERSAL_PEER_MCP_STATE_DIR: dirs.state } });
  children.add(child);
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const complete = () => { const parts = stdout.split("\n"); parts.pop(); return parts.filter(Boolean); };
  let taken = 0; let id = 0;
  return async function request(method, params = {}) {
    id += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: META, ...params } })}\n`);
    await until(async () => complete().length > taken, () => `no response to ${method}: ${stderr}`);
    const rows = complete(); const row = rows[taken]; taken = rows.length;
    return JSON.parse(row);
  };
}

test("an alias repointed at another session is refused, not delivered to the row the daemon started with", async () => {
  const work = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "peer-table-identity-"))); roots.push(work); await fsp.chmod(work, 0o700);
  const dirs = Object.fromEntries(["home", "state", "sockets", "logs", "alpha", "beta"].map((name) => [name, path.join(work, name)]));
  for (const dir of Object.values(dirs)) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  dirs.sessions = path.join(dirs.home, ".claude", "sessions");
  await fsp.mkdir(dirs.sessions, { recursive: true, mode: 0o700 }); await fsp.chmod(dirs.sessions, 0o700);

  const first = await startHost(dirs, { sessionId: crypto.randomUUID(), cwd: dirs.alpha, ready: path.join(work, "alpha.json"), name: "Alpha" });
  const second = await startHost(dirs, { sessionId: crypto.randomUUID(), cwd: dirs.beta, ready: path.join(work, "beta.json"), name: "Beta" });
  const rowFor = (peer, cwd) => ({ peer: { sessionId: peer.sessionId, cwd, permissionMode: "prompting" } });
  const targetsFile = statePaths(dirs.state).targets;
  const names = (value) => value === null ? "refused before dispatch" : value === first.sessionId ? "session A" : value === second.sessionId ? "session B" : `unknown (${value})`;

  await writeTargets(targetsFile, rowFor(first, dirs.alpha));
  const request = await openServer(dirs);
  await request("tools/list");

  // the table on disk and the table the daemon read are the same table, so the alias works
  const before = await request("tools/call", { name: "peer_status", arguments: { alias: "peer" } });
  const beforeStatus = (await request("tools/call", { name: "daemon_status", arguments: {} })).result.structuredContent;
  expect({ session: names(before.result.structuredContent?.sessionId ?? null), mismatch: beforeStatus.targetTableMismatch, count: beforeStatus.targetCountMismatch })
    .toEqual({ session: "session A", mismatch: false, count: false });

  // the operator repoints the same alias at the other session: one alias before, one alias after
  await writeTargets(targetsFile, rowFor(second, dirs.beta));
  await request("tools/list");
  const during = await request("tools/call", { name: "peer_status", arguments: { alias: "peer" } });
  const duringStatus = (await request("tools/call", { name: "daemon_status", arguments: {} })).result.structuredContent;
  expect({
    session: names(during.result.structuredContent?.sessionId ?? null),
    refused: during.result.isError === true,
    reason: during.result.structuredContent,
    counts: duringStatus.targetCount === duringStatus.advertisedTargetCount,
    countMismatch: duringStatus.targetCountMismatch,
    tableMismatch: duringStatus.targetTableMismatch
  }).toEqual({
    session: "refused before dispatch",
    refused: true,
    reason: { reason: "target_unavailable" },
    counts: true,
    // the count is the same on both sides and says nothing; the content comparison is the gate
    countMismatch: false,
    tableMismatch: true
  });

  // and nothing was reserved or written on the way to that refusal
  expect((await request("tools/call", { name: "peer_list_events", arguments: {} })).result.structuredContent.events).toEqual([]);

  // the refusal is not sticky: put the file back and the alias answers again, from session A —
  // the row the daemon is actually holding. Restarting the daemon is the other way out of the
  // refusal, and the one that makes session B usable.
  await writeTargets(targetsFile, rowFor(first, dirs.alpha));
  await request("tools/list");
  const after = await request("tools/call", { name: "peer_status", arguments: { alias: "peer" } });
  const afterStatus = (await request("tools/call", { name: "daemon_status", arguments: {} })).result.structuredContent;
  expect({ session: names(after.result.structuredContent?.sessionId ?? null), mismatch: afterStatus.targetTableMismatch })
    .toEqual({ session: "session A", mismatch: false });
}, 90_000);
