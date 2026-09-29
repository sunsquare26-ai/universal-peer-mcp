// A Claude Code session that is resumed is issued a new session id. The operator's table still
// holds the old one, every send to that alias fails as `no_live_session_for_session_id`, and the
// repair was a person editing `targets.json` and restarting the daemon. Measured 2026-09-11 on this
// machine: alias `friday-main` pointed at 3f4af4c9-…, the session it named was up and advertising
// 62505f70-…, peer_ack for the day was 0 against 57 the day before.
//
// These reproduce that with real processes and the kernel's own copy of their arguments — nothing
// here stubs the argv reader or the process-start reader. Each test spawns processes it kills
// itself, by the pid the spawn returned, and touches no other pid.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { createSessionRebinder, proveResumeSuccession } from "../src/core/session-rebind.mjs";
import { readRebindState } from "../src/core/rebind-sidecar.mjs";
import { loadTargets, targetTableDigest } from "../src/core/target-config.mjs";
import { resolveSuccessor, resolveTarget } from "../src/adapters/claude-native-v1/registry.mjs";
import { processParent, processStart, readProcessArgv } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

// Fixture ids, deliberately not any id a session on this machine is running under: the ancestor
// walk climbs into this test runner's own ancestors, and a real id here could be proven by a real
// receipt that has nothing to do with the fixture.
const OLD = "aaaaaaaa-0000-4000-8000-00000000feed";
const OLD_B = "dddddddd-0000-4000-8000-00000000d00d";
const NEW_A = "bbbbbbbb-0000-4000-8000-00000000beef";
const NEW_B = "cccccccc-0000-4000-8000-00000000cafe";

const roots = []; const spawned = []; const closers = [];
afterEach(async () => {
  for (const child of spawned.splice(0)) { try { child.kill(); await child.exited; } catch {} }
  for (const close of closers.splice(0)) { try { await close(); } catch {} }
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

// A process this test owns, holding the arguments the test wants the kernel to have recorded. bun
// is the program because it is the one on this machine whose argv[0] is its own exec path and which
// keeps arguments it does not recognise — the resolver refuses a process whose argv[0] and exec path
// differ, and refusing the fixture would prove nothing about the code.
async function hold(args) {
  const child = Bun.spawn({ cmd: [process.execPath, "-e", "setTimeout(() => {}, 600000)", ...args], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  spawned.push(child);
  // Waiting for `ps` to answer is not enough and this was measured flaking on it: between the fork
  // and the exec the pid exists and the kernel is still holding the *parent's* arguments, so a
  // proof read in that window reads this test runner's command line, finds no receipt in it and
  // walks off up the tree. The wait is therefore for the arguments the fixture asked for to be the
  // arguments the kernel has.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const argv = readProcessArgv(child.pid);
      const tail = argv.slice(argv.length - args.length);
      if (args.length > 0 && args.every((value, index) => tail[index] === value)) return { pid: child.pid, procStart: processStart(child.pid) };
    } catch {}
    await Bun.sleep(10);
  }
  throw new Error("fixture process never showed the arguments it was spawned with");
}

// Converged, and still there a moment later. A fixture that exits on its own is the other way this
// flaked: the arguments were read, the process was gone by the time the proof ran, and a proof
// against a dead pid is `null` — which is what half these assertions expect, so a self-terminating
// fixture could have passed a negative control for entirely the wrong reason.
async function holdAlive(args) {
  const held = await hold(args);
  await Bun.sleep(50);
  expect(() => readProcessArgv(held.pid), `fixture process for ${args.join(" ")} did not stay alive`).not.toThrow();
  return held;
}

async function bench() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-rebind-")));
  roots.push(root); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); await fsp.mkdir(sessionsDir, { mode: 0o700 });
  await fsp.chmod(sessionsDir, 0o700);
  return { root, sessionsDir, paths: statePaths(root) };
}

