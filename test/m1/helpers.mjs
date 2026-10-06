import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../../src/core/events.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";

export async function tempRoot(prefix = "upm-m1-") {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), prefix)));
  await fsp.chmod(root, 0o700);
  return root;
}
export async function openStore(root, options) { const store = new EventStore(statePaths(root), options); await store.init(); return store; }

// Rows as the ledger holds them, with explicit times, for the pure functions.
export function ledger(spec) {
  return spec.map(([type, at, data = {}], i) => ({ seq: i + 1, type, at, ...data }));
}
