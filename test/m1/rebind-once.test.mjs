import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { PeerCore } from "../../src/core/peer-core.mjs";
import { createSessionRebinder } from "../../src/core/session-rebind.mjs";
import { dailyStats, pairedResolveRows } from "../../src/core/trace.mjs";
import { openStore, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });

test("a real rebind failure links its resolve row to its rebind row and is counted once", async () => {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  const sessionId = crypto.randomUUID();
  const rebind = createSessionRebinder({
    targetsFile: path.join(root, "targets.json"), stateFile: null, store,
    mode: async () => "resume",
    resolveSuccessor: async () => { throw Object.assign(new Error("resolved to 0 proven successors"), { diagnostic: "rebind_no_proof", candidateCount: 1 }); }
  });
  const core = new PeerCore({
    targets: { "main-claude": { sessionId, cwd: root, permissionMode: "bypass" } }, store, address: "uds:/tmp/cc-socks/x.sock", rebind,
    resolver: async () => { throw new Error("resolved to 0 live candidates"); }
  });
  await expect(core.send({ alias: "main-claude", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "review", body: "x" })).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  const rebindRow = store.events.find((e) => e.type === "target_rebind_failed");
  const resolveRow = store.events.find((e) => e.type === "target_resolve_failed");
  expect(rebindRow.reason).toBe("rebind_no_proof");
  expect(resolveRow).toMatchObject({ reason: "rebind_no_proof", rebindFailedSeq: rebindRow.seq });
  expect([...pairedResolveRows(store.events)]).toEqual([resolveRow.seq]);
  const [day] = Object.values(dailyStats(store.events));
  expect(day.rebindFailed).toEqual({ rebind_no_proof: 1 });
  expect(day.resolveFailed).toEqual({});
});

test("a rebind that is switched off is linked too", async () => {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  const rebind = createSessionRebinder({ targetsFile: path.join(root, "targets.json"), stateFile: null, store, mode: async () => "off", resolveSuccessor: async () => { throw new Error("not reached"); } });
  const core = new PeerCore({ targets: { "main-claude": { sessionId: crypto.randomUUID(), cwd: root, permissionMode: "bypass" } }, store, address: "uds:/tmp/cc-socks/x.sock", rebind, resolver: async () => { throw new Error("resolved to 0 live candidates"); } });
  await expect(core.send({ alias: "main-claude", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "review", body: "x" })).rejects.toThrow();
  const rebindRow = store.events.find((e) => e.type === "target_rebind_failed");
  expect(store.events.find((e) => e.type === "target_resolve_failed")).toMatchObject({ reason: "rebind_disabled", rebindFailedSeq: rebindRow.seq });
});
