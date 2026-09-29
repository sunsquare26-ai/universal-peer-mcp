// The running shape: a daemon started from this tree in a private temp state directory (never the
// live one), asked over its control socket, then stopped with SIGTERM.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { controlCall } from "../../src/core/control.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { normalizeProcStart, processStart } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const roots = [];
async function stop(root) {
  const row = JSON.parse(await fsp.readFile(statePaths(root).daemon, "utf8"));
  for (let i = 0; i < 200; i += 1) {
    try { process.kill(row.pid, 0); } catch { return; }
    let live = false; try { live = normalizeProcStart(processStart(row.pid)) === normalizeProcStart(row.procStart); } catch { return; }
    if (!live) return;
    if (i === 0) process.kill(row.pid, "SIGTERM");
    await Bun.sleep(25);
  }
  throw new Error("daemon did not stop");
}
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });

test("daemon_started/daemon_stopping, ledger health in daemon_status, trace_attempt and trace_message", async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "upm-m1-daemon-"))); roots.push(root); await fsp.chmod(root, 0o700);
  process.env.UNIVERSAL_PEER_MAINTENANCE_DELAY_MS = "3600000";
  try {
    const status = await controlCall("daemon_status", {}, { root });
    expect(status.generationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(status.ledger).toMatchObject({ poisoned: false, lastError: null });
    expect(status.alerts.bridgeConfigured).toBe(false);
    const messageId = crypto.randomUUID(); const attemptId = crypto.randomUUID();
    await controlCall("trace_attempt", { phase: "intent", messageId, attemptId, path: "codex_queue", receiverThreadId: "01a0d249-5457-7f82-8602-b992529eac16" }, { root });
    await expect(controlCall("trace_attempt", { phase: "intent", messageId, attemptId, path: "codex_queue", receiverThreadId: "01a0d249-5457-7f82-8602-b992529eac16" }, { root })).rejects.toMatchObject({ code: "ATTEMPT_DUPLICATE" });
    await expect(controlCall("trace_attempt", { phase: "outcome", messageId, attemptId, outcome: "queued", body: "x" }, { root })).rejects.toMatchObject({ code: "INVALID_CONTROL_ARGUMENTS" });
    await controlCall("trace_attempt", { phase: "outcome", messageId, attemptId, outcome: "queued" }, { root });
    const trace = await controlCall("trace_message", { messageId }, { root });
    expect(trace.receivers[0].stages.map((s) => s.stage)).toEqual(["intended", "queued"]);
    const stats = await controlCall("ledger_daily_stats", { days: 1 }, { root });
    expect(Object.values(stats.days)[0]).toMatchObject({ daemonStarts: 1, attempts: { codex_queue: 1 }, attemptOutcomes: { queued: 1 } });
    expect(status.generationId).toBe((await controlCall("daemon_status", {}, { root })).generationId);
    // M4: disposing a body that is not the caller's own post is the operator's (interactive tty).
    await expect(controlCall("inbound_body_dispose", { sourceSeq: 1, disposition: "discard" }, { root })).rejects.toMatchObject({ code: "OPERATOR_REQUIRED" });
    await expect(controlCall("inbound_body_dispose", { sourceSeq: 1, disposition: "all" }, { root })).rejects.toMatchObject({ code: "INVALID_CONTROL_ARGUMENTS" });
  } finally { await stop(root); delete process.env.UNIVERSAL_PEER_MAINTENANCE_DELAY_MS; }
  const rows = (await fsp.readFile(statePaths(root).events, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(rows[0]).toMatchObject({ seq: 1, type: "daemon_started" });
  expect(rows.at(-1).type).toBe("daemon_stopping");
  expect(rows.at(-1).generationId).toBe(rows[0].generationId);
});
