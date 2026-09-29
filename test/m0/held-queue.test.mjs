// M0 reproduction of "Codex looks idle" = a queue held behind a running turn.
//
// Measured 2026-09-29 15:55 KST from the codex-main rollout (read-only, tools/m0/baseline.mjs):
// 307 queued user messages 09-24..09-29; 0 of 307 entered the turn that was running when they were
// queued; 176 waited for a turn end (p50 6.1 min, p95 39.8 min, max 55.3 min: 01:45:25Z ->
// 02:40:41Z on 09-29). Idle-target queue: p50 1.1 s.
//
// M1/M3 contract: while the target turn runs, the sender sees held_behind_running_turn, not
// "queued" or "delivered", and no ACK timer runs. The only adapter in git reports "queued".
import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexWake, codexWakeTools } from "../../src/extensions/codex-wake/index.mjs";

const THREAD = "01a0d249-5457-7f82-8602-b992529eac16";

async function withActiveThread(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "upm-m0-held-")));
  try {
    const cli = path.join(root, "codex-fixture");
    await fs.writeFile(cli, "#!/usr/bin/env node\nconsole.log('Queued message x for thread '+process.argv[4]+'.');", { mode: 0o700 });
    await fs.writeFile(path.join(root, "codex-targets.json"), JSON.stringify({ "codex-main": { transport: "cli-queue", cliPath: cli, threadId: THREAD, cwd: root } }), { mode: 0o600 });
    // The thread is mid-turn (what app-server thread/read reports as status.type "active").
    const connect = () => ({
      call: async (method) => method === "thread/loaded/list" ? { data: [THREAD] }
        : method === "thread/read" ? { thread: { id: THREAD, cwd: root, status: { type: "active" }, turns: [{ id: "t1", status: "inProgress" }] } } : {},
      notify() {}, close() {}
    });
    await run(new CodexWake({ root, connect }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("reproduce: a queue wake into a thread that is mid-turn reports plain 'queued'", () => withActiveThread(async (wake) => {
  const r = await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID(), body: "x" });
  expect(r.mode).toBe("queued");
}));

test.failing("M1/M3: a queue wake into a mid-turn thread reports held_behind_running_turn", () => withActiveThread(async (wake) => {
  const r = await wake.wake({ codexAlias: "codex-main", messageId: crypto.randomUUID(), body: "x" });
  expect(r.mode).toBe("held_behind_running_turn");
}));

test.failing("M1: the public result vocabulary has a held_behind_running_turn state", () => {
  const wake = codexWakeTools().find((t) => t.name === "codex_wake");
  expect(wake.outputSchema.properties.mode.enum).toContain("held_behind_running_turn");
});
