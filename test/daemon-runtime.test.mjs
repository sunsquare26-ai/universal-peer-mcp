// The daemon's runtime used to be whoever called it. `ensureDaemon` spawned `process.execPath`,
// and every module the daemon loads reaches src/adapters/claude-native-v1/darwin-procargs.mjs,
// whose second line is `import { dlopen, FFIType, ptr } from "bun:ffi"`. A caller on node handed
// the daemon a runtime it cannot start under, and the child is detached with its stdio ignored, so
// this side sees nothing of the death: the exit races the readiness poll and usually loses, so the
// caller waits ten seconds and is told `readiness_timeout` — the symptom of a daemon that never
// came up, never the reason.
//
// R5 and R6 hold the repair: the executable is bun because the daemon needs bun, not because the
// caller happened to be on it. R6 does not take the resolver's word for it — it reads the started
// daemon's own executable name out of the kernel by way of `ps`, which is the same rendering this
// package trusts everywhere else.
//
// R7 is the negative control, and it is the half that can fail for the right reason. A search that
// always finds bun on a machine that always has bun proves nothing; R7 takes bun away — a caller
// that is not bun, a PATH with nothing on it, a home directory that is not there — and requires
// the named failure at once. Its two halves are separate claims: that the failure says what was
// looked for, and that it arrives before the readiness deadline it replaces. It also leaves a dead
// daemon's record in the directory and requires it to survive, because a machine that cannot start
// a daemon must not first delete the traces of the last one that ran.
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const diagnosticRoot = process.env.PEER_DIAGNOSTIC_ROOT;
const at = (p) => diagnosticRoot ? pathToFileURL(path.join(diagnosticRoot, "src", p)).href : new URL(`../src/${p}`, import.meta.url).href;
const { controlCall, ensureDaemon, resolveBunExecutable } = await import(at("core/control.mjs"));
const { statePaths } = await import(at("core/state-paths.mjs"));
const { normalizeProcStart, processStart } = await import(at("adapters/claude-native-v1/darwin-procargs.mjs"));

// `daemon_shutdown` is answered only by a daemon whose environment carries CLAUDE_PEER_MCP_ADMIN=1
// (src/daemon.mjs), and a test runner's does not, so the polite request is refused and the daemon
// this file started outlives the run — its state directory removed out from under it. So the
// request is made first and SIGTERM, the package's own shutdown path, finishes the job. The signal
// goes to a pid this file recorded, and only while that pid still renders the start time it was
// recorded with: a pid alone is not an identity, and the one thing worse than an orphan here is
// signalling a stranger that inherited its number.
const roots = []; const daemons = [];
async function stopDaemon({ root, pid, procStart }) {
  try { await controlCall("daemon_shutdown", {}, { root }); } catch {}
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    let live = false;
    try { live = normalizeProcStart(processStart(pid)) === normalizeProcStart(procStart); } catch { return; }
    if (!live) return;
    if (attempt === 20) process.kill(pid, "SIGTERM");
    await Bun.sleep(25);
  }
  throw new Error(`daemon ${pid} did not stop`);
}
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function stand() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-runtime-")));
  roots.push(root); await fsp.chmod(root, 0o700);
  return root;
}

// A runtime that is present and executable and is not bun. It is never meant to be spawned; it is
// here so the caller's executable is a real file, which is the case the repair has to refuse.
async function plantNonBunRuntime(root) {
  const directory = path.join(root, "runtime"); await fsp.mkdir(directory, { mode: 0o700 });
  const executable = path.join(directory, "node");
  await fsp.writeFile(executable, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
  return executable;
}

function unusedPid() {
  for (let pid = 99_998; pid > 90_000; pid -= 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return pid; }
  }
  throw new Error("no unused pid to stand in for a dead daemon");
}

