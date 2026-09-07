import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LEGACY_STATE_DIR_ENV, LEGACY_STATE_DIR_WARNING, resolveStateDirEnv, STATE_DIR_ENV, statePaths } from "../src/core/state-paths.mjs";

// The default directory keeps the old package's name. Renaming a variable is free — it can be
// read under two names at once — and renaming a directory is not, so the two were separated and
// only the variable moved (src/core/state-paths.mjs).
const DEFAULT_ROOT = path.join(os.homedir(), "Library", "Application Support", "claude-peer-mcp");
const KEY = STATE_DIR_ENV;
const OLD = LEGACY_STATE_DIR_ENV;
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const saved = { [KEY]: process.env[KEY], [OLD]: process.env[OLD] };
beforeEach(() => { delete process.env[KEY]; delete process.env[OLD]; });
afterEach(() => {
  for (const key of [KEY, OLD]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

test("an empty state directory environment value is not an override", () => {
  process.env[KEY] = "";
  const paths = statePaths();
  expect(paths.root).toBe(DEFAULT_ROOT);
  expect(paths.root).not.toBe(process.cwd());
  for (const file of ["events", "owner", "controlSocket", "controlToken", "daemon", "daemonLock", "targets"]) {
    expect(paths[file].startsWith(`${DEFAULT_ROOT}${path.sep}`)).toBe(true);
    expect(paths[file].startsWith(`${process.cwd()}${path.sep}`)).toBe(false);
  }
});

test("an explicit empty root falls back to the default instead of the working directory", () => {
  expect(statePaths("").root).toBe(DEFAULT_ROOT);
});

test("a real state directory environment value is still an override", () => {
  process.env[KEY] = path.join(os.tmpdir(), "peer-state-override");
  expect(statePaths().root).toBe(path.join(os.tmpdir(), "peer-state-override"));
});

test("an explicit root still wins over the environment", () => {
  process.env[KEY] = path.join(os.tmpdir(), "peer-state-env");
  expect(statePaths(path.join(os.tmpdir(), "peer-state-arg")).root).toBe(path.join(os.tmpdir(), "peer-state-arg"));
});

// ---- the rename's compatibility window ---------------------------------------------------------
// Four states, and the fourth is the reason the other three are written down. A variable that is
// simply renamed does not break an install loudly: the old name stops being read, the process comes
// up on the default directory, finds no target table, and answers exactly as a clean install does.
// So the old name is still read, saying so once; and when both names are set to two different
// directories nothing is chosen, because whichever was chosen the other half of the installation
// is on the one that was not.

function run(args, environment) {
  return new Promise((resolve) => {
    execFile("bun", args, { cwd: ROOT, env: environment, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}
// A doctor run reads and never writes, so these can be pointed at a directory that does not exist —
// and the absence is checked afterwards.
function cliEnvironment(extra) {
  const base = { ...process.env };
  for (const key of [KEY, OLD]) delete base[key];
  return { ...base, ...extra };
}
async function missing(file) { try { await fsp.lstat(file); return false; } catch { return true; } }

test("the current name alone is read, and says nothing", () => {
  const root = path.join(os.tmpdir(), "peer-state-current-only");
  process.env[KEY] = root;
  expect(resolveStateDirEnv()).toEqual({ root, source: KEY, deprecated: false, warning: null });
  expect(statePaths().root).toBe(root);
});

test("the old name alone is still read, and is warned about once on stderr", async () => {
  const root = path.join(os.tmpdir(), "peer-state-old-only");
  process.env[OLD] = root;
  expect(resolveStateDirEnv()).toEqual({ root, source: OLD, deprecated: true, warning: LEGACY_STATE_DIR_WARNING });
  expect(statePaths().root).toBe(root);

  // and end to end, because "warns on stderr" is a claim about a process, not about a function
  const report = await run(["src/cli.mjs", "doctor"], cliEnvironment({ [OLD]: root }));
  expect(report.code).toBe(0);
  expect(report.stderr.trim().split("\n")).toEqual([LEGACY_STATE_DIR_WARNING]);
  expect(JSON.parse(report.stdout).stateDirectorySource).toBe(OLD);
  expect(await missing(root)).toBe(true);
});

test("both names set to the same directory is not a conflict and is not warned about", async () => {
  const root = path.join(os.tmpdir(), "peer-state-both-same");
  process.env[KEY] = root; process.env[OLD] = `${root}${path.sep}`;
  expect(resolveStateDirEnv()).toEqual({ root, source: KEY, deprecated: false, warning: null });
  expect(statePaths().root).toBe(root);

  const report = await run(["src/cli.mjs", "doctor"], cliEnvironment({ [KEY]: root, [OLD]: root }));
  expect(report.code).toBe(0);
  expect(report.stderr).toBe("");
  expect(JSON.parse(report.stdout).stateDirectorySource).toBe(KEY);
});

test("both names set to different directories is refused rather than resolved", async () => {
  const current = path.join(os.tmpdir(), "peer-state-both-current");
  const legacy = path.join(os.tmpdir(), "peer-state-both-legacy");
  process.env[KEY] = current; process.env[OLD] = legacy;
  expect(() => resolveStateDirEnv()).toThrow(`${KEY} and ${OLD} name two different state directories`);
  expect(() => statePaths()).toThrow(`${KEY} and ${OLD} name two different state directories`);
  // an explicit root is not a resolution of the two and is unaffected
  expect(statePaths(current).root).toBe(current);

  const report = await run(["src/cli.mjs", "doctor"], cliEnvironment({ [KEY]: current, [OLD]: legacy }));
  expect(report.code).not.toBe(0);
  expect(report.stdout).toBe("");
  expect(report.stderr).toContain(KEY);
  expect(report.stderr).toContain(OLD);
  expect(await missing(current)).toBe(true);
  expect(await missing(legacy)).toBe(true);
});
