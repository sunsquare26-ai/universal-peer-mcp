#!/usr/bin/env bun
// M5 F5: patch an installed universal-peer-mcp from a checkout, with a way back.
//
//   bun tools/update-install.mjs --package <installed package dir> [--package <another>] --state <state dir> [--dry-run]
//   bun tools/update-install.mjs --rollback --package <installed package dir> [...] --state <state dir>
//   bun tools/update-install.mjs --recover  --package <installed package dir> [...] --state <state dir>
//
// An update used to be done by hand: copy files over the live tree, bump BUILD_ID, kill the daemon,
// hope. This does the same steps in an order that can be undone at every point:
//
//   1. preflight: the packages are distinct, not nested, and installed; the checkout is a clean git
//      tree (src, tools, docs, package.json — the commit is recorded, uncommitted bytes never ship);
//      the checkout's runtime dependencies equal the installed copy's, whose node_modules is carried
//   2. stage each package next to itself as <dir>.next, from the checkout; record a sha256 manifest
//   3. check the staged tree: every src/*.mjs parses; `doctor` from it, against the live state
//      directory (doctor only reads), parses as JSON and reports platform, runtime and state ok
//   4. switch: <dir> -> <dir>.prev-<stamp>, <dir>.next -> <dir>, every step journaled to disk first
//   5. restart: SIGTERM to the pid daemon.json names, only while that pid still has the start time
//      recorded with it (anything else is a refusal), waiting as long as the daemon's own shutdown
//      bound; then the live daemon is asked (daemon_status): a new generation, the new build, and a
//      source digest equal to the installed tree's; the installed tree must still match the manifest
//   6. any failure after the first rename undoes every recorded step in reverse and restarts again
//
// --rollback uses the same journal: every package's newest .prev- is found and checked (against its
// manifest when it has one) before anything moves, and a failure part-way puts back what was moved.
// --recover undoes the journal an updater left behind when it was killed mid-switch.
//
// It touches nothing else: not targets.json, not the ledger, not a client's MCP configuration.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeProcStart, processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { SHUTDOWN_WAIT_MILLIS } from "../src/core/shutdown.mjs";

const args = process.argv.slice(2);
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const dryRun = args.includes("--dry-run"); const rollback = args.includes("--rollback");
const packages = many("--package").map((p) => path.resolve(p)); const state = many("--state")[0] ? path.resolve(many("--state")[0]) : null;
const checkout = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const log = (line) => process.stdout.write(`${line}\n`);
const fail = (message) => { throw Object.assign(new Error(message), { code: "UPDATE_FAILED" }); };
const bun = process.execPath;
const SHIPPED = ["src", "tools", "docs", "examples", "package.json", "README.md", "LICENSE", "NOTICE", "SECURITY.md", "COMPATIBILITY.md", "CONTRIBUTING.md", "TRADEMARKS.md", "targets.example.json"];

