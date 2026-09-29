// M3 live-probe finding, reproduced with M4's session doubles: a Codex thread whose host runs inside a
// Claude session's process tree (the probe's test Codex was started under claude-main) registered as
// that Claude session and took over its alias. The nearer proof must name the caller.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { lane } from "../m4/harness.mjs";
import { processStart } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const lanes = [];
afterEach(async () => { for (const L of lanes.splice(0)) await L.stop(); });

test("a Codex thread started under a Claude session is the Codex thread, not the Claude session", async () => {
  const L = await lane(); lanes.push(L); await L.owner(["peers"]);
  // This test process plays the Claude session that the Codex host runs under.
  const row = { pid: process.pid, sessionId: crypto.randomUUID(), cwd: L.work, procStart: processStart(process.pid), version: "test", peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"], name: "outer-claude", status: "busy" };
  await fsp.writeFile(path.join(L.sessions, `${process.pid}.json`), JSON.stringify(row), { mode: 0o600 });
  const x = await L.codex();
  const r = await x.run(["register", "--alias", "test-codex-1"]);
  expect(r.json).toMatchObject({ state: "registered", alias: "test-codex-1", kind: "codex", threadId: x.threadId });
  expect((await x.run(["whoami"])).json).toEqual({ authenticated: true, alias: "test-codex-1", kind: "codex" });
  await fsp.rm(path.join(L.sessions, `${process.pid}.json`), { force: true });
});
