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
  ["forged post accepted", "src/core/peer-core.mjs", "if (unauthenticated) { await quarantine(this.store, { reason: \"sender_unauthenticated\", content, header, who }); return null; }\n        const recipient = postRecipient(content);", "const recipient = postRecipient(content);", "test/m2/posts.test.mjs"],
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
  // M3
  ["queue takes a body", "src/extensions/codex-queue/index.mjs", "  if (!match) throw fail(\"INVALID_QUEUE_CALL\");\n  const argv = queueArgv(target.threadId, match[1]);", "  const argv = [\"queue\", \"--thread\", target.threadId, \"--message\", text];", "test/m0/doorbell-contract.test.mjs"],
  ["version mismatch ignored", "src/extensions/codex-queue/index.mjs", "if (!cliPath || (await this.cliVersion(cliPath).catch(() => null)) !== serverVersion) throw fail(\"VERSION_MISMATCH\");", "", "test/m3/codex-wake.test.mjs"],
  ["CLI not chosen by server release", "src/extensions/codex-queue/index.mjs", "cliPath = (await this.cliFor?.(serverVersion)) ?? null;", "cliPath = cliPath;", "test/m3/codex-wake.test.mjs"],
  ["only the configured socket is tried", "src/extensions/codex-queue/index.mjs", "const candidates = [target.socketPath, ...((await this.sockets?.()) ?? [])]", "const candidates = [target.socketPath]", "test/m3/codex-wake.test.mjs"],
  ["running turn gets a new turn", "src/extensions/codex-queue/index.mjs", "params.expectedTurnId = activeTurnId; method = \"turn/steer\";", "method = \"turn/start\";", "test/m3/codex-wake.test.mjs"],
  ["held reported as queued", "src/extensions/codex-queue/index.mjs", "mode: state === \"active\" ? \"held_behind_running_turn\" : \"queued\"", "mode: \"queued\"", "test/m0/held-queue.test.mjs"],
  ["target keys unchecked", "src/extensions/codex-queue/index.mjs", "    if (Object.keys(entry).some((key) => !TARGET_KEYS.has(key))) throw fail(\"TARGET_UNAVAILABLE\");\n", "", "test/m0/doorbell-contract.test.mjs"],
  // M3 product wiring
  ["ring without an intent first", "src/core/doorbell-service.mjs", "      if (first) {\n        try { await this.store.appendChecked(\"doorbell_intent\"", "      if (false) {\n        try { await this.store.appendChecked(\"doorbell_intent\"", "test/m3/doorbell-e2e.test.mjs"],
  ["shared current target", "src/core/doorbell-service.mjs", "const result = await this.wake.wake({ codexAlias: post.recipient, messageId: post.messageId, target: this.targetFor(post) });", "this.current = post; await null; const result = await this.wake.wake({ codexAlias: post.recipient, messageId: post.messageId, target: this.targetFor(this.current) });", "test/m3/doorbell-service.test.mjs"],
    ["wake not authorized", "src/extensions/codex-queue/index.mjs", "if (this.authorize) { const verdict", "if (false) { const verdict", "test/m3/doorbell-service.test.mjs"],
  ["retried more than once", "src/core/doorbell-service.mjs", "if (this.store.events.some((e) => e.type === \"doorbell_retry\" && sameUuid(e.messageId, post.messageId))) { report.exhausted", "if (false) { report.exhausted", "test/m3/doorbell-service.test.mjs"],
  ["alarm on every sweep", "src/core/doorbell-service.mjs", "      if (this.store.events.some((e) => e.type === \"doorbell_alerted\" && sameUuid(e.messageId, post.messageId))) continue;\n", "", "test/m3/doorbell-service.test.mjs"],
  ["sweep skips a missing intent", "src/core/doorbell-service.mjs", "if (!intent) { report.intentsCreated += 1; await this.ring(post.messageId, { first: true }); continue; }", "if (!intent) continue;", "test/m3/doorbell-service.test.mjs"],
  ["hook failure swallowed", "src/core/events.mjs", "try { this.onAppendFailed?.(event, error); } catch {}", "void error;", "test/m3/doorbell-service.test.mjs"],
  ["daemon never rings", "src/daemon.mjs", "store.onAppend = (row) => doorbell.onAppend(row);", "", "test/m3/doorbell-e2e.test.mjs"],
  ["Claude doorbell id not derived", "src/core/doorbell-service.mjs", "messageId: uuidv5(`doorbell:${post.messageId}`)", "messageId: crypto.randomUUID()", "test/m3/doorbell-service.test.mjs"],
  ["Claude doorbell ignores a moved alias", "src/core/doorbell-service.mjs", "if (!current || !sameUuid(current, bound)) return \"WAKE_TARGET_MISMATCH\";", "", "test/m3/doorbell-service.test.mjs"],
  ["no doorbell for Claude", "src/core/doorbell-service.mjs", "      if (post.recipientKind === \"claude\") return this.#ringClaude(post);\n", "", "test/m3/doorbell-e2e.test.mjs"],
  ["full-history thread read", "src/extensions/codex-queue/index.mjs", "const { thread } = await rpc.call(\"thread/read\", { threadId: target.threadId });", "const { thread } = await rpc.call(\"thread/read\", { threadId: target.threadId, includeTurns: true });", "test/m3/doorbell-e2e.test.mjs"],
  ["running turn id not looked up", "src/extensions/codex-queue/index.mjs", "if (newest?.status === \"inProgress\" && typeof newest.id === \"string\" && newest.id) activeTurnId = newest.id;", "void newest;", "test/m3/doorbell-e2e.test.mjs"],
  ["late queued doorbell not marked stale", "src/core/doorbell-service.mjs", "if (out?.state === \"held\" && !this.store.events.some", "if (false && !this.store.events.some", "test/m3/doorbell-e2e.test.mjs"],
  ["inbox hides already_processed", "src/daemon.mjs", ": done ? \"already_processed\" :", ": done ? \"pending\" :", "test/m3/doorbell-e2e.test.mjs"],
  ["fixed socket is a precondition again", "src/extensions/codex-queue/index.mjs", "if (!path.isAbsolute(entry.cliPath ?? \"\") || !path.isAbsolute(entry.socketPath ?? \"\")) throw fail(\"TARGET_UNAVAILABLE\");\n    return entry;", "if (!path.isAbsolute(entry.cliPath ?? \"\") || !path.isAbsolute(entry.socketPath ?? \"\")) throw fail(\"TARGET_UNAVAILABLE\");\n    await fsp.stat(entry.cliPath); await fsp.lstat(entry.socketPath);\n    return entry;", "test/m3/codex-wake.test.mjs"],
  ["dead candidate stops the search", "src/extensions/codex-queue/index.mjs", "catch { throw skip(); }\n      rpc.notify(\"initialized\");", "catch { throw fail(\"TARGET_UNAVAILABLE\"); }\n      rpc.notify(\"initialized\");", "test/m3/codex-wake.test.mjs"],
  ["foreign-mode socket used", "src/extensions/codex-queue/index.mjs", "if (!(await privateSocket(socketPath))) continue;", "", "test/m3/codex-wake.test.mjs"],
  ["trace calls queued delivered", "src/core/trace.mjs", "const TERMINAL = new Set([\"acked\", \"replied\", \"failed\"]);", "const TERMINAL = new Set([\"acked\", \"replied\", \"failed\", \"queued\"]);", "test/m1/trace.test.mjs"]
  ,
  // M4
  ["unaddressed post shown to every inbox", "src/core/posts.mjs", "e.seq > afterSeq && e.recipient === recipient && !processed", "e.seq > afterSeq && (e.recipient === recipient || e.recipient === \"*\") && !processed", "test/m4/units.test.mjs"],
  ["frame recipient ignored", "src/core/peer-core.mjs", "const recipient = postRecipient(content);", "const recipient = \"*\";", "test/m4/units.test.mjs"],
  ["read another session's inbox", "src/daemon.mjs", "if (args.recipient !== undefined && args.recipient !== who.alias) {", "if (false) {", "test/m4/multi-session.test.mjs"],
  ["ack another session's message", "src/daemon.mjs", "const row = store.events.find((e) => e.type === \"peer_post\" && typeof args.messageId === \"string\" && e.messageId === args.messageId.toLowerCase());", "const row = null;", "test/m4/multi-session.test.mjs"],
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
  ,
  // M4 review fixes
  ["new holder reads the old session's mail", "src/daemon.mjs", "afterSeq : 0, lineage: lineageOf(who) });", "afterSeq : 0, lineage: null });", "test/m4/review-fixes.test.mjs"],
  ["new holder acks the old session's mail", "src/daemon.mjs", "if (row && inbox(store.events, who.alias, { lineage: lineageOf(who) })", "if (false && row && inbox(store.events, who.alias, { lineage: lineageOf(who) })", "test/m4/review-fixes.test.mjs"],
  ["resume does not inherit", "src/core/posts.mjs", "{ lineage.add(`claude:${from}`); grew = true; }", "{ grew = false; }", "test/m4/review-fixes.test.mjs"],
  ["frame post unbound", "src/core/peer-core.mjs", "...(recipient !== \"*\" ? this.postRecipientFields?.(recipient) ?? {} : {})", "...{}", "test/m4/units.test.mjs"],
  ["diagnostics hand out every body", "src/daemon.mjs", "const open = method === \"peer_inbox\" || settings[LEGACY_BODIES].value;", "const open = true;", "test/m4/review-fixes.test.mjs"],
  ["compatibility window on by default", "src/core/settings.mjs", "value: !invalid && fromFile?.[LEGACY_BODIES] === true,", "value: !invalid && fromFile?.[LEGACY_BODIES] !== false,", "test/m4/review-fixes.test.mjs"],
  ["failed post leaves its body file", "src/core/posts.mjs", "    if (spooled.bodyFile) await discardSpooled(", "    if (false) await discardSpooled(", "test/m2/posts.test.mjs"],
  ["orphans deleted, not kept", "src/core/orphans.mjs", "await fsp.rename(file, path.join(target, name));", "await fsp.unlink(file);", "test/m4/review-fixes.test.mjs"],
  ["referenced bodies swept", "src/core/orphans.mjs", "if (!NAME.test(name) || referenced.has(`${INBOUND_DIRNAME}/${name}`)) continue;", "if (!NAME.test(name)) continue;", "test/m4/review-fixes.test.mjs"],
  ["nesting decided by the variable, not the host", "src/daemon.mjs", "codex.hostDepth < claude.depth", "codex.depth < claude.depth", "test/m4/registration.test.mjs"],
  ["Claude always wins a nesting", "src/daemon.mjs", "if (codex.proven && (!Number.isInteger(claude.depth) || codex.hostDepth < claude.depth)) return codexCaller(codex);", "", "test/m4/registration.test.mjs"],
  ["reply bodies exempt from the diagnostics rule", "src/daemon.mjs", "    if (typeof row?.bodyFile !== \"string\") return row;", "    if (typeof row?.bodyFile !== \"string\" || [\"peer_ack\", \"peer_reply\"].includes(row.type)) return row;", "test/m4/review-fixes.test.mjs"],
  ["answer goes to whoever holds the alias now", "src/daemon.mjs", "who: { ...who, ...binding, replyTo }", "who: { ...who, ...recipientFieldsOf(resolvePeer(to, { claude: targets, codex: codexPeers })), replyTo }", "test/m4/review-fixes.test.mjs"],
  ["anyone may answer a post", "src/daemon.mjs", "if (!readable) {", "if (false) {", "test/m4/review-fixes.test.mjs"],
  ["operator check skips sessions", "src/daemon.mjs", "if (who.kind !== null && who.kind !== undefined) return refuse(\"inside_session\");", "", "test/m4/review-fixes.test.mjs"],
  ["operator check skips the tty", "src/daemon.mjs", "if (!tty) return refuse(\"no_tty\");", "", "test/m4/review-fixes.test.mjs"],
  ["operator phrase not checked", "src/daemon.mjs", "if (args?.operator?.confirm !== operatorPhrase(target)) return refuse(\"confirm_mismatch\");", "", "test/m4/review-fixes.test.mjs"],
  ["dispose of another's body allowed", "src/daemon.mjs", "if (!(await ownsBody(caller, args.sourceSeq))) await requireOperator(", "if (false) await requireOperator(", "test/m4/review-fixes.test.mjs"],
  ["session removes another alias", "src/daemon.mjs", "if (!(who.authenticated && who.alias === args.alias)) await requireOperator(", "if (!who.authenticated && false) await requireOperator(", "test/m4/registration.test.mjs"],
  ["diagnostics keep the body file name", "src/daemon.mjs", "withheld.add(index); const { bodyFile, ...rest } = row; return rest;", "withheld.add(index); return row;", "test/m4/review-fixes.test.mjs"]
];

