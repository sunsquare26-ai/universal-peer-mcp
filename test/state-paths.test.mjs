import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { statePaths } from "../src/core/state-paths.mjs";

const DEFAULT_ROOT = path.join(os.homedir(), "Library", "Application Support", "claude-peer-mcp");
const KEY = "CLAUDE_PEER_MCP_STATE_DIR";
const previous = process.env[KEY];
afterEach(() => { if (previous === undefined) delete process.env[KEY]; else process.env[KEY] = previous; });

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
  delete process.env[KEY];
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
