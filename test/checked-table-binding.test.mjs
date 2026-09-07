import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { controlCall } from "../src/core/control.mjs";
import { sha256 } from "../src/core/dedupe.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { loadTargets, targetTableDigest } from "../src/core/target-config.mjs";
import { normalizeProcStart, PROC_START_RENDERING } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

// Reading the table and executing against it were two separate control requests, and nothing in
// the second one said what the first one had read. Between them the daemon can be replaced and
// the file can be rewritten — both happen on this machine, one when an install is upgraded and
// one whenever an operator edits targets.json — and the command was then carried out against
// whatever was there when it landed. "I read the table and then I sent" is not the property
// anything needs; "I sent against the table I read" is, and it is a property only the executing
// side can enforce.
//
// Both tests below drive the real daemon over the real control socket, with a real stand-in peer
// behind the alias, and swap the table and the daemon in the window between the check and the
// command. The sequence they drive is the one src/server.mjs drives for a call that names an
// alias: read the table for this call, ask the daemon what table it is holding, compare, send.
// The server is a stdio program with no importable entry point, so the sequence is written out
// here rather than called; every function in it is the shipped one.
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const HOST = path.join(ROOT, "test", "e2e-claude-host.mjs");
const children = new Set(); const roots = [];

afterAll(async () => {
  for (const child of children) { try { child.kill("SIGTERM"); } catch {} }
  await Bun.sleep(200);
  for (const root of roots) {
    try { process.kill(JSON.parse(await fsp.readFile(statePaths(path.join(root, "st")).daemon, "utf8")).pid, "SIGTERM"); } catch {}
  }
  await Bun.sleep(400);
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
});

async function until(check, label, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(25); }
  throw new Error(typeof label === "function" ? label() : label);
}

async function workspace(prefix) {
  const work = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix))); roots.push(work); await fsp.chmod(work, 0o700);
  // Short directory names on purpose: a unix socket path is capped at 104 bytes on macOS and the
  // temporary root already spends more than half of that.
  const dirs = { home: path.join(work, "h"), state: path.join(work, "st"), sockets: path.join(work, "s"), logs: path.join(work, "l"), alpha: path.join(work, "a"), beta: path.join(work, "b") };
  for (const dir of Object.values(dirs)) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  dirs.sessions = path.join(dirs.home, ".claude", "sessions");
  await fsp.mkdir(dirs.sessions, { recursive: true, mode: 0o700 }); await fsp.chmod(dirs.sessions, 0o700);
  return { work, dirs, paths: statePaths(dirs.state) };
}