// One session registry row as Claude Code publishes it, with the private socket and the private key
// file the resolver demands beside it.
async function publishSession({ root, sessionsDir }, { pid, procStart }, sessionId, tag, cwd = root) {
  const socketPath = path.join(root, `${tag}.sock`);
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  await fsp.chmod(socketPath, 0o600);
  const row = {
    pid, sessionId, cwd, procStart, version: "2.1.260", peerProtocol: 1,
    peerFeatures: ["notify_idle", "reply_across_default_dirs"], messagingSocketPath: socketPath,
    name: "fixture-session", status: "idle"
  };
  const rowFile = path.join(sessionsDir, `${pid}.json`);
  await fsp.writeFile(rowFile, JSON.stringify(row)); await fsp.chmod(rowFile, 0o644);
  const keyFile = path.join(sessionsDir, `${pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await fsp.writeFile(keyFile, JSON.stringify({ procStart, peerToken: "f".repeat(32) }));
  await fsp.chmod(keyFile, 0o600);
  return { row, rowFile };
}

async function writeTable(paths, table) {
  await fsp.mkdir(path.dirname(paths.targets), { recursive: true, mode: 0o700 });
  await fsp.writeFile(paths.targets, `${JSON.stringify(table, null, 2)}\n`); await fsp.chmod(paths.targets, 0o600);
}
async function writeSidecar(paths, state) {
  await fsp.writeFile(paths.rebindState, `${JSON.stringify(state, null, 2)}\n`); await fsp.chmod(paths.rebindState, 0o600);
}

async function wire(stand, { alias = "friday-main", writeSessionId, resolver = resolveTarget } = {}) {
  const store = new EventStore(stand.paths); await store.init();
  const targets = await loadTargets(stand.paths.targets);
  const rebind = createSessionRebinder({
    targetsFile: stand.paths.targets, stateFile: stand.paths.rebindState, store, resolveSuccessor,
    ...(writeSessionId ? { writeSessionId } : {})
  });
  const core = new PeerCore({
    targets, store, address: "uds:/tmp/fixture-sender.sock", resolver,
    resolverOptions: { sessionsDir: stand.sessionsDir }, sender: async () => ({ bytesWritten: 1 }), rebind
  });
  return { store, core, targets, alias };
}

const table = (root, sessionId = OLD, extra = {}) => ({ "friday-main": { sessionId, cwd: root, permissionMode: "bypass" }, ...extra });
const readTable = async (paths) => JSON.parse(await fsp.readFile(paths.targets, "utf8"));
const argvReaders = { argvReader: readProcessArgv, parentReader: processParent };

test("R1 a resumed session is rebound from its own --resume receipt, with no hand edit", async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root));
  const { store, core, alias } = await wire(stand);

  // The id in the table resolves to nothing: that is the failure this whole path answers.
  await expect(resolveTarget({ sessionId: OLD, cwd: stand.root, permissionMode: "bypass" }, { sessionsDir: stand.sessionsDir }))
    .rejects.toThrow("resolved to 0 live candidates");

  const status = await core.status(alias);
  expect(status.connected).toBe(true);
  expect(status.sessionId).toBe(NEW_A);
  expect(status.pid).toBe(live.pid);

  const after = await readTable(stand.paths);
  expect(after["friday-main"].sessionId).toBe(NEW_A);
  expect(after["friday-main"].cwd).toBe(stand.root);
  expect(after["friday-main"].permissionMode).toBe("bypass");

  // The history is beside the table, not in it.
  expect((await readRebindState(stand.paths.rebindState)).history["friday-main"]).toEqual([OLD]);

  const rebound = store.events.filter((event) => event.type === "target_rebound");
  expect(rebound).toHaveLength(1);
  expect(rebound[0]).toMatchObject({
    alias: "friday-main", expectedSessionId: OLD, observedSessionId: NEW_A,
    candidateCount: 1, proof: "resume_argv", cwdCheck: "enforced", tableChanged: true,
    historyRecorded: true, previousSessionIds: [OLD]
  });
  expect(store.events.some((event) => event.type === "target_resolve_failed")).toBe(false);
});

// A table an older build cannot read is a table a rollback does not repair. `loadTargets` refuses a
// field it does not know and `src/server.mjs` reads a refused table as no table, so one extra field
// written here unpublishes every alias on the build before this one — and it stays unpublished
// after the code is put back, because the field is on disk. So the succession writes one field that
// every build already reads, and puts everything else in a file an older build never opens.
test("FIX1 a rewritten table carries nothing a build without succession would refuse", async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, { "friday-main": { sessionId: OLD, cwd: stand.root, expectedDisplayName: "Friday", permissionMode: "bypass" } });
  const { core } = await wire(stand);
  await core.status("friday-main");

  const after = await readTable(stand.paths);
  expect(Object.keys(after)).toEqual(["friday-main"]);
  expect(Object.keys(after["friday-main"]).sort()).toEqual(["cwd", "expectedDisplayName", "permissionMode", "sessionId"]);
  // The loader in this build is the loader in the build before it, unchanged, so this is the check
  // the older one would make.
  const reloaded = await loadTargets(stand.paths.targets);
  expect(reloaded["friday-main"].sessionId).toBe(NEW_A);
  expect(reloaded["friday-main"].expectedDisplayName).toBe("Friday");

  // And that loader really would have refused what this deliberately does not write.
  await writeTable(stand.paths, { "friday-main": { sessionId: NEW_A, cwd: stand.root, permissionMode: "bypass", previousSessionIds: [OLD] } });
  await expect(loadTargets(stand.paths.targets)).rejects.toThrow("unknown target field for friday-main");
  await writeTable(stand.paths, { rebind: "proof", "friday-main": { sessionId: NEW_A, cwd: stand.root, permissionMode: "bypass" } });
  await expect(loadTargets(stand.paths.targets)).rejects.toThrow();
});

// The digest is how a caller and the daemon agree they are holding one table. If this build computed
// it differently from the build before it, every call would be refused while the two were mixed —
// which is the whole window an install runs in. These three values were computed with the previous
// build's `targetTableDigest` and are pinned here literally.
test("FIX1 the target table digest is byte-for-byte what the previous build computed", () => {
  expect(targetTableDigest({})).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  expect(targetTableDigest({ "friday-main": { sessionId: "aaaaaaaa-1111-4000-8000-000000000001", cwd: "/private/tmp/fixture", expectedDisplayName: null, permissionMode: "bypass" } }))
    .toBe("a6be6cf1cb08a7e12d81ae7e94bedfd85e895e87b69824caab3794ecc8c5edf5");
  expect(targetTableDigest({
    erp: { sessionId: "cccccccc-3333-4000-8000-000000000003", cwd: "/private/tmp/other", expectedDisplayName: "ERP", permissionMode: "prompting" },
    "friday-main": { sessionId: "bbbbbbbb-2222-4000-8000-000000000002", cwd: "/private/tmp/fixture", expectedDisplayName: null, permissionMode: "bypass" }
  })).toBe("73a4f4099c89f50d20b95ac6d126a2adfd89fd824bda836ff54a10d56ba42f7e");
});

// The receipt is read at depth 0 out of the real kernel, with no reader injected, and the walk is
// then shown to stop where it must. Both halves are here together because the second half needs an
// injected parent to be reachable on this machine and the first half proves the injection is not
// carrying the feature.
test("FIX4 the walk reads real argv at depth 0 and stops at an ancestor that is itself a session", async () => {
  const stand = await bench();
  const other = path.join(stand.root, "other"); await fsp.mkdir(other, { mode: 0o700 });

  // Real process, real kernel argv, nothing injected.
  const direct = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  expect(proveResumeSuccession(direct.pid, OLD, argvReaders)).toMatchObject({ pid: direct.pid, depth: 0, proof: "resume_argv" });

  // Now the shape the boundary exists for: a session in another directory holds the receipt, and a
  // session in the table's directory is its child. The child is the only candidate — the parent is
  // in a different cwd and is filtered out — so without the boundary the child would inherit the
  // parent's receipt and claim a succession that belongs to a process still holding it.
  const parent = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  const child = await hold(["--permission-mode", "bypassPermissions"]);
  await publishSession(stand, parent, NEW_B, "p", other);
  await publishSession(stand, child, NEW_A, "c");
  const expected = { sessionId: OLD, cwd: stand.root, permissionMode: "bypass", expectedDisplayName: null };
  const options = { sessionsDir: stand.sessionsDir, processParentReader: (pid) => (pid === child.pid ? parent.pid : 1) };

  await expect(resolveSuccessor(expected, options)).rejects.toMatchObject({ diagnostic: "rebind_no_proof" });

  // Exactly what the boundary is doing, stated on its own: the same walk with the parent absent
  // from the boundary set does find the receipt, one step up.
  expect(proveResumeSuccession(child.pid, OLD, { argvReader: readProcessArgv, parentReader: () => parent.pid, boundary: new Set() }))
    .toMatchObject({ pid: parent.pid, depth: 1, proof: "resume_argv" });
  expect(proveResumeSuccession(child.pid, OLD, { argvReader: readProcessArgv, parentReader: () => parent.pid, boundary: new Set([parent.pid]) }))
    .toBeNull();
});

// `claude --help` advertises `-r, --resume [value]`, and a command line writes that option three
// ways. `--continue`/`-c` resume a session without naming one and are refused on purpose.
test("FIX5 every form of the receipt that names a session counts, and the ones that do not, do not", async () => {
  // `--` is in two of these because the program carrying the fixture arguments is bun, and bun has
  // its own `-r` (preload) and `-c` (config): given `-r <uuid>` it tries to preload the uuid and
  // exits, which measured as this test failing about one run in three. Everything after `--` is
  // left alone, and the tokens the proof reads are still adjacent and still exactly `-r` then the
  // id. The proof scans tokens; it does not care what came before them.
  const spaced = await holdAlive(["--resume", OLD]);
  const assigned = await holdAlive([`--resume=${OLD.toUpperCase()}`]);
  const short = await holdAlive(["--", "-r", OLD]);
  const continued = await holdAlive(["--continue", OLD]);
  const shortContinued = await holdAlive(["--", "-c", OLD]);

  expect(proveResumeSuccession(spaced.pid, OLD, argvReaders)).toMatchObject({ depth: 0, proof: "resume_argv" });
  expect(proveResumeSuccession(assigned.pid, OLD, argvReaders)).toMatchObject({ depth: 0, proof: "resume_argv" });
  expect(proveResumeSuccession(short.pid, OLD, argvReaders)).toMatchObject({ depth: 0, proof: "resume_argv" });
  // Neither of these names a session, so neither is a statement about the id in the table.
  expect(proveResumeSuccession(continued.pid, OLD, { ...argvReaders, parentReader: () => 1 })).toBeNull();
  expect(proveResumeSuccession(shortContinued.pid, OLD, { ...argvReaders, parentReader: () => 1 })).toBeNull();
  // And a receipt for another session is not a receipt for this one.
  expect(proveResumeSuccession(spaced.pid, OLD_B, { ...argvReaders, parentReader: () => 1 })).toBeNull();
});

test("R1 negative: a live session with no --resume receipt is not followed", async () => {
  const stand = await bench();
  const live = await hold(["--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root));
  const { store, core, alias } = await wire(stand);

  await expect(core.status(alias)).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE", diagnostic: "rebind_no_proof" });
  expect((await readTable(stand.paths))["friday-main"].sessionId).toBe(OLD);
  const refused = store.events.filter((event) => event.type === "target_rebind_failed");
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatchObject({ alias: "friday-main", expectedSessionId: OLD, reason: "rebind_no_proof", candidateCount: 0 });
  expect(refused[0].liveCandidates).toEqual([{ sessionId: NEW_A, pid: live.pid, cwd: stand.root }]);
  expect(refused[0].recovery).toContain(OLD);
  expect(refused[0].recovery).toContain("targets.json");
});

test("R1 negative: two proven successors rebind nothing", async () => {
  const stand = await bench();
  const first = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  const second = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, first, NEW_A, "a");
  await publishSession(stand, second, NEW_B, "b");
  await writeTable(stand.paths, table(stand.root));
  const { store, core, alias } = await wire(stand);

  await expect(core.status(alias)).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE", diagnostic: "rebind_ambiguous" });
  expect((await readTable(stand.paths))["friday-main"].sessionId).toBe(OLD);
  expect(store.events.filter((event) => event.type === "target_rebound")).toHaveLength(0);
  expect(store.events.at(-2)).toMatchObject({ type: "target_rebind_failed", reason: "rebind_ambiguous", candidateCount: 2 });
});

test('R1 negative: rebind "off" in the file beside the table refuses without looking', async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root));
  await writeSidecar(stand.paths, { mode: "off" });
  const { store, core, alias } = await wire(stand);

  await expect(core.status(alias)).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE", diagnostic: "rebind_disabled" });
  expect((await readTable(stand.paths))["friday-main"].sessionId).toBe(OLD);
  expect(store.events.filter((event) => event.type === "target_rebind_failed")).toMatchObject([{ reason: "rebind_disabled", rebind: "off" }]);
});

test("R1 no file beside the table means proof, not failure", async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root));
  await expect(fsp.lstat(stand.paths.rebindState)).rejects.toMatchObject({ code: "ENOENT" });
  const { core, alias } = await wire(stand);
  expect((await core.status(alias)).sessionId).toBe(NEW_A);
});

test("R1 the exact-match path is untouched: a live id resolves without a rebind and without a row", async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root, NEW_A));
  const { store, core, alias } = await wire(stand);

  expect((await core.status(alias)).sessionId).toBe(NEW_A);
  expect(store.events.filter((event) => event.type.startsWith("target_reb"))).toHaveLength(0);
  await expect(fsp.lstat(stand.paths.rebindState)).rejects.toMatchObject({ code: "ENOENT" });
});

test("R1 a send through a rebound alias re-verifies against the id that answered", async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root));
  const { store, core } = await wire(stand);
  let reverified = null;
  core.sender = async (_target, _frames, options) => { reverified = await options.reverify(); return { bytesWritten: 7 }; };

  const result = await core.send({
    alias: "friday-main", messageId: "10000000-0000-4000-8000-000000000001",
    threadId: "10000000-0000-4000-8000-000000000002", kind: "question", body: "hello"
  });
  expect(result.status).toBe("written");
  expect(reverified.sessionId).toBe(NEW_A);
  expect(store.events.find((event) => event.type === "send_requested").targetSessionId).toBe(NEW_A);
});

// Two aliases succeeding at the same moment used to lose one of them twice over: the temporary file
// name was a pid and a millisecond, so `O_EXCL` refused the second write with EEXIST — reproduced 3
// times in 3 attempts — and read-modify-write against one file is not safe against itself, so even
// without the collision the second rename would have dropped the first alias's repair.
test("FIX2 two successions at the same moment both land, in the table and in the ledger", async () => {
  const stand = await bench();
  const first = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  const second = await hold(["--resume", OLD_B, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, first, NEW_A, "a");
  await publishSession(stand, second, NEW_B, "b");
  await writeTable(stand.paths, {
    "friday-main": { sessionId: OLD, cwd: stand.root, permissionMode: "bypass" },
    erp: { sessionId: OLD_B, cwd: stand.root, permissionMode: "bypass" }
  });
  const { store, core } = await wire(stand);

  const [left, right] = await Promise.all([core.status("friday-main"), core.status("erp")]);
  expect(left.sessionId).toBe(NEW_A);
  expect(right.sessionId).toBe(NEW_B);

  const after = await readTable(stand.paths);
  expect(after["friday-main"].sessionId).toBe(NEW_A);
  expect(after.erp.sessionId).toBe(NEW_B);
  expect(store.events.filter((event) => event.type === "target_rebound")).toHaveLength(2);
  expect(store.events.filter((event) => event.type === "target_rebind_failed")).toHaveLength(0);

  const history = (await readRebindState(stand.paths.rebindState)).history;
  expect(history["friday-main"]).toEqual([OLD]);
  expect(history.erp).toEqual([OLD_B]);
});

// And when the write really cannot be done, it is reported as a write that could not be done. It
// used to leave this path as an error nothing recognised, which the caller read back as "no live
// session for that session id" — the exact diagnosis the succession had just disproved — with no
// row of its own in the ledger.
test("FIX2 a table that cannot be rewritten is reported as that, not as a missing session", async () => {
  const stand = await bench();
  const live = await hold(["--resume", OLD, "--permission-mode", "bypassPermissions"]);
  await publishSession(stand, live, NEW_A, "a");
  await writeTable(stand.paths, table(stand.root));
  const { store, core, alias } = await wire(stand, {
    writeSessionId: async () => { throw Object.assign(new Error("file already exists"), { code: "EEXIST" }); }
  });

  await expect(core.status(alias)).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE", diagnostic: "rebind_write_failed" });
  const refused = store.events.filter((event) => event.type === "target_rebind_failed");
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatchObject({
    alias: "friday-main", expectedSessionId: OLD, observedSessionId: NEW_A,
    reason: "rebind_write_failed", candidateCount: 1, proof: "resume_argv"
  });
  expect(refused[0].recovery).toContain("EEXIST");
  expect(store.events.at(-1)).toMatchObject({ type: "target_resolve_failed", reason: "rebind_write_failed" });
  expect((await readTable(stand.paths))["friday-main"].sessionId).toBe(OLD);
});