test("R5 a caller that is not bun still resolves the bun the daemon needs", async () => {
  const root = await stand();
  const notBun = await plantNonBunRuntime(root);

  const resolved = resolveBunExecutable({ execPath: notBun, runningOnBun: false });
  expect(resolved).not.toBe(notBun);
  expect(path.basename(resolved)).toBe("bun");
  // The name is not the proof. Only a bun defines `Bun`.
  expect(execFileSync(resolved, ["-e", "process.stdout.write(typeof globalThis.Bun)"], { encoding: "utf8" })).toBe("object");

  // And a caller that is already on bun keeps its own executable rather than going looking.
  expect(resolveBunExecutable({ execPath: process.execPath, runningOnBun: true })).toBe(process.execPath);
});

test("R6 the daemon comes up on the bun that was searched for, not the caller's runtime", async () => {
  const root = await stand();
  const notBun = await plantNonBunRuntime(root);
  // A second name for this machine's bun, so "which bun did it start" has an answer that is not
  // the same string as `process.execPath`. Without it a test runner that is itself on bun cannot
  // tell a searched-for executable from an inherited one, and the assertion below would hold just
  // as well with the search removed.
  const install = path.join(root, "bun-install", "bin"); await fsp.mkdir(install, { recursive: true, mode: 0o700 });
  const named = path.join(install, "bun"); await fsp.symlink(process.execPath, named);
  const runtime = { execPath: notBun, runningOnBun: false, env: { PATH: path.join(root, "empty"), BUN_INSTALL: path.dirname(install) }, home: path.join(root, "absent-home") };
  expect(resolveBunExecutable(runtime)).toBe(named);

  const row = await ensureDaemon({ root, timeoutMs: 20_000, runtime });
  daemons.push({ root, pid: row.pid, procStart: row.procStart });
  expect(Number.isInteger(row.pid)).toBe(true);
  expect(row.socketPath).toBe(statePaths(root).controlSocket);

  // The kernel's own answer to what is running, rendered by the pinned `ps` this package uses
  // everywhere: the daemon was executed as the bun that was found, and not as this process's.
  const command = execFileSync("/bin/ps", ["-ww", "-p", String(row.pid), "-o", "comm="], { encoding: "utf8" }).trim();
  expect(command).toBe(named);

  // It is a daemon and not merely a process: it answers on its own control socket.
  expect(await controlCall("daemon_status", {}, { root })).toBeTruthy();
});

test("R7 no bun on the machine fails at once and says where it looked", async () => {
  const root = await stand();
  const notBun = await plantNonBunRuntime(root);
  const emptyPath = path.join(root, "empty-path"); await fsp.mkdir(emptyPath, { mode: 0o700 });
  const absentHome = path.join(root, "absent-home");
  const nowhere = { execPath: notBun, runningOnBun: false, env: { PATH: emptyPath }, home: absentHome };

  let refusal = null;
  try { resolveBunExecutable(nowhere); } catch (error) { refusal = error; }
  expect(refusal?.code).toBe("BUN_NOT_FOUND");
  expect(refusal.message).toContain(path.join(absentHome, ".bun", "bin", "bun"));
  expect(refusal.message).toContain(path.join(emptyPath, "bun"));

  // Nothing was reclaimed on the way to that refusal.
  const paths = statePaths(root);
  const record = { pid: unusedPid(), socketPath: paths.controlSocket, procStart: "Thu Jan  1 00:00:00 1970" };
  await fsp.writeFile(paths.daemon, `${JSON.stringify(record)}\n`, { mode: 0o600 });

  const startedAt = Date.now();
  let failure = null;
  try { await ensureDaemon({ root, timeoutMs: 10_000, runtime: nowhere }); } catch (error) { failure = error; }
  const elapsedMs = Date.now() - startedAt;

  expect(failure?.code).toBe("BUN_NOT_FOUND");
  expect(failure.message).not.toContain("readiness_timeout");
  expect(elapsedMs).toBeLessThan(2_000);
  expect(JSON.parse(await fsp.readFile(paths.daemon, "utf8"))).toEqual(record);
  await expect(fsp.lstat(paths.controlSocket)).rejects.toMatchObject({ code: "ENOENT" });
});
