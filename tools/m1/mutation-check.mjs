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
  ["expired reads as unreadable", "src/core/inbound-hydrate.mjs", "if (expired.has(events[index].bodyFile))", "if (false)", "test/m1/retention.test.mjs"],
  ["doorbell sends without intent", "src/core/doorbell.mjs", "return { state: \"not_sent\", reason: \"trace_intent_failed\", code: typeof error?.code === \"string\" ? error.code : null, attemptId };", "void error;", "test/m1/doorbell.test.mjs"],
  ["attempt takes free text", "src/core/attempts.mjs", "for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalid(`unsupported field ${key}`);", "", "test/m1/attempts.test.mjs"],
  ["alert not deduped", "src/core/alerts.mjs", "if (this.keys.has(key)) return { raised: false, duplicate: true };", "", "test/m1/alerts.test.mjs"],
  ["no daemon_started row", "src/daemon.mjs", "await store.append(\"daemon_started\", { generationId, daemonPid: process.pid, daemonProcStart: selfProcStart, buildId: BUILD_ID, settings: settingsStatus(settings) });", "", "test/m1/daemon-observation.test.mjs"],
  ["trace leaks the body", "src/core/trace.mjs", "for (const key of [\"reason\", \"errorCode\",", "for (const key of [\"body\", \"bodyFile\", \"reason\", \"errorCode\",", "test/m1/trace.test.mjs"],
  ["bridge accepts any key", "tools/alert-bridge/air-notify.sh", "[[ \"$key\" =~ ^[a-z0-9_:.-]{1,160}$ ]] || { echo \"bad key\" >&2; exit 64; }", "", "test/m1/air-notify.test.mjs"],
  ["bridge notifies before logging", "tools/alert-bridge/air-notify.sh", "printf '%s alert kind=%s key=%s code=%s\\n' \"$now\" \"$kind\" \"$key\" \"$code\" >> \"$log\" || exit 1", "true", "test/m1/air-notify.test.mjs"],
  ["bridge never falls back", "tools/alert-bridge/air-notify.sh", "if [ \"$rc\" -ne 255 ]; then", "if false; then", "test/m1/air-notify.test.mjs"],
  ["bridge retries a sleeping Air", "tools/alert-bridge/air-notify.sh", "if [ \"$rc\" -ne 255 ]; then", "if true; then", "test/m1/air-notify.test.mjs"],
  ["expire ignores digest", "src/core/retention.mjs", "if (digest !== row.bodySha256) return", "if (false) return", "test/m1/retention.test.mjs"],
  ["expire deletes when ledger refuses", "src/core/retention.mjs", "} catch { return \"ledger_append_failed\"; }\n  await fsp.unlink(file);", "} catch {}\n  await fsp.unlink(file);", "test/m1/retention.test.mjs"],
  ["retention ignores conclusion", "src/core/retention.mjs", "if (!isConcluded(row, state)) {", "if (false) {", "test/m1/retention.test.mjs"],
  ["unprocessed alarmed every run", "src/core/retention.mjs", "if (state.exceeded.has(row.seq)) continue;", "", "test/m1/retention.test.mjs"],
  ["expiry on by default", "src/core/retention.mjs", "export const DEFAULT_BODY_RETENTION_DAYS = 0;", "export const DEFAULT_BODY_RETENTION_DAYS = 30;", "test/m1/retention.test.mjs"],
  ["header keeps unknown tokens", "src/core/protocol-header.mjs", "if (!field || field in header) continue;", "if (!field) { header[token.slice(0, at)] = token.slice(at + 1); continue; } if (field in header) continue;", "test/m1/protocol-header.test.mjs"],
  ["header keeps a non-protocol line", "src/core/protocol-header.mjs", "if (!HEADER_VERBS.includes(verb)) return null;", "if (!HEADER_VERBS.includes(verb)) return { verb: line };", "test/m1/protocol-header.test.mjs"],
  ["spool stores the first line", "src/core/inbound-spool.mjs", "const header = protocolHeader(body); return header === null ? {} : { header };", "return { firstLine: body.split(\"\\n\")[0] };", "test/m1/retention.test.mjs"],
  // M2
  ["forged post accepted", "src/core/peer-core.mjs", "if (unauthenticated) { await quarantine(this.store, { reason: \"sender_unauthenticated\", content, header, who }); return null; }\n        await acceptPost(", "await acceptPost(", "test/m2/posts.test.mjs"],
  ["other session allowlisted", "src/core/sender-auth.mjs", "if (!alias) return { authenticated: false, reason: \"session_not_allowlisted\", pid, sessionId: row.sessionId, procStart: row.procStart, cwd: typeof row.cwd === \"string\" ? row.cwd : null, depth };", "if (!alias) return { authenticated: true, alias: \"friday-main\", sessionId: row.sessionId, pid, procStart: row.procStart, depth };", "test/m2/sender-auth.test.mjs"],
  ["recycled pid accepted", "src/core/sender-auth.mjs", "if (live === null || live !== normalizeProcStart(row.procStart)) return", "if (false) return", "test/m2/sender-auth.test.mjs"],
  ["concurrent duplicate becomes a second post", "src/core/posts.mjs", "(events) => (firstPost(events, messageId) ? refuse(\"POST_RACE\", \"lost the race\") : null)", "() => null", "test/m2/posts.test.mjs"],
  ["processed twice", "src/core/posts.mjs", "(events.some((e) => e.type === \"peer_post_processed\" && sameUuid(e.messageId, messageId)) ? refuse(\"ALREADY_PROCESSED\", \"already processed\") : null)", "null", "test/m2/posts.test.mjs"],
  ["self-referencing ACK accepted", "src/core/peer-core.mjs", "if (selfReferencing(marker)) return", "if (false) return", "test/m0/reply-framing.test.mjs"],
  ["link to a missing request", "src/core/posts.mjs", "if (!request) throw refuse(\"LINK_REFUSED\", \"no request with that id\");", "if (!request) return { linked: false };", "test/m2/posts.test.mjs"],
  ["group ids random", "src/core/posts.mjs", "return uuidv5(`${groupId}:${alias}`);", "return crypto.randomUUID();", "test/m2/posts.test.mjs"],
  ["daemon row is a successor", "src/adapters/claude-native-v1/registry.mjs", "function isSelfRow(row, options = {}) { return row?.name === SELF_ROW_NAME || row?.pid === (options.selfPid ?? process.pid); }", "function isSelfRow() { return false; }", "test/m2/rebind-gaps.test.mjs"],
  ["fork inherited", "src/core/session-rebind.mjs", "  if (argv.some((token) => FORK_FLAGS.includes(token))) return false;\n", "", "test/m2/rebind-gaps.test.mjs"],
  ["same process inherited", "src/adapters/claude-native-v1/registry.mjs", "if (prior && Number.isInteger(prior.pid) && chosen.row.pid === prior.pid", "if (false && prior", "test/m2/rebind-gaps.test.mjs"],
  ["chain reported as no proof", "src/adapters/claude-native-v1/registry.mjs", "    if (chained) throw", "    if (false) throw", "test/m2/rebind-gaps.test.mjs"],
  ["env beats file", "src/core/settings.mjs", "    if (fromFile && fromFile[key] !== undefined) { out[key] = { value: fromFile[key], source: \"file\" }; continue; }\n", "", "test/m2/settings.test.mjs"],
  ["broken file falls back to env", "src/core/settings.mjs", "    if (invalid) { out[key] = { value: null, source: \"config_invalid\" }; continue; }\n", "", "test/m2/settings.test.mjs"],
  ["refused frame keeps no digest", "src/core/peer-core.mjs", "if (typeof content === \"string\" && content.length > 0) digest = bodyDigest(content);", "void content;", "test/m0/reply-framing.test.mjs"],
  ["trace calls queued delivered", "src/core/trace.mjs", "const TERMINAL = new Set([\"acked\", \"replied\", \"failed\"]);", "const TERMINAL = new Set([\"acked\", \"replied\", \"failed\", \"queued\"]);", "test/m1/trace.test.mjs"]
  ,
  // M4
  ["unaddressed post shown to every inbox", "src/core/posts.mjs", "e.seq > afterSeq && e.recipient === recipient && !processed", "e.seq > afterSeq && (e.recipient === recipient || e.recipient === \"*\") && !processed", "test/m4/units.test.mjs"],
  ["frame recipient ignored", "src/core/peer-core.mjs", "recipient: postRecipient(content), ", "", "test/m4/units.test.mjs"],
  ["read another session's inbox", "src/daemon.mjs", "if (args.recipient !== undefined && args.recipient !== who.alias) {", "if (false) {", "test/m4/multi-session.test.mjs"],
  ["ack another session's message", "src/daemon.mjs", "if (row && row.recipient !== who.alias) throw", "if (false) throw", "test/m4/multi-session.test.mjs"],
  ["unknown recipient half-sent", "src/daemon.mjs", "if (unknown.length) {", "if (false) {", "test/m4/multi-session.test.mjs"],
  ["one session gets a group twice", "src/daemon.mjs", "if (deliveredTo.has(key)) {", "if (false) {", "test/m4/multi-session.test.mjs"],
  ["unauthenticated reader served", "src/daemon.mjs", "if (!who.authenticated) throw Object.assign(new Error(`this process is not a registered peer session (${who.reason}); register first", "if (false) throw Object.assign(new Error(`this process is not a registered peer session (${who.reason}); register first", "test/m4/multi-session.test.mjs"],
  ["codex thread without a codex host", "src/core/codex-identity.mjs", "if (!hostSeen) return", "if (false) return", "test/m4/units.test.mjs"],
  ["codex thread without a rollout", "src/core/codex-identity.mjs", "if (!rollout(codexHome, threadId)) return", "if (false) return", "test/m4/registration.test.mjs"],
  ["codex recycled pid accepted", "src/core/codex-identity.mjs", "if (before === null || before !== after) return", "if (false) return", "test/m4/units.test.mjs"],
  ["alias silently taken over", "src/core/peer-directory.mjs", "if (!replace && holder) throw", "if (false) throw", "test/m4/registration.test.mjs"],
  ["one session under two aliases", "src/core/peer-directory.mjs", "if (!replace && others.length) throw", "if (false) throw", "test/m4/registration.test.mjs"],
  ["registration writes a field old builds refuse", "src/core/peer-directory.mjs", "nextTargets[alias] = { sessionId: id, cwd: identity.cwd, permissionMode: identity.permissionMode };", "nextTargets[alias] = { sessionId: id, cwd: identity.cwd, permissionMode: identity.permissionMode, kind: \"claude\" };", "test/m4/registration.test.mjs"],
  ["registrations race", "src/core/peer-directory.mjs", "  return serializeByFile(targetsFile, async () => {\n    const targets = await readRaw(targetsFile); const codex = await readRaw(codexFile);\n    const id =", "  return (async () => {\n    const targets = await readRaw(targetsFile); const codex = await readRaw(codexFile);\n    const id =", "test/m4/units.test.mjs"],
  ["/clear inherited on read", "src/daemon.mjs", "if (last && (last.senderSessionPid ?? last.sessionPid) === claude.pid", "if (false && last", "test/m4/restart-rebind.test.mjs"],
  ["fork inherited on read", "src/daemon.mjs", "if (claims.fork) return fail(", "if (false) return fail(", "test/m4/restart-rebind.test.mjs"],
  ["restarted session not rebound", "src/daemon.mjs", "    const rebound = await rebindCaller(claude);\n", "    const rebound = null;\n", "test/m4/restart-rebind.test.mjs"],
  ["codex caller never proven", "src/daemon.mjs", "  const codex = resolveCodex(caller?.pid);\n", "  const codex = { proven: false, reason: \"no_codex_thread\" };\n", "test/m4/registration.test.mjs"]
];

const root = process.cwd();
const results = [];
for (const [name, file, find, replace, testFile] of MUTANTS) {
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "upm-mutant-"));
  try {
    for (const dir of ["src", "test", "tools", "package.json"]) execFileSync("cp", ["-R", path.join(root, dir), copy]);
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
