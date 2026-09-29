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
  const connect = () => ({ call: async (m) => (m === "initialize" ? {} : {}), notify() {}, close() {} });
  await expect(new CodexWake({ root: r, connect }).wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "VERSION_UNKNOWN" });
});

test("a pinned codexVersion that the app-server does not match is refused", async () => {
  const r = await root(); const cli = await writeCli(r, { version: "0.159.0" }); await writeTargets(r, { transport: "existing-app-server", cliPath: cli, threadId: THREAD_UUID, cwd: r, socketPath: path.join(r, "s.sock"), codexVersion: "0.158.0" });
  const s = await import("node:net"); const server = s.createServer(() => {}); await new Promise((ok) => server.listen(path.join(r, "s.sock"), ok)); await fs.chmod(path.join(r, "s.sock"), 0o600);
  try {
    await expect(new CodexWake({ root: r, connect: fakeConnect({ root: r, version: "0.159.0" }) }).wake({ codexAlias: "codex-main", messageId: crypto.randomUUID() })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  } finally { server.close(); }
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
