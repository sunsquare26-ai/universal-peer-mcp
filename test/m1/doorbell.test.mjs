import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { queueArgv, sendDoorbell } from "../../src/core/doorbell.mjs";
import { recordAttempt } from "../../src/core/attempts.mjs";
import { checkQueueArgv, isDoorbell } from "../m0/contract.mjs";
import { openStore, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const THREAD = "01a0d249-5457-7f82-8602-b992529eac16";

async function fixture(stdoutLine = "Queued message 01a0ead6-9156-7000-8000-000000000000 for thread %T.") {
  const root = await tempRoot(); roots.push(root);
  const cli = path.join(root, "codex");
  await fsp.writeFile(cli, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))},JSON.stringify(process.argv.slice(2))+'\\n');console.log(${JSON.stringify(stdoutLine)}.replace('%T',process.argv[4]));`, { mode: 0o700 });
  const store = await openStore(root);
  const calls = async () => (await fsp.readFile(path.join(root, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { root, cli, store, calls, trace: (a) => recordAttempt(store, a) };
}

test("the argv is the M0 contract: two fixed values, a doorbell, a uuid thread", () => {
  const id = crypto.randomUUID();
  const argv = queueArgv(THREAD, id);
  expect(checkQueueArgv(argv)).toEqual({ ok: true, messageId: id });
  expect(isDoorbell(argv[4])).toBe(true);
  expect(() => queueArgv("codex-main", id)).toThrow();
  expect(() => queueArgv(THREAD, "not-a-uuid")).toThrow();
});

test("intent recorded -> queue -> outcome recorded with the returned id", async () => {
  const f = await fixture(); const messageId = crypto.randomUUID();
  const result = await sendDoorbell({ threadId: THREAD, messageId, alias: "codex-main", cliPath: f.cli, trace: f.trace });
  expect(result).toMatchObject({ state: "queued", returnedId: "01a0ead6-9156-7000-8000-000000000000" });
  expect(await f.calls()).toEqual([["queue", "--thread", THREAD, "--message", `PEER_DOORBELL v=1 message_id=${messageId}`]]);
  expect(f.store.events.map((e) => [e.type, e.outcome ?? e.path])).toEqual([["attempt_intent", "codex_queue"], ["attempt_outcome", "queued"]]);
});

test("if the intent cannot be recorded, nothing is sent", async () => {
  const f = await fixture();
  const result = await sendDoorbell({ threadId: THREAD, messageId: crypto.randomUUID(), cliPath: f.cli, trace: async () => { throw Object.assign(new Error("ledger dead"), { code: "EACCES" }); } });
  expect(result).toMatchObject({ state: "not_sent", reason: "trace_intent_failed" });
  expect(await f.calls()).toEqual([]);
});

test("if the outcome cannot be recorded, the result is unknown (and it was sent once)", async () => {
  const f = await fixture(); let n = 0;
  const result = await sendDoorbell({ threadId: THREAD, messageId: crypto.randomUUID(), cliPath: f.cli, trace: async (a) => { n += 1; if (a.phase === "outcome") throw new Error("gone"); return f.trace(a); } });
  expect(result).toMatchObject({ state: "unknown", reason: "trace_outcome_failed", outcome: "queued" });
  expect(await f.calls()).toHaveLength(1);
});

test("an unrecognised CLI answer is unknown, a CLI that cannot start is failed", async () => {
  const f = await fixture("something else");
  expect((await sendDoorbell({ threadId: THREAD, messageId: crypto.randomUUID(), cliPath: f.cli, trace: f.trace })).state).toBe("unknown");
  expect((await sendDoorbell({ threadId: THREAD, messageId: crypto.randomUUID(), cliPath: path.join(f.root, "missing"), trace: f.trace })).state).toBe("failed");
  expect(f.store.events.filter((e) => e.type === "attempt_outcome").map((e) => e.errorCode)).toEqual(["UNRECOGNISED_RESPONSE", "CLI_NOT_STARTED"]);
});

test("a thread name is refused before anything is recorded or sent", async () => {
  const f = await fixture();
  await expect(sendDoorbell({ threadId: "codex-main", messageId: crypto.randomUUID(), cliPath: f.cli, trace: f.trace })).rejects.toThrow();
  expect(f.store.events).toHaveLength(0); expect(await f.calls()).toEqual([]);
});
