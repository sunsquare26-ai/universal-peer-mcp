import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedStateDir, resolveStateDirEnv } from "../../src/core/state-paths.mjs";

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const pkg = (content, mode = 0o600) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "upm-pkg-")); dirs.push(d); if (content !== null) { fs.writeFileSync(path.join(d, "STATE_DIR"), content); fs.chmodSync(path.join(d, "STATE_DIR"), mode); } return d; };

test("an install's STATE_DIR names its state directory", () => {
  expect(installedStateDir(pkg("/Users/x/state\n"))).toBe("/Users/x/state");
});
test("refused: missing, relative, writable by others, or a link", () => {
  expect(installedStateDir(pkg(null))).toBeNull();
  expect(installedStateDir(pkg("relative/state\n"))).toBeNull();
  expect(installedStateDir(pkg("/Users/x/state\n", 0o666))).toBeNull();
  const d = pkg(null); fs.writeFileSync(path.join(d, "real"), "/Users/x/state\n"); fs.symlinkSync(path.join(d, "real"), path.join(d, "STATE_DIR"));
  expect(installedStateDir(d)).toBeNull();
});
test("the variable still wins over the install file", () => {
  expect(resolveStateDirEnv({ UNIVERSAL_PEER_MCP_STATE_DIR: "/explicit" })).toMatchObject({ root: "/explicit", source: "UNIVERSAL_PEER_MCP_STATE_DIR" });
});
