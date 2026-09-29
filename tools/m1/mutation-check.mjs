#!/usr/bin/env bun
// Break the M1 implementation one way at a time, in a throw-away copy of the tree, and require the
// named test file to go red. A mutation whose test stays green means that test does not hold the
// behaviour it claims to. Run from the repo root: `bun tools/m1/mutation-check.mjs`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MUTANTS = [
  ["health hides poisoned", "src/core/events.mjs", "poisoned: this.poisoned !== null,", "poisoned: false,", "test/m1/ledger-health.test.mjs"],
  ["no alarm on poison", "src/core/events.mjs", "if (first && typeof this.onPoisoned === \"function\")", "if (false)", "test/m1/ledger-health.test.mjs"],
  ["rebind counted twice (legacy)", "src/core/trace.mjs", "{ paired.add(row.seq); used.add(prior.seq); break; }", "{ break; }", "test/m1/trace.test.mjs"],
  ["rebind counted twice (no-proof link)", "src/core/session-rebind.mjs", "if (row && error && typeof error === \"object\") error.rebindFailedSeq = row.seq;", "", "test/m1/rebind-once.test.mjs"],
  ["rebind counted twice (switched-off link)", "src/core/session-rebind.mjs", "function linked(row) { return Number.isInteger(row?.seq) ? { rebindFailedSeq: row.seq } : {}; }", "function linked(row) { return {}; }", "test/m1/rebind-once.test.mjs"],
  ["ack counted per row", "src/core/trace.mjs", "case \"peer_ack\": if (id && !seenAck.has(id))", "case \"peer_ack\": if (id)", "test/m1/trace.test.mjs"],
  ["today archived while open", "src/core/archive.mjs", "if (!day || day >= today) continue;", "if (!day || day > today) continue;", "test/m1/archive.test.mjs"],
  ["expire ignores digest", "src/core/retention.mjs", "if (digest !== row.bodySha256) {", "if (false) {", "test/m1/retention.test.mjs"],
  ["expire deletes when ledger refuses", "src/core/retention.mjs", "} catch { result.stoppedBy = \"ledger_append_failed\"; return result; }\n    await fsp.unlink(file);", "} catch { result.stoppedBy = \"ledger_append_failed\"; }\n    await fsp.unlink(file);", "test/m1/retention.test.mjs"],
  ["expired reads as unreadable", "src/core/inbound-hydrate.mjs", "if (expired.has(events[index].bodyFile))", "if (false)", "test/m1/retention.test.mjs"],
  ["doorbell sends without intent", "src/core/doorbell.mjs", "return { state: \"not_sent\", reason: \"trace_intent_failed\", code: typeof error?.code === \"string\" ? error.code : null, attemptId };", "void error;", "test/m1/doorbell.test.mjs"],
  ["phone not masked", "src/core/mask.mjs", ".replace(PHONE, \"[phone]\")", "", "test/m1/mask.test.mjs"],
  ["attempt takes free text", "src/core/attempts.mjs", "for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalid(`unsupported field ${key}`);", "", "test/m1/attempts.test.mjs"],
  ["alert not deduped", "src/core/alerts.mjs", "if (this.keys.has(key)) return { raised: false, duplicate: true };", "", "test/m1/alerts.test.mjs"],
  ["no daemon_started row", "src/daemon.mjs", "await store.append(\"daemon_started\", { generationId, daemonPid: process.pid, daemonProcStart: selfProcStart, buildId: BUILD_ID });", "", "test/m1/daemon-observation.test.mjs"],
  ["trace leaks the body", "src/core/trace.mjs", "for (const key of [\"reason\", \"errorCode\",", "for (const key of [\"body\", \"bodyFile\", \"reason\", \"errorCode\",", "test/m1/trace.test.mjs"],
  ["trace calls queued delivered", "src/core/trace.mjs", "const TERMINAL = new Set([\"acked\", \"replied\", \"failed\"]);", "const TERMINAL = new Set([\"acked\", \"replied\", \"failed\", \"queued\"]);", "test/m1/trace.test.mjs"]
];

const root = process.cwd();
const results = [];
for (const [name, file, find, replace, testFile] of MUTANTS) {
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "upm-mutant-"));
  try {
    for (const dir of ["src", "test", "package.json"]) execFileSync("cp", ["-R", path.join(root, dir), copy]);
    const target = path.join(copy, file); const text = fs.readFileSync(target, "utf8");
    const count = text.split(find).length - 1;
    if (count !== 1) { results.push({ name, status: `SETUP: pattern found ${count} times` }); continue; }
    fs.writeFileSync(target, text.replace(find, replace));
    const run = spawnSync(process.execPath, ["test", testFile], { cwd: copy, encoding: "utf8", env: { ...process.env, UNIVERSAL_PEER_MAINTENANCE_DELAY_MS: "3600000" } });
    results.push({ name, status: run.status === 0 ? "SURVIVED (test stayed green)" : "killed (red)" });
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
}
for (const r of results) console.log(`${r.status.padEnd(28)} ${r.name}`);
process.exitCode = results.every((r) => r.status === "killed (red)") ? 0 : 1;
