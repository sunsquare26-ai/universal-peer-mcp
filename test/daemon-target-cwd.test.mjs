// Two absences that are not the same absence. No `targets.json` at all is a table with nothing
// in it, and the daemon comes up on it: that is a fresh install, and it is how every install
// starts. A `targets.json` that is there and names a directory that is not is a table this
// process could not read, and it is not an empty one.
//
// The daemon read both as the first. `loadTargets` resolves each target's cwd with `realpath`,
// which throws ENOENT naming that directory, and the catch around the load compared only
// `error.code`. So one missing directory deleted every row, including rows whose sessions were
// running — and `Object.keys(targets).length > 0` was then false, so `startReceiver` was never
// called, no receiving socket existed and no session registry entry was written. Inbound was shut
// off at the source. `daemon_status` answered `running: true, targetCount: 0`, which is exactly
// what a clean install answers.
//
// It is not a rare shape either: README says `cp targets.example.json`, and the example's cwd is
// a placeholder. Copy it, start the daemon before editing it, and this is the first thing that
// happens.
//
// `src/server.mjs` already told the two apart — only an ENOENT naming the table itself is an
// absence — and `src/doctor.mjs` says so in a comment. This is the daemon reading it the same way.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { statePaths } from "../src/core/state-paths.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DAEMON = path.join(ROOT, "src", "daemon.mjs");
const roots = []; const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) { try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch {} }
  await Bun.sleep(150);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function workspace(prefix) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(made); await fsp.chmod(made, 0o700);
  const root = await fsp.realpath(made);
  const state = path.join(root, "s"); const home = path.join(root, "h");
  await fsp.mkdir(state, { mode: 0o700 }); await fsp.mkdir(home, { mode: 0o700 });
  return { root, home, state, paths: statePaths(state) };
}

// Started the way `ensureDaemon` starts it, and watched for both endings: the record it publishes
// when it is up, or its own exit. Whichever comes first is the answer.
async function startDaemon(work) {
  const child = spawn("bun", [DAEMON], { cwd: ROOT, env: { ...process.env, HOME: work.home, UNIVERSAL_PEER_MCP_STATE_DIR: work.state }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  let exited = null; child.once("exit", (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await Bun.file(work.paths.daemon).exists()) return { started: true, exited, stderr, child };
    if (exited) return { started: false, exited, stderr, child };
    await Bun.sleep(25);
  }
  throw new Error(`the daemon neither started nor exited: ${stderr}`);
}

async function writeTargets(file, table) { await fsp.writeFile(file, `${JSON.stringify(table)}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600); }

test("no target table at all is an empty table, and the daemon comes up on it", async () => {
  const work = await workspace("pd-none-");
  const outcome = await startDaemon(work);
  expect(outcome.started).toBeTrue();
  const identity = JSON.parse(await fsp.readFile(work.paths.daemon, "utf8"));
  expect(identity.pid).toBeGreaterThan(1);
});

test("a target whose cwd is gone does not empty the table, and does not come up holding none of it", async () => {
  const work = await workspace("pd-cwd-");
  const present = path.join(work.root, "present"); await fsp.mkdir(present, { mode: 0o700 });
  await writeTargets(work.paths.targets, {
    live: { sessionId: "10000000-0000-4000-8000-000000000001", cwd: present, permissionMode: "prompting" },
    gone: { sessionId: "10000000-0000-4000-8000-000000000002", cwd: path.join(work.root, "no-such-directory"), permissionMode: "prompting" }
  });
  const outcome = await startDaemon(work);
  expect(outcome.started).toBeFalse();
  expect(outcome.exited?.code).not.toBe(0);
  expect(outcome.stderr).toContain("no-such-directory");
  expect(await Bun.file(work.paths.daemon).exists()).toBeFalse();
});