const root = process.cwd();
const results = [];
// Baseline: every test file a mutant is judged by must be green on the unmutated copy, or a red
// result would say nothing about the mutant (e.g. a missing node_modules failing an e2e stub).
{
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "upm-baseline-"));
  try {
    for (const dir of ["src", "test", "tools", "package.json", "node_modules"]) if (fs.existsSync(path.join(root, dir))) execFileSync("cp", ["-R", path.join(root, dir), copy]);
    for (const file of [...new Set(MUTANTS.map((m) => m[4]))]) {
      const run = spawnSync(process.execPath, ["test", file], { cwd: copy, encoding: "utf8", env: { ...process.env, UNIVERSAL_PEER_MAINTENANCE_DELAY_MS: "3600000" } });
      if (run.status !== 0) { console.log(`BASELINE RED ${file}`); process.exitCode = 1; }
    }
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
  if (process.exitCode === 1) process.exit(1);
}
for (const [name, file, find, replace, testFile] of MUTANTS) {
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "upm-mutant-"));
  try {
    for (const dir of ["src", "test", "tools", "package.json", "node_modules"]) if (fs.existsSync(path.join(root, dir))) execFileSync("cp", ["-R", path.join(root, dir), copy]);
    const target = path.join(copy, file); const text = fs.readFileSync(target, "utf8");
    const count = text.split(find).length - 1;
    if (count !== 1) { results.push({ name, status: `SETUP: pattern found ${count} times` }); continue; }
    fs.writeFileSync(target, text.replace(find, replace));
    const run = spawnSync(process.execPath, ["test", testFile], { cwd: copy, encoding: "utf8", env: { ...process.env, UNIVERSAL_PEER_MAINTENANCE_DELAY_MS: "3600000" } });
    results.push({ name, status: run.status === 0 ? "SURVIVED (test stayed green)" : "killed (red)" });
  } finally {
    // A red test can leave a daemon (detached) or a session double running from the copy: stop them.
    try { const ps = execFileSync("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" }); for (const line of ps.split("\n")) { const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (m && m[2].includes(copy) && Number(m[1]) !== process.pid) { try { process.kill(Number(m[1]), "SIGTERM"); } catch {} } } } catch {}
    fs.rmSync(copy, { recursive: true, force: true });
  }
}
for (const r of results) console.log(`${r.status.padEnd(28)} ${r.name}`);
process.exitCode = results.every((r) => r.status === "killed (red)") ? 0 : 1;