function procStart(pid) { try { return normalizeProcStart(processStart(pid)); } catch { return null; } }
function stopDaemon() {
  let text; try { text = fs.readFileSync(path.join(state, "daemon.json"), "utf8"); } catch (error) { if (error.code === "ENOENT") { log("daemon: not running"); return; } throw error; }
  let row = null; try { row = JSON.parse(text); } catch {}
  let recorded = null; try { recorded = normalizeProcStart(row?.procStart); } catch {}
  if (!Number.isInteger(row?.pid) || !recorded) fail("daemon.json is malformed; the running daemon cannot be identified");
  const now = procStart(row.pid);
  if (now === null) { log(`daemon: recorded pid ${row.pid} is gone`); return; }
  if (now !== recorded) fail(`daemon.json names pid ${row.pid}, which is now a different process; not signalled`);
  process.kill(row.pid, "SIGTERM");
  const deadline = Date.now() + SHUTDOWN_WAIT_MILLIS + 4000;
  while (Date.now() < deadline && procStart(row.pid) === recorded) Bun.sleepSync(50);
  if (procStart(row.pid) === recorded) fail(`daemon ${row.pid} did not stop within ${SHUTDOWN_WAIT_MILLIS + 4000} ms of SIGTERM`);
  log(`daemon: pid ${row.pid} stopped`);
}
// Asks the live daemon, through the installed package's own control client (so a daemon it has to
// start is started from the installed tree), which generation, build and source it is running, and
// compares the source digest with the installed tree's. The ledger's last row is not the answer.
function liveStatus(pkg) {
  const script = `const { controlCall } = await import(${JSON.stringify(path.join(pkg, "src", "core", "control.mjs"))}); const { sourceDigest } = await import(${JSON.stringify(path.join(pkg, "src", "core", "build-identity.mjs"))}); const s = await controlCall("daemon_status", {}); process.stdout.write(JSON.stringify({ generationId: s.generationId, pid: s.pid, build: s.daemonBuild, installedDigest: sourceDigest(${JSON.stringify(path.join(pkg, "src"))}) }));`;
  const r = spawnSync(bun, ["-e", script], { env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: state }, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) fail(`daemon_status failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return JSON.parse(r.stdout);
}
function startAndCheck(pkg, expectBuild, previousGeneration) {
  const s = liveStatus(pkg);
  if (previousGeneration && s.generationId === previousGeneration) fail("the daemon answering is the one that was running before the restart");
  if (expectBuild && s.build?.buildId !== expectBuild) fail(`daemon came up as ${s.build?.buildId}, expected ${expectBuild}`);
  if (s.build?.startupSourceDigest !== s.installedDigest) fail("the running daemon's source digest differs from the installed tree");
  log(`daemon: up, pid ${s.pid}, build ${s.build?.buildId}, source ${String(s.installedDigest).slice(0, 12)}`);
}
function currentGeneration() { try { const row = JSON.parse(fs.readFileSync(path.join(state, "daemon.json"), "utf8")); return procStart(row.pid) ? newestGeneration() : null; } catch { return null; } }
function newestGeneration() {
  const rows = fs.readFileSync(path.join(state, "events.jsonl"), "utf8").trimEnd().split("\n");
  for (let i = rows.length - 1; i >= 0; i -= 1) { const r = JSON.parse(rows[i]); if (r.type === "daemon_started") return r.generationId; }
  return null;
}
const buildOf = (pkg) => /BUILD_ID = "([^"]+)"/.exec(fs.readFileSync(path.join(pkg, "src", "core", "build-identity.mjs"), "utf8"))?.[1] ?? null;
const deps = (pkg) => JSON.stringify(JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).dependencies ?? {});
function manifest(root) {
  const rows = [];
  const walk = (dir) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) { if (item.name !== "node_modules") walk(file); } else if (item.isFile() && item.name !== "RELEASE-MANIFEST.sha256" && item.name !== "INSTALLED-FROM" && item.name !== "STATE_DIR") rows.push(`${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}  ${path.relative(root, file)}`); } };
  walk(root); return `${rows.sort().join("\n")}\n`;
}

// The journal: every rename, written to <state>/update-journal.json (fsynced) before it happens, so
// an updater killed between two renames leaves a file `--recover` can undo, and undone in reverse on
// any caught failure. The same file is the lock: it is created exclusively, and while it exists no
// second update, rollback or recovery starts (two updaters would otherwise remove each other's .next).
// The two renames per package are not atomic — the path is briefly absent between them.
const journalFile = () => path.join(state, "update-journal.json");
let journal = null;
function writeJournal() { const tmp = `${journalFile()}.tmp`; const fd = fs.openSync(tmp, "w", 0o600); fs.writeSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, journalFile()); }
function lock(kind) {
  let fd; try { fd = fs.openSync(journalFile(), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); }
  catch (error) { if (error.code === "EEXIST") fail(`another update is running or one was interrupted (${journalFile()}); if no updater is running, run --recover`); throw error; }
  fs.closeSync(fd);
  journal = { kind, pid: process.pid, procStart: procStart(process.pid), startedAt: new Date().toISOString(), moves: [] }; writeJournal();
}
function unlock() { journal = null; fs.rmSync(journalFile(), { force: true }); }
function move(from, to) { journal.moves.push([from, to]); writeJournal(); fs.renameSync(from, to); }
function undo() {
  for (const [from, to] of [...journal.moves].reverse()) {
    try {
      if (fs.existsSync(to)) { if (fs.existsSync(from)) fs.renameSync(from, `${from}.failed-${Date.now()}`); fs.renameSync(to, from); log(`restored ${from}`); }
    } catch (error) { process.stderr.write(`update-install: could not restore ${from}: ${error.message}\n`); }
  }
  journal.moves = []; writeJournal();
}

function preflight() {
  if (!packages.length || !state) fail("usage: --package <installed package dir> [--package ...] --state <state dir> [--dry-run | --rollback]");
  if (new Set(packages).size !== packages.length) fail("the same package is named twice");
  for (const a of packages) for (const b of packages) if (a !== b && (a + path.sep).startsWith(b + path.sep)) fail(`${a} is inside ${b}`);
  if (!fs.existsSync(path.join(state, "events.jsonl"))) fail(`${state} is not a state directory (no events.jsonl)`);
  if (!recover && fs.existsSync(journalFile())) fail(`another update is running or one was interrupted (${journalFile()}); if no updater is running, run --recover`);
  const realState = fs.realpathSync(state);
  const reals = packages.map((p) => { try { return fs.realpathSync(p); } catch { return p; } });
  if (new Set(reals).size !== reals.length) fail("two --package paths name the same directory");
  for (const r of reals) if ((realState + path.sep).startsWith(path.dirname(r) + path.sep)) fail(`the state directory is inside ${path.dirname(r)}, which the switch renames around`);
}
function requireInstalled() { for (const p of packages) if (!fs.existsSync(path.join(p, "src", "cli.mjs"))) fail(`${p} is not an installed package (no src/cli.mjs)`); }

const recover = args.includes("--recover");
// Restart the daemon and require the new generation to be the given build from the installed tree.
function restart(expectBuild) { const before = currentGeneration(); stopDaemon(); startAndCheck(packages[0], expectBuild, before); }
function abort(error, what) {
  process.stderr.write(`update-install: ${error.message}; undoing the ${what}\n`);
  undo();
  try { restart(null); } catch (e) { process.stderr.write(`update-install: restart after undo failed: ${e.message}\n`); }
  unlock(); process.exit(1);
}

try {
  preflight();
  if (recover) {
    // An updater that died mid-switch left its journal: undo its renames, then restart.
    let left; try { left = JSON.parse(fs.readFileSync(journalFile(), "utf8")); } catch { fail(`no interrupted update to recover (${journalFile()})`); }
    if (left.pid && procStart(left.pid) !== null && procStart(left.pid) === left.procStart) fail(`updater pid ${left.pid} is still running`);
    journal = left; undo(); requireInstalled(); restart(null); unlock(); log("recovered"); process.exit(0);
  }
  requireInstalled();
  if (rollback) {
    const plan = packages.map((pkg) => {
      const prev = fs.readdirSync(path.dirname(pkg)).filter((n) => n.startsWith(`${path.basename(pkg)}.prev-`)).sort().at(-1);
      if (!prev) fail(`no previous version next to ${pkg}`);
      const prevDir = path.join(path.dirname(pkg), prev);
      if (!fs.existsSync(path.join(prevDir, "src", "cli.mjs"))) fail(`${prevDir} is not a package`);
      const sums = path.join(prevDir, "RELEASE-MANIFEST.sha256");
      if (fs.existsSync(sums) && fs.readFileSync(sums, "utf8") !== manifest(prevDir)) fail(`${prevDir} no longer matches its manifest`);
      return { pkg, prevDir };
    });
    lock("rollback");
    const stamp = Date.now();
    try {
      for (const { pkg, prevDir } of plan) { move(pkg, `${pkg}.rolledback-${stamp}`); move(prevDir, pkg); log(`rolled back ${pkg} <- ${path.basename(prevDir)}`); }
      restart(buildOf(packages[0]));
    } catch (error) { abort(error, "rollback"); }
    unlock(); process.exit(0);
  }

  // 1. clean checkout, same dependencies. Every shipped path is checked, present or not, so an
  // uncommitted deletion is caught too.
  const dirty = execFileSync("git", ["-C", checkout, "status", "--porcelain", "--", ...SHIPPED], { encoding: "utf8" }).trim();
  if (dirty) fail(`checkout has uncommitted changes:\n${dirty}`);
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const build = buildOf(checkout);
  log(`source: ${checkout} @ ${commit}, build ${build}`);
  for (const p of packages) { if (buildOf(p) === build) fail(`${p} already carries build ${build}; bump BUILD_ID first`); if (deps(p) !== deps(checkout)) fail(`${p} has different dependencies from the checkout; its node_modules cannot be carried over`); }
  lock("update");

  // 2-3. stage and check
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const manifests = new Map();
  try {
    for (const pkg of packages) {
      const next = `${pkg}.next`;
      fs.rmSync(next, { recursive: true, force: true });
      fs.mkdirSync(next, { mode: 0o700 });
      for (const item of SHIPPED) { const from = path.join(checkout, item); if (fs.existsSync(from)) fs.cpSync(from, path.join(next, item), { recursive: true }); }
      const modules = path.join(pkg, "node_modules"); if (fs.existsSync(modules)) fs.cpSync(modules, path.join(next, "node_modules"), { recursive: true, verbatimSymlinks: true });
      for (const file of fs.readdirSync(path.join(next, "src"), { recursive: true }).filter((f) => f.endsWith(".mjs"))) {
        const r = spawnSync("node", ["--check", path.join(next, "src", file)], { encoding: "utf8" });
        if (r.status !== 0) fail(`staged ${file} does not parse: ${r.stderr.slice(0, 300)}`);
      }
      const doctor = spawnSync(bun, [path.join(next, "src", "cli.mjs"), "doctor"], { env: { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: state }, encoding: "utf8", timeout: 30_000 });
      let report = null; try { report = JSON.parse(doctor.stdout); } catch {}
      // The overall `ok` also folds in optional features that may be unconfigured; these are the
      // parts an update can break.
      if (doctor.status !== 0 || !report || report.system?.platformSupported !== true || report.system?.architectureSupported !== true || report.runtimes?.bunSatisfied !== true || report.state?.ok !== true) fail(`doctor from the staged tree: ${(doctor.stderr || doctor.stdout).slice(0, 400)}`);
      const sums = manifest(next);
      fs.writeFileSync(path.join(next, "RELEASE-MANIFEST.sha256"), sums, { mode: 0o600 });
      fs.writeFileSync(path.join(next, "INSTALLED-FROM"), `${commit} ${build} ${new Date().toISOString()}\n`, { mode: 0o600 });
      // The install remembers which state directory it serves (src/core/state-paths.mjs), so a bare
      // `universal-peer-mcp inbox` in a session shell reaches this daemon and no other.
      fs.writeFileSync(path.join(next, "STATE_DIR"), `${fs.realpathSync(state)}\n`, { mode: 0o600 });
      manifests.set(pkg, sums);
      log(`staged ${next}`);
    }
  } catch (error) { for (const pkg of packages) fs.rmSync(`${pkg}.next`, { recursive: true, force: true }); unlock(); throw error; }
  if (dryRun) { for (const pkg of packages) fs.rmSync(`${pkg}.next`, { recursive: true, force: true }); unlock(); log("dry run: staged trees checked and removed; nothing switched"); process.exit(0); }

  // 4-6. switch, restart, verify — or undo every step
  try {
    for (const pkg of packages) { move(pkg, `${pkg}.prev-${stamp}`); move(`${pkg}.next`, pkg); log(`switched ${pkg} (previous kept as .prev-${stamp})`); }
    restart(build);
    for (const pkg of packages) if (manifest(pkg) !== manifests.get(pkg)) fail(`${pkg} no longer matches its staged manifest`);
  } catch (error) { abort(error, "update"); }
  unlock();
  log(`done: ${build} @ ${commit}. Undo with --rollback.`);
} catch (error) {
  process.stderr.write(`update-install: ${error.message}\n`);
  process.exit(1);
}
