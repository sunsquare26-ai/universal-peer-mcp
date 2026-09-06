import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTargets } from "../src/core/target-config.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });
test("loads stable alias and keeps display name diagnostic", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-config-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const cwd = path.join(root, "project"); await fsp.mkdir(cwd);
  const file = path.join(root, "targets.json"); await fsp.writeFile(file, JSON.stringify({ review: { sessionId: "10000000-0000-4000-8000-000000000002", cwd, expectedDisplayName: "Review", permissionMode: "prompting" } }), { mode: 0o600 });
  const targets = await loadTargets(file); expect(targets.review.expectedDisplayName).toBe("Review"); expect(targets.review.cwd).toBe(cwd);
});
test("rejects broad permissions and unknown fields", async () => {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-config-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const file = path.join(root, "targets.json"); await fsp.writeFile(file, "{}", { mode: 0o644 });
  await expect(loadTargets(file)).rejects.toThrow();
});
