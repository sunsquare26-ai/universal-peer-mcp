import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexWake, versionOf } from "../../src/extensions/codex-queue/index.mjs";
import { fakeConnect, queueTarget, writeCli, writeTargets, THREAD_UUID } from "../m0/codex-fixture.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
async function root() { const r = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "upm-m3-"))); roots.push(r); return r; }
const calls = async (r) => (await fs.readFile(path.join(r, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean);
const bell = (id) => `PEER_DOORBELL v=1 message_id=${id}`;

test("CLI 0.157.0 against app-server 0.159.0 (the live mismatch) is refused before anything is queued", async () => {
  const r = await root(); const cli = await writeCli(r, { version: "0.157.0" }); await writeTargets(r, queueTarget(r, cli));
  await expect(new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.159.0" }) }).wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  expect(await calls(r)).toEqual([]);
});

test("an app-server that does not state its release is refused", async () => {
  const r = await root(); const cli = await writeCli(r); await writeTargets(r, queueTarget(r, cli));
  const connect = () => ({ call: async (m) => (m === "thread/loaded/list" ? { data: [THREAD_UUID] } : {}), notify() {}, close() {} });   // lists the thread, states no release
  await expect(new CodexWake({ root: r, connect }).wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "VERSION_UNKNOWN" });
});

test("the release follows the server: a stale codexVersion pin does not stop the app-server path; a CLI of the server's release is found per call", async () => {
  const r = await root(); const old = await writeCli(r, { version: "0.159.0" });
  const net = await import("node:net"); const server = net.createServer(() => {}); await new Promise((ok) => server.listen(path.join(r, "s.sock"), ok)); await fs.chmod(path.join(r, "s.sock"), 0o600);
  await writeTargets(r, { transport: "existing-app-server", cliPath: old, threadId: THREAD_UUID, cwd: r, socketPath: path.join(r, "s.sock"), codexVersion: "0.159.0" });
  const newer = path.join(r, "rel", "0.159.1-aarch64-apple-darwin", "bin"); await fs.mkdir(newer, { recursive: true });
  const cli2 = await writeCli(newer, { version: "0.159.1" });
  const asked = [];
  try {
    const wake = new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.159.1" }), cliFor: (v) => { asked.push(v); return v === "0.159.1" ? cli2 : null; } });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).toMatchObject({ mode: "started" });
    expect(asked).toEqual(["0.159.1"]);
    // No CLI of that release anywhere: not sent.
    const none = new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.160.0" }), cliFor: () => null });
    await expect(none.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  } finally { server.close(); }
});

test("the thread is looked for on every offered socket; a server that does not hold it is skipped", async () => {
  const r = await root(); const cli = await writeCli(r, { version: "0.159.0" });
  const net = await import("node:net"); const s1 = net.createServer(() => {}); const s2 = net.createServer(() => {});
  await new Promise((ok) => s1.listen(path.join(r, "a.sock"), ok)); await new Promise((ok) => s2.listen(path.join(r, "b.sock"), ok));
  await fs.chmod(path.join(r, "a.sock"), 0o600); await fs.chmod(path.join(r, "b.sock"), 0o600);
  await writeTargets(r, { transport: "existing-app-server", cliPath: cli, threadId: THREAD_UUID, socketPath: path.join(r, "a.sock") });
  const seen = [];
  const connect = (sock) => { seen.push(path.basename(sock)); const holds = sock.endsWith("b.sock"); const base = fakeConnect({ root: r, version: "0.159.0" })(); return { ...base, call: async (m, p) => (m === "thread/loaded/list" ? { data: holds ? [THREAD_UUID] : [] } : base.call(m, p)) }; };
  try {
    const wake = new CodexWake({ root: r, connect, sockets: () => [path.join(r, "b.sock")] });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).toMatchObject({ mode: "started" });
    expect(seen).toEqual(["a.sock", "b.sock"]);
    const nowhere = new CodexWake({ root: r, connect: (sock) => { const base = fakeConnect({ root: r, version: "0.159.0" })(); return { ...base, call: async (m, p) => (m === "thread/loaded/list" ? { data: [] } : base.call(m, p)) }; }, sockets: () => [path.join(r, "b.sock")] });
    await expect(nowhere.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  } finally { s1.close(); s2.close(); }
});


async function appServerTarget(r) {
  const net = await import("node:net"); const server = net.createServer(() => {});
  await new Promise((ok) => server.listen(path.join(r, "s.sock"), ok)); await fs.chmod(path.join(r, "s.sock"), 0o600);
  const cli = await writeCli(r, { version: "0.159.0" });
  await writeTargets(r, { transport: "existing-app-server", cliPath: cli, threadId: THREAD_UUID, cwd: r, socketPath: path.join(r, "s.sock") });
  return server;
}

test("app-server, idle thread: turn/start with the doorbell as the only input", async () => {
  const r = await root(); const server = await appServerTarget(r); const log = []; const id = crypto.randomUUID();
  try {
    expect(await new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.159.0", calls: log }) }).wake({ codexAlias: "codex-main", messageId: id })).toMatchObject({ mode: "started", turnId: "turn-2" });
    const [, params] = log.find(([m]) => m === "turn/start");
    expect(params.input).toEqual([{ type: "text", text: bell(id), text_elements: [] }]);
    expect(params.clientUserMessageId).toBe(id);
  } finally { server.close(); }
});

test("app-server, running turn: turn/steer into that turn with the doorbell only", async () => {
  const r = await root(); const server = await appServerTarget(r); const log = []; const id = crypto.randomUUID();
  try {
    expect(await new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.159.0", state: "active", calls: log }) }).wake({ codexAlias: "codex-main", messageId: id })).toMatchObject({ mode: "steered", turnId: "turn-1" });
    const [, params] = log.find(([m]) => m === "turn/steer");
    expect(params).toMatchObject({ expectedTurnId: "turn-1", input: [{ type: "text", text: bell(id), text_elements: [] }] });
    expect(log.some(([m]) => m === "turn/start")).toBe(false);
  } finally { server.close(); }
});

test("the same messageId is answered from the reservation, never sent twice", async () => {
  const r = await root(); const cli = await writeCli(r); await writeTargets(r, queueTarget(r, cli));
  const wake = new CodexWake({ root: r, connect: fakeConnect({ root: r }) }); const id = crypto.randomUUID();
  await wake.wake({ codexAlias: "codex-main", messageId: id });
  expect((await wake.wake({ codexAlias: "codex-main", messageId: id })).replay).toBe(true);
  expect(await calls(r)).toHaveLength(1);
});

test("a queue target without the app-server socket is refused (held state would be invisible)", async () => {
  const r = await root(); const cli = await writeCli(r); const t = queueTarget(r, cli); delete t.socketPath; await writeTargets(r, t);
  await expect(new CodexWake({ root: r, connect: fakeConnect({ root: r }) }).wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  expect(await calls(r)).toEqual([]);
});

test("versionOf reads the release out of CLI and userAgent strings", () => {
  expect(versionOf("codex-cli 0.157.0")).toBe("0.157.0");
  expect(versionOf("codex_cli_rs/0.159.0 (Mac OS 27.0.0; arm64)")).toBe("0.159.0");
  expect(versionOf("nothing")).toBeNull();
});

test("an app-server target whose proxy CLI is another release is refused", async () => {
  const r = await root(); const server = await appServerTarget(r);
  try {
    await expect(new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.160.0" }) }).wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  } finally { server.close(); }
});

async function sockets(r, names, mode = 0o600) {
  const net = await import("node:net"); const servers = [];
  for (const n of names) { const s = net.createServer(() => {}); await new Promise((ok) => s.listen(path.join(r, n), ok)); await fs.chmod(path.join(r, n), mode); servers.push(s); }
  return () => servers.forEach((s) => s.close());
}
// A connection that answers like a server holding (or not holding) the thread, or is dead.
const serverAt = (r, holders, dead = []) => (sock) => {
  const name = path.basename(sock);
  if (dead.includes(name)) return { call: async () => { throw Object.assign(new Error("closed"), { code: "TARGET_UNAVAILABLE" }); }, notify() {}, close() {} };
  const base = fakeConnect({ root: r, version: "0.159.1" })();
  return { ...base, call: async (m, p) => (m === "thread/loaded/list" ? { data: holders.includes(name) ? [THREAD_UUID] : [] } : base.call(m, p)) };
};

test("after an update removed the configured socket: the new socket that lists the thread is found", async () => {
  const r = await root(); const cli = await writeCli(r, { version: "0.159.1" }); const close = await sockets(r, ["new.sock"]);
  await writeTargets(r, { transport: "existing-app-server", cliPath: cli, threadId: THREAD_UUID, socketPath: path.join(r, "gone.sock") });
  try {
    const wake = new CodexWake({ root: r, connect: serverAt(r, ["new.sock"]), sockets: () => [path.join(r, "new.sock")] });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).toMatchObject({ mode: "started" });
  } finally { close(); }
});

test("after an update removed the configured CLI: the server's release is found and used", async () => {
  const r = await root(); const close = await sockets(r, ["s.sock"]);
  const bin = path.join(r, "rel", "0.159.1-x", "bin"); await fs.mkdir(bin, { recursive: true }); const fresh = await writeCli(bin, { version: "0.159.1" });
  await writeTargets(r, { transport: "existing-app-server", cliPath: path.join(r, "releases-0.159.0-deleted", "codex"), threadId: THREAD_UUID, socketPath: path.join(r, "s.sock") });
  try {
    const wake = new CodexWake({ root: r, connect: serverAt(r, ["s.sock"]), cliFor: (v) => (v === "0.159.1" ? fresh : null) });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).toMatchObject({ mode: "started" });
  } finally { close(); }
});

test("a dead socket and a foreign-mode socket are skipped; the live one that lists the thread answers", async () => {
  const r = await root(); const cli = await writeCli(r, { version: "0.159.1" });
  const closeA = await sockets(r, ["dead.sock", "live.sock"]); const closeB = await sockets(r, ["open.sock"], 0o666);
  await writeTargets(r, { transport: "existing-app-server", cliPath: cli, threadId: THREAD_UUID, socketPath: path.join(r, "dead.sock") });
  const tried = [];
  const connect = (sock) => { tried.push(path.basename(sock)); return serverAt(r, ["live.sock", "open.sock"], ["dead.sock"])(sock); };
  try {
    const wake = new CodexWake({ root: r, connect, sockets: () => [path.join(r, "open.sock"), path.join(r, "live.sock")] });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).toMatchObject({ mode: "started" });
    expect(tried).toEqual(["dead.sock", "live.sock"]);               // open.sock (0666) never connected
  } finally { closeA(); closeB(); }
});

test("M5: a relinked doorbell is a new attempt — a success recorded for the old thread does not answer for it", async () => {
  const r = await root(); const server = await appServerTarget(r); const log = []; const id = crypto.randomUUID(); const relinked = crypto.randomUUID();
  try {
    const wake = new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.159.0", calls: log }) });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: id })).toMatchObject({ mode: "started", replay: false });
    expect(await wake.wake({ codexAlias: "codex-main", messageId: id })).toMatchObject({ replay: true });
    const again = await wake.wake({ codexAlias: "codex-main", messageId: id, attemptKey: relinked });
    expect(again).toMatchObject({ mode: "started", replay: false });
    const starts = log.filter(([m]) => m === "turn/start").map(([, p]) => p);
    expect(starts).toHaveLength(2);
    expect(starts[1].input).toEqual([{ type: "text", text: bell(id), text_elements: [] }]);   // still names the message
    expect(starts[1].clientUserMessageId).toBe(relinked);
  } finally { server.close(); }
});
