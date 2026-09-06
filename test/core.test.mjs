import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const roots = []; const messageId = "10000000-0000-4000-8000-000000000010"; const threadId = "10000000-0000-4000-8000-000000000011";
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });
async function make({ fail = false, sendDelay = 0 } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-core-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: "10000000-0000-4000-8000-000000000012", cwd: root, permissionMode: "prompting", expectedDisplayName: "Expected" };
  const resolved = { ...target, pid: 99, procStart: "start", socketPath: "/tmp/fake.sock", token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: "Changed" };
  let sendCount = 0;
  const core = new PeerCore({ targets: { review: target }, store, address: "uds:/tmp/sender.sock", resolver: async () => resolved, sender: async () => { sendCount += 1; if (sendDelay) await Bun.sleep(sendDelay); if (fail) throw new Error("fail"); return { bytesWritten: 42 }; } });
  return { core, store, sendCount: () => sendCount };
}

describe("peer core", () => {
  test("display name mismatch is observational", async () => { const { core, store } = await make(); const status = await core.status("review"); expect(status.connected).toBe(true); expect(store.events[0].type).toBe("display_name_observed"); });
  test("dedupes same request and rejects conflict", async () => { const { core } = await make(); const request = { alias: "review", messageId, threadId, kind: "question", body: "hello" }; const first = await core.send(request); expect(first.replay).toBe(false); expect(first.status).toBe("written"); const replay = await core.send(request); expect(replay.replay).toBe(true); expect(replay.status).toBe("written"); try { await core.send({ ...request, body: "different" }); throw new Error("expected conflict"); } catch (error) { expect(error.code).toBe("MESSAGE_ID_CONFLICT"); } });
  test("reserves one concurrent send atomically", async () => {
    const { core, store, sendCount } = await make({ sendDelay: 20 }); const request = { alias: "review", messageId, threadId, kind: "question", body: "hello" };
    const results = await Promise.all([core.send(request), core.send(request)]);
    expect(results.map((result) => result.replay).sort()).toEqual([false, true]); expect(sendCount()).toBe(1); expect(store.events.filter((event) => event.type === "send_requested")).toHaveLength(1);
  });
  test("does not automatically retry uncertain failure", async () => { const { core, store } = await make({ fail: true }); try { await core.send({ alias: "review", messageId, threadId, kind: "question", body: "hello" }); throw new Error("expected uncertain failure"); } catch (error) { expect(error.code).toBe("DELIVERY_UNCERTAIN"); } expect(store.events.filter((e) => e.type === "send_requested")).toHaveLength(1); });
  test("classifies allowlist and resolver failures with a stable code", async () => { const { core } = await make(); try { await core.status("missing"); throw new Error("expected unavailable target"); } catch (error) { expect(error.code).toBe("TARGET_UNAVAILABLE"); } const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-core-resolver-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const store = new EventStore(statePaths(root)); await store.init(); const broken = new PeerCore({ targets: { review: { sessionId: messageId, cwd: root, permissionMode: "prompting" } }, store, address: "uds:/tmp/sender.sock", resolver: async () => { throw new Error("unsupported Claude peer protocol"); } }); try { await broken.status("review"); throw new Error("expected unavailable target"); } catch (error) { expect(error.code).toBe("TARGET_UNAVAILABLE"); } });
  test("wait fan-out resolves from one durable reply", async () => { const { core } = await make(); await core.send({ alias: "review", messageId, threadId, kind: "question", body: "hello" }); const a = core.wait({ messageId, timeoutMs: 1000 }); const b = core.wait({ messageId, timeoutMs: 1000 }); await core.acceptFrame({ message: { content: `PEER_REPLY v=1 message_id=10000000-0000-4000-8000-000000000013 thread_id=${threadId} reply_to=${messageId} verdict=pass` } }, { pid: 99, procStart: "start" }); expect((await a).evidence).toBe("application_ack"); expect((await b).evidence).toBe("application_ack"); });
  test("binds inbound evidence to the target process and reports durable wait state", async () => {
    const { core, store } = await make(); await core.send({ alias: "review", messageId, threadId, kind: "question", body: "hello" });
    await expect(core.acceptFrame({ type: "control", action: "peer_message_status", orig_msg_id: messageId, status: "delivered" }, { pid: 100, procStart: "other" })).rejects.toThrow("identity mismatch");
    expect(store.events.some((event) => event.type === "peer_message_status")).toBe(false);
    await core.acceptFrame({ type: "control", action: "peer_message_status", orig_msg_id: messageId, status: "delivered" }, { pid: 99, procStart: "start" });
    expect((await core.wait({ messageId, require: "delivery", timeoutMs: 50 })).evidence).toBe("message_status");
    const timeout = await core.wait({ messageId, require: "reply", timeoutMs: 5 }); expect(timeout.timedOut).toBe(true); expect(timeout.state).toBe("delivered"); expect(timeout.events.at(-1).status).toBe("delivered");
  });
  test("returns a durable terminal failure immediately", async () => {
    const { core } = await make(); await core.send({ alias: "review", messageId, threadId, kind: "question", body: "hello" });
    await core.acceptFrame({ type: "control", action: "peer_message_status", orig_msg_id: messageId, status: "denied" }, { pid: 99, procStart: "start" });
    const result = await core.wait({ messageId, require: "terminal", timeoutMs: 50 }); expect(result.event.type).toBe("peer_terminal_failure"); expect(result.event.status).toBe("denied"); expect(result.evidence).toBe("message_status");
  });
});
