import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { controlCall, ensureDaemon } from "../src/core/control.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const roots = []; const pids = [];
afterEach(async () => { for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch {} } await Bun.sleep(30); for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

test("persistent daemon serves redacted status and cleans up on SIGTERM", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-control-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
  const daemon = await ensureDaemon({ root }); pids.push(daemon.pid);
  const status = await controlCall("daemon_status", {}, { root });
  expect(status.running).toBe(true); expect(status.targetCount).toBe(0); expect(JSON.stringify(status)).not.toContain("token"); expect(JSON.stringify(status)).not.toContain("sock");
  // Bound the way the façade binds it — this daemon, this table — so what the refusal is about
  // is the alias and not the binding. Unbound it is refused too, before dispatch, which is
  // test/checked-table-binding.test.mjs.
  const bound = { root, expect: { daemonPid: status.pid, daemonProcStart: status.procStart, targetsDigest: status.targetsDigest } };
  try { await controlCall("peer_status", { alias: "missing" }, bound); throw new Error("expected unavailable target"); } catch (error) { expect(error.code).toBe("TARGET_UNAVAILABLE"); }
  const held = net.createConnection({ path: statePaths(root).controlSocket }); await new Promise((resolve, reject) => { held.once("connect", resolve); held.once("error", reject); });
  process.kill(daemon.pid, "SIGTERM"); pids.pop();
  const paths = statePaths(root); for (let i = 0; i < 200; i += 1) { if ((await Promise.all([paths.daemon, paths.controlToken, paths.controlSocket, paths.daemonLock].map((file) => Bun.file(file).exists()))).every((exists) => !exists)) break; await Bun.sleep(10); }
  expect(await Bun.file(paths.daemon).exists()).toBe(false); expect(await Bun.file(paths.controlToken).exists()).toBe(false); expect(await Bun.file(paths.controlSocket).exists()).toBe(false); expect(await Bun.file(paths.daemonLock).exists()).toBe(false);
});

// A lock whose pid has been handed to someone else is reclaimable; a lock whose pid still answers
// is not, whatever start time it records. The second half is the important one: "the pid is alive
// and I cannot identify it" is doubt, and reclaiming on doubt puts two daemons in one directory.
test("reclaims a lock whose PID is gone and refuses one whose PID still answers", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-control-reused-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const paths = statePaths(root);
  await fsp.writeFile(paths.daemonLock, `${JSON.stringify({ pid: process.pid, procStart: "not-this-process" })}\n`, { mode: 0o600 });
  await expect(ensureDaemon({ root })).rejects.toThrow("cleared by hand");
  expect(await Bun.file(paths.daemonLock).exists()).toBe(true);

  const stranger = spawn("sleep", ["45"], { stdio: "ignore" }); const gone = stranger.pid;
  stranger.kill("SIGKILL"); await new Promise((resolve) => stranger.once("exit", resolve));
  await fsp.writeFile(paths.daemonLock, `${JSON.stringify({ pid: gone, procStart: "not-this-process" })}\n`, { mode: 0o600 });
  const daemon = await ensureDaemon({ root }); pids.push(daemon.pid); expect(daemon.pid).not.toBe(process.pid); expect(daemon.pid).not.toBe(gone);
  process.kill(daemon.pid, "SIGTERM"); pids.pop();
  for (let i = 0; i < 200; i += 1) { if (!(await Bun.file(paths.daemonLock).exists())) break; await Bun.sleep(10); }
  expect(await Bun.file(paths.daemonLock).exists()).toBe(false);
});
