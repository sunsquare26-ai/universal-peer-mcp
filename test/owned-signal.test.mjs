// The rule the end to end cleanup follows, tested against real processes: a remembered pid is
// only signalled while the process holding it is still the one that was remembered.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { owns, procStartOf, signalChild, signalOwned } from "./owned-signal.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const started = [];
afterEach(() => { for (const child of started.splice(0)) { try { child.kill("SIGKILL"); } catch {} } });

function sleeper() {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  started.push(child);
  return child;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function gone(pid) {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) await Bun.sleep(20);
  return !alive(pid);
}

test("a pid answers with its start time while it runs and with nothing afterwards", async () => {
  const child = sleeper();
  const procStart = procStartOf(child.pid);
  expect(typeof procStart).toBe("string");
  expect(procStart.length).toBeGreaterThan(0);
  expect(owns(child.pid, procStart)).toBe(true);
  expect(owns(child.pid, "Thu Jan 1 00:00:00 1970")).toBe(false);
  expect(owns(child.pid, "")).toBe(false);
  expect(owns(child.pid, undefined)).toBe(false);

  child.kill("SIGKILL");
  expect(await gone(child.pid)).toBe(true);
  expect(procStartOf(child.pid)).toBe(null);
  expect(owns(child.pid, procStart)).toBe(false);
});

test("a process this run started is signalled", async () => {
  const child = sleeper();
  const registry = new Map([[child.pid, procStartOf(child.pid)]]);
  expect(signalOwned(registry, "SIGTERM")).toEqual([child.pid]);
  expect(await gone(child.pid)).toBe(true);
});

// The finding, in one test: the pid is remembered but the process behind it is not the one
// that was remembered. Signalling on the pid alone would end it.
test("a live process whose start time does not match the record is left alone", async () => {
  const stranger = sleeper();
  const registry = new Map([[stranger.pid, "Thu Jan 1 00:00:00 1970"]]);
  expect(signalOwned(registry, "SIGTERM")).toEqual([]);
  await Bun.sleep(150);
  expect(alive(stranger.pid)).toBe(true);
});

test("a pid that no longer exists is not signalled and does not throw", async () => {
  const child = sleeper();
  const procStart = procStartOf(child.pid);
  child.kill("SIGKILL");
  expect(await gone(child.pid)).toBe(true);
  expect(signalOwned(new Map([[child.pid, procStart]]), "SIGTERM")).toEqual([]);
});

test("a child that has already exited is not signalled again", async () => {
  const child = sleeper();
  expect(signalChild(child, "SIGTERM")).toBe(true);
  await new Promise((resolve) => child.once("exit", resolve));
  expect(signalChild(child, "SIGKILL")).toBe(false);
  expect(signalChild(null, "SIGKILL")).toBe(false);
});

// A guard that one call site forgets is not a guard. The end to end run must reach every
// signal through this module.
test("the end to end run signals only through the ownership check", async () => {
  const source = await fsp.readFile(path.join(ROOT, "test/e2e.test.mjs"), "utf8");
  expect(source).toContain('from "./owned-signal.mjs"');
  expect(source).not.toMatch(/process\.kill\(/);
  expect(source).not.toMatch(/\.kill\(["'`]SIG/);
  expect(source).toMatch(/daemonPids = new Map\(\)/);
});
