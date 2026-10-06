import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { createCodexResolver } from "../../src/core/codex-identity.mjs";
import { codexPeersPath, listPeers, loadCodexPeers, registerPeer, removePeer, resolvePeer } from "../../src/core/peer-directory.mjs";
import { loadTargets } from "../../src/core/target-config.mjs";
import { postRecipient } from "../../src/core/posts.mjs";
import { parseProcImage } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { uuidv7 } from "./harness.mjs";

const T = uuidv7();
// pid tree: 100 (cli) → 90 (shell, carries the thread) → 80 (codex host) → 1
function world({ images, parents = { 100: 90, 90: 80, 80: 1 }, starts = () => "Mon Sep 29 00:00:00 2026", rollout = () => true } = {}) {
  return createCodexResolver({ codexHome: "/nonexistent", imageReader: (pid) => { if (!images[pid]) throw new Error("gone"); return images[pid]; }, parentReader: (pid) => parents[pid], startReader: starts, rollout });
}
const shell = (env = {}) => ({ executable: "/bin/zsh", argv: ["/bin/zsh"], env });
const host = { executable: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", argv: [], env: {} };

test("codex identity: the thread the host put in the exec environment, under a codex host, with a rollout file", () => {
  expect(world({ images: { 100: shell({ CODEX_THREAD_ID: T }), 90: shell({ CODEX_THREAD_ID: T }), 80: host } })(100)).toMatchObject({ proven: true, threadId: T, carrierPid: 100, depth: 0 });
  // nearest carrier wins (a child that changed the variable is the one asked about), empty is absent
  const other = uuidv7();
  expect(world({ images: { 100: shell({ CODEX_THREAD_ID: "" }), 90: shell({ CODEX_THREAD_ID: other }), 80: host } })(100)).toMatchObject({ proven: true, threadId: other, carrierPid: 90 });
});

test("codex identity: every refusal is named", () => {
  expect(world({ images: { 100: shell(), 90: shell(), 80: host } })(100)).toEqual({ proven: false, reason: "no_codex_thread" });
  expect(world({ images: { 100: shell({ CODEX_THREAD_ID: T }), 90: shell(), 80: shell() } })(100)).toMatchObject({ proven: false, reason: "codex_host_not_ancestor" });
  expect(world({ images: { 100: shell({ CODEX_THREAD_ID: "codex-main" }), 90: shell(), 80: host } })(100)).toMatchObject({ proven: false, reason: "codex_thread_malformed" });
  expect(world({ images: { 100: shell({ CODEX_THREAD_ID: T }), 90: shell(), 80: host }, rollout: () => false })(100)).toMatchObject({ proven: false, reason: "codex_thread_unregistered" });
  let n = 0;
  expect(world({ images: { 100: shell({ CODEX_THREAD_ID: T }), 90: shell(), 80: host }, starts: () => `Mon Sep 29 00:00:0${n++} 2026` })(100)).toMatchObject({ proven: false, reason: "process_identity_changed" });
  // a host *below* the carrier does not count: the variable must be under the host
  expect(world({ images: { 100: host, 90: shell({ CODEX_THREAD_ID: T }), 80: shell() } })(100)).toMatchObject({ proven: false, reason: "codex_host_not_ancestor" });
});

test("parseProcImage reads the exec path, argv and only the asked-for environment names", () => {
  const parts = ["/x/codex", "\0\0\0\0\0\0\0", "/x/codex\0", "app-server\0", "HOME=/h\0", `CODEX_THREAD_ID=${T}\0`, "SECRET=zzz\0", "\0"];
  const text = Buffer.from(parts.join(""), "utf8"); const bytes = new Uint8Array(4 + text.length);
  new DataView(bytes.buffer).setInt32(0, 2, true); bytes.set(text, 4);
  expect(parseProcImage(bytes, ["CODEX_THREAD_ID"])).toEqual({ executable: "/x/codex", argv: ["/x/codex", "app-server"], env: { CODEX_THREAD_ID: T } });
});

test("a frame post names its recipient with to=<alias>; anything unclear is unaddressed", () => {
  const id = crypto.randomUUID();
  expect(postRecipient(`PEER_POST v=1 message_id=${id} to=codex-review\nbody`)).toBe("codex-review");
  expect(postRecipient(`PEER_POST v=1 message_id=${id}\nto=codex-review`)).toBe("*");
  expect(postRecipient(`PEER_POST v=1 message_id=${id} to=a1 to=b2`)).toBe("*");
  expect(postRecipient(`PEER_POST v=1 message_id=${id} to=Codex_Main`)).toBe("*");
});

async function dir() { const d = await fsp.realpath(await fsp.mkdtemp("/private/tmp/upm4u-")); await fsp.chmod(d, 0o700); return d; }

test("registration keeps targets.json readable by the M2 loader (no new fields) and codex peers in their own file", async () => {
  const root = await dir();
  try {
    const targetsFile = path.join(root, "targets.json"); const codexFile = codexPeersPath(root);
    const S = crypto.randomUUID();
    await registerPeer({ targetsFile, codexFile, alias: "test-claude", identity: { kind: "claude", sessionId: S, cwd: root, permissionMode: "bypass" } });
    await registerPeer({ targetsFile, codexFile, alias: "test-codex", identity: { kind: "codex", threadId: T } });
    const claude = await loadTargets(targetsFile); const codex = await loadCodexPeers(codexFile);
    expect(claude["test-claude"]).toMatchObject({ sessionId: S, permissionMode: "bypass" });
    expect(resolvePeer("test-codex", { claude, codex })).toEqual({ alias: "test-codex", kind: "codex", threadId: T });
    expect(resolvePeer("nobody", { claude, codex })).toBeNull();
    expect(listPeers({ claude, codex }).map((p) => p.alias)).toEqual(["test-claude", "test-codex"]);
    await fsp.writeFile(codexFile, JSON.stringify({ "x-y": { threadId: T, kind: "codex" } }), { mode: 0o600 });
    await expect(loadCodexPeers(codexFile)).rejects.toThrow(/unknown codex peer field/);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("concurrent registrations are serialized: none is lost, none doubles", async () => {
  const root = await dir();
  try {
    const targetsFile = path.join(root, "targets.json"); const codexFile = codexPeersPath(root);
    const threads = Array.from({ length: 12 }, () => uuidv7());
    const results = await Promise.allSettled([
      ...threads.map((threadId, i) => registerPeer({ targetsFile, codexFile, alias: `test-codex-${i}`, identity: { kind: "codex", threadId } })),
      registerPeer({ targetsFile, codexFile, alias: "test-codex-0", identity: { kind: "codex", threadId: uuidv7() } })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
    expect(results.at(-1).reason?.code).toBe("ALIAS_TAKEN");
    expect(Object.keys(await loadCodexPeers(codexFile))).toHaveLength(12);
    expect(await removePeer({ targetsFile, codexFile, alias: "test-codex-3" })).toEqual({ removed: true, alias: "test-codex-3", kind: "codex" });
    expect(Object.keys(await loadCodexPeers(codexFile))).toHaveLength(11);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

// A frame on the receive socket (a Claude session's SendMessage to the daemon) is routed by its
// `to=` token: into that alias's inbox only.
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { PeerCore, frameObserver } from "../../src/core/peer-core.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { inbox, unaddressed } from "../../src/core/posts.mjs";
import { openStore, tempRoot } from "../m1/helpers.mjs";

test("frame PEER_POST with to=<alias> lands in that inbox only; without it, in none", async () => {
  const root = await tempRoot();
  try {
    const store = await openStore(root); const MAIN = crypto.randomUUID();
    const peer = { pid: 500, procStart: "Mon Sep 28 03:18:28 2026" };
    const core = new PeerCore({ targets: { "main-claude": { sessionId: MAIN, cwd: root, permissionMode: "bypass" } }, store, address: "uds:/tmp/cc-socks/x.sock", inboundSpool: new InboundSpool(statePaths(root)), senderResolver: async (p) => ({ authenticated: true, alias: "main-claude", sessionId: MAIN, pid: p.pid, procStart: p.procStart }) });
    const onFrame = frameObserver({ core, store });
    const frame = (body) => ({ type: "user", from: "uds:/tmp/cc-socks/x.sock", message: { role: "user", content: body } });
    const a = crypto.randomUUID(); const b = crypto.randomUUID();
    await onFrame(frame(`PEER_POST v=1 message_id=${a} to=codex-review\n본문`), peer, {});
    await onFrame(frame(`PEER_POST v=1 message_id=${b}\n본문`), peer, {});
    expect(inbox(store.events, "codex-review").map((e) => e.messageId)).toEqual([a]);
    expect(inbox(store.events, "codex-main")).toEqual([]);
    expect(unaddressed(store.events).map((e) => e.messageId)).toEqual([b]);
    // bound to the session the alias names when the frame is accepted
    const bound = new PeerCore({ targets: {}, store, address: "uds:/tmp/cc-socks/x.sock", inboundSpool: new InboundSpool(statePaths(root)), senderResolver: async (p) => ({ authenticated: true, alias: "main-claude", sessionId: MAIN, pid: p.pid, procStart: p.procStart }), postRecipientFields: (alias) => (alias === "codex-review" ? { recipientKind: "codex", recipientThreadId: T } : {}) });
    const c = crypto.randomUUID();
    await frameObserver({ core: bound, store })(frame(`PEER_POST v=1 message_id=${c} to=codex-review\n본문`), peer, {});
    expect(store.events.find((e) => e.type === "peer_post" && e.messageId === c)).toMatchObject({ recipient: "codex-review", recipientThreadId: T });
    expect(inbox(store.events, "codex-review", { lineage: new Set([`codex:${T}`]) }).map((e) => e.messageId)).toEqual([c]);
    await store.close();
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
