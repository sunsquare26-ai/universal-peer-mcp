import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import { statePaths } from "../../src/core/state-paths.mjs";
import { tempRoot, openStore } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) { await fsp.chmod(statePaths(r).events, 0o600).catch(() => {}); await fsp.rm(r, { recursive: true, force: true }); } });

test("a healthy ledger reports its last append and no error", async () => {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  const row = await store.append("daemon_started", { generationId: crypto.randomUUID() });
  expect(store.health()).toEqual({ poisoned: false, lastSeq: row.seq, lastAppendAt: row.at, lastError: null });
});

test("a failed append poisons the store, is visible in health, and alarms exactly once", async () => {
  const root = await tempRoot(); roots.push(root);
  const calls = [];
  const store = await openStore(root, { onPoisoned: (h) => { calls.push(h); } });
  await store.append("daemon_started", {});
  await fsp.chmod(statePaths(root).events, 0o400);
  await expect(store.append("peer_ack", {})).rejects.toThrow();
  await expect(store.append("peer_ack", {})).rejects.toThrow();
  const health = store.health();
  expect(health.poisoned).toBe(true);
  expect(health.lastError.code).toBe("EACCES");
  expect(health.lastSeq).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].poisoned).toBe(true);
  expect(JSON.stringify(health)).not.toContain(root);
});

test("a refused oversize row is reported but does not poison", async () => {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  await expect(store.append("peer_ack", { pad: "x".repeat(70 * 1024) })).rejects.toThrow();
  expect(store.health().poisoned).toBe(false);
  expect(store.health().lastError.code).toBe("EVENT_TOO_LARGE");
  await store.append("peer_ack", {});
});
