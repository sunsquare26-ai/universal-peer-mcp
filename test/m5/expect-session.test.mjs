// Review of edd1457: a doorbell attempt names its session, and PeerCore checks it after the send
// lock and the resolve — a send queued while the alias moved is refused before anything is reserved
// or written. (Adapted from the reviewer's fixture.)
import { expect, test } from "bun:test";
import { milestoneSendOptions, PeerCore } from "../../src/core/peer-core.mjs";
import { provenPermission } from "../../src/core/target-config.mjs";

const A = "10000000-0000-4000-8000-0000000000aa"; const B = "20000000-0000-4000-8000-0000000000aa";
function stand() {
  const targets = { "c-1": { sessionId: A } }; const rows = []; const writes = [];
  const store = { request: () => null, async reserveRequest(data) { const event = { seq: rows.length + 1, type: "send_requested", ...data }; rows.push(event); return { created: true, event }; }, async append(type, data) { const e = { seq: rows.length + 1, type, ...data }; rows.push(e); return e; } };
  const core = new PeerCore({ targets, store, address: "uds:/fixture.sock",
    resolver: async (expected) => ({ sessionId: expected.sessionId, cwd: "/fixture", socketPath: "/fixture.sock", pid: 123, procStart: "Wed Oct 7 00:00:00 2026", token: "fixture-token-12345678", permission: provenPermission("prompting") }),
    sender: async (target) => { writes.push(target.sessionId); return { bytesWritten: 1 }; } });
  return { core, targets, rows, writes };
}
const send = (core, id, expectSessionId) => core.send({ alias: "c-1", messageId: id, threadId: id, kind: "doorbell", body: "fixture" }, milestoneSendOptions({ wireBody: "fixture", expectSessionId }));

test("queued while the alias moved to B: refused, nothing reserved or written", async () => {
  const s = stand(); const id = "30000000-0000-4000-8000-0000000000aa";
  let release; s.core.sendLocks.set(id, new Promise((r) => { release = r; }));
  const sent = send(s.core, id, A);
  s.targets["c-1"] = { sessionId: B }; release();
  await expect(sent).rejects.toMatchObject({ code: "WAKE_GENERATION_STALE" });
  expect(s.writes).toEqual([]); expect(s.rows.filter((r) => r.type === "send_requested")).toEqual([]);
});
test("the alias still names A: sent to A", async () => {
  const s = stand(); const id = "40000000-0000-4000-8000-0000000000aa";
  await send(s.core, id, A);
  expect(s.writes).toEqual([A]);
});
