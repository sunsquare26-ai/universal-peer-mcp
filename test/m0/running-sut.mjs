// The code that is actually running (daemon pid 1624 since 2026-09-26) is imported into this
// tree unchanged (commit "Import the running install exactly as it is"). The reproductions run
// against this tree by default. UP_RUNNING_SRC points them at another copy, e.g. the live install,
// to confirm the tree and the install still behave the same.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const RUNNING_SRC = process.env.UP_RUNNING_SRC ?? fileURLToPath(new URL("../../src", import.meta.url));
export const RUNNING_AVAILABLE = fs.existsSync(path.join(RUNNING_SRC, "core/inbound-spool.mjs"));

export const THREAD = "9f9f218b-7474-40df-a166-e37d9bcf1a84";
export const PEER = Object.freeze({ pid: 47687, procStart: "Fri Sep 11 01:14:58 2026" });

export async function loadRunning() {
  const m = (rel) => import(path.join(RUNNING_SRC, rel));
  const [{ EventStore }, { InboundSpool }, { frameObserver, PeerCore }, { statePaths }, tools] = await Promise.all([
    m("core/events.mjs"), m("core/inbound-spool.mjs"), m("core/peer-core.mjs"), m("core/state-paths.mjs"), m("mcp/tools.mjs")
  ]);
  return { EventStore, InboundSpool, frameObserver, PeerCore, statePaths, toolDefinitions: tools.toolDefinitions };
}

// A private temp state root with one outstanding request, written the way `send` writes it.
export async function fixture(sut, { requestId = crypto.randomUUID() } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "upm-m0-")));
  await fsp.chmod(root, 0o700);
  const paths = sut.statePaths(root);
  const store = new sut.EventStore(paths); await store.init();
  const core = new sut.PeerCore({
    targets: { "friday-main": { sessionId: THREAD, cwd: root, permissionMode: "bypass" } },
    store, address: "uds:/tmp/cc-socks/3390.sock", inboundSpool: new sut.InboundSpool(paths)
  });
  const onFrame = sut.frameObserver({ core, store });
  await store.reserveRequest({
    messageId: requestId, transportMessageId: requestId, threadId: THREAD, replyTo: null,
    kind: "diagnosis_probe", alias: "friday-main", requestHash: "0".repeat(64), subscriptionId: crypto.randomUUID(),
    targetAlias: "friday-main", targetSessionId: THREAD, targetCwd: root,
    targetSocketPath: "/tmp/cc-socks/47687.sock", targetPid: PEER.pid, targetProcStart: PEER.procStart,
    targetProcStartRendering: "utc0-c-squeezed", targetPermissionMode: "bypass", targetPermissionVerifiedBy: "kern_procargs2"
  });
  const rows = (type) => store.events.filter((e) => !type || e.type === type);
  const close = async () => { await store.close(); await fsp.rm(root, { recursive: true, force: true }); };
  return { root, store, core, onFrame, rows, close, requestId };
}

// What a Claude Code peer's SendMessage frame looks like on the daemon's receive socket.
export const frame = (body) => ({ type: "user", from: "uds:/tmp/cc-socks/3390.sock", message: { role: "user", content: body } });