async function startHost(dirs, { sessionId, cwd, ready, name }) {
  const child = spawn(process.execPath, [
    HOST, "--permission-mode", "default", "--sessions-dir", dirs.sessions, "--socket-dir", dirs.sockets,
    "--cwd", cwd, "--session-id", sessionId, "--display-name", name, "--ready-file", ready, "--log-file", path.join(dirs.logs, `${name}.jsonl`)
  ], { cwd, env: { ...process.env, HOME: dirs.home }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  await until(async () => Bun.file(ready).exists(), () => `the stand-in peer did not start: ${stderr}`);
  return { ...JSON.parse(await fsp.readFile(ready, "utf8")), log: path.join(dirs.logs, `${name}.jsonl`) };
}

// The daemon is started here rather than left to ensureDaemon, because it has to inherit the
// redirected HOME: the resolver reads ~/.claude/sessions, and the sessions these tests resolve
// are the stand-ins in the temporary tree, not the developer's own.
async function startDaemon(dirs, extensions = "") {
  const child = spawn("bun", ["src/daemon.mjs"], { cwd: ROOT, env: { ...process.env, HOME: dirs.home, UNIVERSAL_PEER_MCP_STATE_DIR: dirs.state, CLAUDE_PEER_MCP_EXTENSIONS: extensions }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const file = statePaths(dirs.state).daemon;
  await until(async () => Bun.file(file).exists(), () => `the daemon did not publish its record: ${stderr}`);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function stopDaemon(dirs, pid) {
  try { process.kill(pid, "SIGTERM"); } catch {}
  const file = statePaths(dirs.state).daemon;
  await until(async () => !(await Bun.file(file).exists()), "the daemon did not clear its record");
}

async function writeTargets(file, table) { await fsp.writeFile(file, `${JSON.stringify(table)}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600); }
async function settle(run) {
  try { return { refused: false, value: await run(), code: null }; }
  catch (error) { return { refused: true, value: null, code: error?.code ?? null }; }
}
async function hostFrames(log) {
  try { return (await fsp.readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.event === "frame").length; }
  catch { return 0; }
}

test("a call naming an alias is executed against the table and the daemon it was checked against, or not at all", async () => {
  const { work, dirs, paths } = await workspace("cpm-race-");
  const first = await startHost(dirs, { sessionId: crypto.randomUUID(), cwd: dirs.alpha, ready: path.join(work, "alpha.json"), name: "Alpha" });
  const second = await startHost(dirs, { sessionId: crypto.randomUUID(), cwd: dirs.beta, ready: path.join(work, "beta.json"), name: "Beta" });
  const rowFor = (peer, cwd) => ({ peer: { sessionId: peer.sessionId, cwd, permissionMode: "prompting" } });
  const names = (value) => value == null ? null : value === first.sessionId ? "session A" : value === second.sessionId ? "session B" : `unknown (${value})`;

  await writeTargets(paths.targets, rowFor(first, dirs.alpha));
  const alpha = await startDaemon(dirs);

  // the check: the table read for this call, and the table the daemon says it is holding.
  const digest = targetTableDigest(await loadTargets(paths.targets));
  const checked = await controlCall("daemon_status", {}, { root: dirs.state });
  expect(checked.targetsDigest).toBe(digest);
  const binding = { daemonPid: checked.pid, daemonProcStart: checked.procStart, targetsDigest: digest };

  // the window: the operator repoints the alias at the other session and the daemon is replaced.
  // Neither reading the check made is true any more, and the check has already passed.
  await stopDaemon(dirs, alpha.pid);
  await writeTargets(paths.targets, rowFor(second, dirs.beta));
  const beta = await startDaemon(dirs);
  expect(beta.pid).not.toBe(alpha.pid);

  const raced = await settle(() => controlCall("peer_status", { alias: "peer" }, { root: dirs.state, expect: binding }));
  expect({ answered: names(raced.value?.sessionId), refused: raced.refused, code: raced.code })
    .toEqual({ answered: null, refused: true, code: "TARGET_UNAVAILABLE" });

  // and the refusal is the executing side's, not this caller's bookkeeping: a command that names
  // the daemon it actually reached and carries the digest of a table that daemon is not holding
  // is refused before it is dispatched.
  const staleTable = await settle(() => controlCall("peer_status", { alias: "peer" }, { root: dirs.state, expect: { daemonPid: beta.pid, daemonProcStart: beta.procStart, targetsDigest: digest } }));
  expect({ answered: names(staleTable.value?.sessionId), refused: staleTable.refused, code: staleTable.code })
    .toEqual({ answered: null, refused: true, code: "TARGET_UNAVAILABLE" });

  // a command that says nothing about what it was checked against is refused for the same
  // reason: the absence of a binding is not a weaker binding.
  const unbound = await settle(() => controlCall("peer_status", { alias: "peer" }, { root: dirs.state }));
  expect({ answered: names(unbound.value?.sessionId), refused: unbound.refused, code: unbound.code })
    .toEqual({ answered: null, refused: true, code: "TARGET_UNAVAILABLE" });

  // nothing above closed the door on a true binding: the current table, checked against the
  // current daemon, answers with the session that table names.
  const current = targetTableDigest(await loadTargets(paths.targets));
  const honest = await controlCall("peer_status", { alias: "peer" }, { root: dirs.state, expect: { daemonPid: beta.pid, daemonProcStart: beta.procStart, targetsDigest: current } });
  expect(names(honest.sessionId)).toBe("session B");
}, 120_000);

test("a milestone ACK recovery names no alias and is refused when the table no longer carries the target it was bound to", async () => {
  const { work, dirs, paths } = await workspace("cpm-rec-");
  const peer = await startHost(dirs, { sessionId: crypto.randomUUID(), cwd: dirs.alpha, ready: path.join(work, "peer.json"), name: "Solo" });

  // one accepted completion on the ledger, bound to the identity the peer had when it arrived.
  // This is the binding a recovery works from: it names no alias in its arguments, so nothing on
  // the way in has an alias to check against the allowlist.
  const ids = { completion: crypto.randomUUID(), attempt: crypto.randomUUID(), thread: crypto.randomUUID(), instruction: crypto.randomUUID() };
  const payload = { attempt_id: ids.attempt, blockers: [], files: ["src/example.mjs"], instruction_id: ids.instruction, last_signal_at: "2026-09-07T00:00:00Z", milestone_id: "M-1", tests: [] };
  const payloadHash = sha256(JSON.stringify(payload));
  const completion = {
    seq: 1, type: "milestone_completion_accepted", at: "2026-09-07T00:00:00.000Z",
    completionMessageId: ids.completion, attemptId: ids.attempt, milestoneId: "M-1", instructionId: ids.instruction,
    threadId: ids.thread, payloadHash, payload,
    targetAlias: "peer", targetSessionId: peer.sessionId, targetCwd: dirs.alpha, targetSocketPath: peer.socketPath,
    targetPid: peer.pid, targetProcStart: normalizeProcStart(peer.procStart), targetProcStartRendering: PROC_START_RENDERING,
    targetPermissionMode: "prompting", targetPermissionVerifiedBy: "kern_procargs2"
  };
  await fsp.writeFile(paths.events, `${JSON.stringify(completion)}\n`, { mode: 0o600 }); await fsp.chmod(paths.events, 0o600);
  await writeTargets(paths.targets, { peer: { sessionId: peer.sessionId, cwd: dirs.alpha, permissionMode: "prompting" } });
  const daemon = await startDaemon(dirs, "milestone");

  // the operator takes the target off the table. The daemon keeps the row it read when it
  // started — re-reading it is a separate question — so the recovery still has somewhere to go
  // unless the table is what decides.
  await writeTargets(paths.targets, {});
  const digest = targetTableDigest(await loadTargets(paths.targets));
  const checked = await controlCall("daemon_status", {}, { root: dirs.state });
  expect(checked.targetsDigest).not.toBe(digest);
  const before = (await controlCall("peer_list_events", {}, { root: dirs.state })).events.length;

  const recovered = await settle(() => controlCall("milestone_recover_ack", { completionMessageId: ids.completion, payloadHash }, { root: dirs.state, expect: { daemonPid: checked.pid, daemonProcStart: checked.procStart, targetsDigest: digest } }));
  await Bun.sleep(500);
  const after = (await controlCall("peer_list_events", {}, { root: dirs.state })).events;
  expect({ refused: recovered.refused, code: recovered.code, appended: after.length - before, framesWritten: await hostFrames(peer.log) })
    .toEqual({ refused: true, code: "TARGET_UNAVAILABLE", appended: 0, framesWritten: 0 });

  // the ledger is untouched, so the recovery is still there to be made once the operator puts
  // the target back — the refusal spends nothing.
  expect(after.map((event) => event.type)).toEqual(["milestone_completion_accepted"]);
  expect(daemon.enabledExtensions).toEqual(["milestone"]);
}, 120_000);
