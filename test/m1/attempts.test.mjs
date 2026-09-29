import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { recordAttempt } from "../../src/core/attempts.mjs";
import { openStore, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const THREAD = "01a0d249-5457-7f82-8602-b992529eac16";
async function store() { const root = await tempRoot(); roots.push(root); return openStore(root); }
const ids = () => ({ messageId: crypto.randomUUID(), attemptId: crypto.randomUUID() });

test("intent then outcome are recorded with closed-shape fields only", async () => {
  const s = await store(); const id = ids();
  await recordAttempt(s, { phase: "intent", ...id, path: "codex_queue", receiverThreadId: THREAD, receiverAlias: "codex-main" });
  await recordAttempt(s, { phase: "outcome", ...id, outcome: "queued", returnedId: "01a0ead6-9156-7000-8000-000000000000" });
  expect(s.events.map((e) => e.type)).toEqual(["attempt_intent", "attempt_outcome"]);
  expect(s.events[0]).toMatchObject({ path: "codex_queue", receiverThreadId: THREAD });
  expect(s.events[0].phase).toBeUndefined();
});

test("free text, unknown fields, names for threads and bad enums are refused", async () => {
  const s = await store(); const id = ids();
  for (const bad of [
    { phase: "intent", ...id, path: "codex_queue", receiverThreadId: THREAD, body: "배포해 주세요" },
    { phase: "intent", ...id, path: "codex_queue", receiverThreadId: "codex-main" },
    { phase: "intent", ...id, path: "slack", receiverAlias: "codex-main" },
    { phase: "intent", ...id, path: "codex_queue" },
    { phase: "outcome", ...id, outcome: "delivered" },
    { phase: "outcome", ...id, outcome: "failed", errorCode: "no such thing: rm -rf" },
    { phase: "maybe", ...id }
  ]) await expect(recordAttempt(s, bad)).rejects.toMatchObject({ code: "INVALID_CONTROL_ARGUMENTS" });
  expect(s.events).toHaveLength(0);
});

test("an outcome without its intent, a duplicate intent and a second outcome are refused", async () => {
  const s = await store(); const id = ids();
  await expect(recordAttempt(s, { phase: "outcome", ...id, outcome: "queued" })).rejects.toMatchObject({ code: "ATTEMPT_UNKNOWN" });
  await recordAttempt(s, { phase: "intent", ...id, path: "codex_queue", receiverThreadId: THREAD });
  await expect(recordAttempt(s, { phase: "intent", ...id, path: "codex_queue", receiverThreadId: THREAD })).rejects.toMatchObject({ code: "ATTEMPT_DUPLICATE" });
  await expect(recordAttempt(s, { phase: "outcome", ...id, messageId: crypto.randomUUID(), outcome: "queued" })).rejects.toMatchObject({ code: "ATTEMPT_UNKNOWN" });
  await recordAttempt(s, { phase: "outcome", ...id, outcome: "unknown", errorCode: "CLI_TIMEOUT" });
  await expect(recordAttempt(s, { phase: "outcome", ...id, outcome: "queued" })).rejects.toMatchObject({ code: "ATTEMPT_DUPLICATE" });
});

test("two concurrent intents for one attempt: exactly one is recorded", async () => {
  const s = await store(); const id = ids();
  const args = { phase: "intent", ...id, path: "codex_queue", receiverThreadId: THREAD };
  const settled = await Promise.allSettled([recordAttempt(s, args), recordAttempt(s, args)]);
  expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(s.events).toHaveLength(1);
});
