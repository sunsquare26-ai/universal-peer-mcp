// M5 F4: a daemon that dies is no longer silent. Started through ensureDaemon it writes to
// <state>/daemon.log, and the next generation records that the previous one ended without
// daemon_stopping (killed, crashed, or the machine went down).
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDaemon } from "../../src/core/control.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { normalizeProcStart, processStart } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const roots = []; const live = [];
const alive = (pid, procStart) => { try { process.kill(pid, 0); return normalizeProcStart(processStart(pid)) === normalizeProcStart(procStart); } catch { return false; } };
afterEach(async () => {
  for (const { pid, procStart } of live.splice(0)) if (alive(pid, procStart)) process.kill(pid, "SIGTERM");
  await Bun.sleep(200);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

test("SIGKILL leaves a trace: daemon.log exists and the next start records daemon_previous_unclean", async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-death-")));
  roots.push(root); await fsp.chmod(root, 0o700);
  const paths = statePaths(root);
  const first = await ensureDaemon({ root }); live.push(first);
  expect(fs.statSync(paths.daemonLog).mode & 0o777).toBe(0o600);
  process.kill(first.pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(first.pid, first.procStart); i += 1) await Bun.sleep(20);
  const second = await ensureDaemon({ root }); live.push(second);
  expect(second.pid).not.toBe(first.pid);
  const rows = (await fsp.readFile(paths.events, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const starts = rows.filter((r) => r.type === "daemon_started");
  expect(starts).toHaveLength(2);
  const unclean = rows.find((r) => r.type === "daemon_previous_unclean");
  expect(unclean).toMatchObject({ previousGenerationId: starts[0].generationId, previousPid: first.pid });
  expect(starts[1].previousEnd).toBe("unclean"); expect(starts[0].previousEnd).toBe(null);
  expect((await fsp.readFile(paths.daemonLog, "utf8")).match(/daemon spawn by pid/g)).toHaveLength(2);
}, 30_000);

test("a clean SIGTERM is not reported as unclean", async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-death-")));
  roots.push(root); await fsp.chmod(root, 0o700);
  const first = await ensureDaemon({ root });
  process.kill(first.pid, "SIGTERM");
  for (let i = 0; i < 200 && alive(first.pid, first.procStart); i += 1) await Bun.sleep(20);
  const second = await ensureDaemon({ root }); live.push(second);
  const rows = (await fsp.readFile(statePaths(root).events, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.some((r) => r.type === "daemon_previous_unclean")).toBe(false);
  expect(rows.filter((r) => r.type === "daemon_started").at(-1).previousEnd).toBe("stopped");
}, 30_000);

test("an uncaught exception is recorded as daemon_crashed, cleans up its lock, and the next start says crashed", async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-death-")));
  roots.push(root); await fsp.chmod(root, 0o700);
  const paths = statePaths(root);
  process.env.UNIVERSAL_PEER_TEST_CRASH = "1";
  let first; try { first = await ensureDaemon({ root }); } finally { delete process.env.UNIVERSAL_PEER_TEST_CRASH; }
  for (let i = 0; i < 300 && alive(first.pid, first.procStart); i += 1) await Bun.sleep(20);
  expect(alive(first.pid, first.procStart)).toBe(false);
  expect(fs.existsSync(paths.daemonLock)).toBe(false);
  expect(await fsp.readFile(paths.daemonLog, "utf8")).toContain("uncaught_exception");
  const second = await ensureDaemon({ root }); live.push(second);
  const rows = (await fsp.readFile(paths.events, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.find((r) => r.type === "daemon_crashed")).toMatchObject({ kind: "uncaught_exception", name: "Error", code: "TEST_CRASH" });
  expect(rows.filter((r) => r.type === "daemon_started").at(-1).previousEnd).toBe("crashed");
  expect(rows.some((r) => r.type === "daemon_previous_unclean")).toBe(false);
}, 30_000);
