#!/usr/bin/env bun
import { SHUTDOWN_WAIT_MILLIS, shutdownResources } from "./core/shutdown.mjs";
import crypto from "node:crypto";
import { targetDiagnostic } from "./core/target-diagnostics.mjs";
import { observeBuild } from "./core/build-identity.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import { EventStore } from "./core/events.mjs";
import { hydrateInboundBodies } from "./core/inbound-hydrate.mjs";
const LOOKUP_BODY_MAX_BYTES = 256 * 1024;
import { InboundSpool } from "./core/inbound-spool.mjs";
import { frameObserver, milestoneSendOptions, PeerCore } from "./core/peer-core.mjs";
import { TargetTableWatch } from "./core/target-table.mjs";
import { createSessionRebinder } from "./core/session-rebind.mjs";
import { atomicPrivateWrite, ensurePrivateDirectory, statePaths } from "./core/state-paths.mjs";
import { localPeerPid } from "./adapters/claude-native-v1/darwin-peerpid.mjs";
import { normalizeProcStart, processStart, processUid } from "./adapters/claude-native-v1/darwin-procargs.mjs";
import { resolveSuccessor } from "./adapters/claude-native-v1/registry.mjs";
import { startReceiver, receiverOptionsForState } from "./adapters/claude-native-v1/receiver.mjs";
import { directSend } from "./adapters/claude-native-v1/transport.mjs";
import { MilestoneExtension } from "./extensions/milestone/index.mjs";
import { CodeReviewExtension, publicLedgerEvent } from "./extensions/code-review/index.mjs";
import path from "node:path";
import { BUILD_ID } from "./core/build-identity.mjs";
import { AlertSink } from "./core/alerts.mjs";
import { recordAttempt } from "./core/attempts.mjs";
import { dailyStats, traceMessage } from "./core/trace.mjs";
import { disposeInboundBody, expiredBodyFiles } from "./core/retention.mjs";
import { maintenanceConfig, MAINTENANCE_INTERVAL_MS, runMaintenance } from "./core/maintenance.mjs";
import { dayOf } from "./core/days.mjs";
import { loadSettings, settingsStatus } from "./core/settings.mjs";
import { DoorbellService } from "./core/doorbell-service.mjs";
import { ReceiptService } from "./core/receipts.mjs";
import { overview } from "./core/overview.mjs";
import { createSenderResolver } from "./core/sender-auth.mjs";
import { uuidv5 } from "./core/posts.mjs";
import { acceptPost, ackInbox, bodyDigest, heldPosts, inbox, linkUnmatched, postBindings, recipientMessageId, relinkPost, sessionLineage } from "./core/posts.mjs";
import { LEGACY_BODIES, LEGACY_BODIES_WARNING } from "./core/settings.mjs";
import { createCodexResolver } from "./core/codex-identity.mjs";
import { sweepOrphanBodies } from "./core/orphans.mjs";
import { controllingTty, OPERATOR_LABEL, operatorPhrase } from "./core/operator.mjs";
import { aliasOfCodexThread, codexPeersDigest, codexPeersPath, identityKey, listPeers, loadCodexPeers, registerPeer, removePeer, resolvePeer } from "./core/peer-directory.mjs";
import { processParent, provePermissionMode, readProcessArgv } from "./adapters/claude-native-v1/darwin-procargs.mjs";
import { readRebindState } from "./core/rebind-sidecar.mjs";
import { DEFAULT_SESSIONS_DIR, sessionLiveness } from "./adapters/claude-native-v1/registry.mjs";
import { sameUuid } from "./core/limits.mjs";

const buildObservation = observeBuild();
const paths = statePaths(); const admin = process.env.CLAUDE_PEER_MCP_ADMIN === "1";
const enabledExtensions = parseExtensions(process.env.CLAUDE_PEER_MCP_EXTENSIONS);
// Read once, before anything can connect, so that the answer to "which daemon is this" exists
// from the first accepted byte rather than from the moment the identity record is assembled.
const selfProcStart = processStart();
await ensurePrivateDirectory(paths.root);
const daemonLock = await fsp.open(paths.daemonLock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
await daemonLock.writeFile(`${JSON.stringify({ pid: process.pid, procStart: selfProcStart })}\n`); await daemonLock.sync();
// A table that is not there is a table with nothing in it, and this daemon comes up on it: that
// is a fresh install and it is the order every install runs in. Anything else is a table that
// could not be read, and the two are not the same absence.
//
// They were the same absence here, by `error.code` alone. `loadTargets` resolves each target's
// cwd with `realpath`, which throws ENOENT naming *that directory* — so one target pointing at a
// folder that had been moved emptied the whole table, including rows whose sessions were running.
// `Object.keys(targets).length > 0` was then false, so `startReceiver` was never called: no
// receiving socket, no session registry entry, nothing inbound could arrive at all. And
// `daemon_status` answered `running: true, targetCount: 0`, which is what a clean install answers.
// It is not a rare shape: README says `cp targets.example.json`, and the example's cwd is a
// placeholder.
//
// So only an ENOENT naming the table itself is an absence — the same reading `src/server.mjs`
// makes of the same file and the rule `src/doctor.mjs` states. Every other way a table can be
// invalid already ends this process before it can serve anything, and a missing cwd now ends it
// with them, naming the directory. That leaves a `daemon.lock` behind for a pid that is gone,
// which `reclaimDeadDaemon` clears on the next start.
//
// The absence is now decided by looking at the table file itself rather than by reading a code off
// an exception (src/core/target-table.mjs), which is the same rule stated more directly: a cwd that
// is gone throws here, naming the directory, exactly as every other invalid table does.
const tableWatch = new TargetTableWatch({ file: paths.targets });
// M4: Claude session rows are read from ~/.claude/sessions unless the daemon is started with
// UNIVERSAL_PEER_CLAUDE_SESSIONS_DIR (test daemons only: it keeps a test lane off the live registry).
const claudeSessionsDir = typeof process.env.UNIVERSAL_PEER_CLAUDE_SESSIONS_DIR === "string" && process.env.UNIVERSAL_PEER_CLAUDE_SESSIONS_DIR !== "" ? path.resolve(process.env.UNIVERSAL_PEER_CLAUDE_SESSIONS_DIR) : undefined;
// M4: Codex peers live beside the target table in their own file (src/core/peer-directory.mjs).
const codexPeersFile = codexPeersPath(paths.root);
const codexWatch = new TargetTableWatch({ file: codexPeersFile, load: loadCodexPeers, digest: codexPeersDigest });
let codexPeers = {};
const startupTable = await tableWatch.read();
if (startupTable.unreadable) throw startupTable.unreadable;
let targets = startupTable.table;
// Not the one reading this daemon will ever have — the reading it has now. It is answered with
// `daemon_status` and enforced by `assertChecked`, and it is refreshed from disk before every
// request, so a table an operator repaired is in force on the next call instead of on the next
// restart. What the check means is unchanged: a command still executes only against the table its
// caller checked it against.
let targetsDigest = startupTable.digest;
{ const reading = await codexWatch.read(); if (!reading.unreadable) codexPeers = reading.table; }
// M1 observation. One id per daemon process, written as the first row this process appends, so a
// timeline read days later can say which daemon generation handled each part of it and where a
// restart fell. The alarm sink is local and durable (src/core/alerts.mjs); the ledger reports its
// own death through it, once.
const generationId = crypto.randomUUID();
// Settings come from <state>/config.json first, then the environment (src/core/settings.mjs): the
// environment is whichever serve started this daemon, which is not a place settings can live.
const settings = await loadSettings({ root: paths.root });
const alerts = new AlertSink({ file: path.join(paths.root, "alerts.jsonl"), command: settings.alertCommand.value });
const store = new EventStore(paths, { onPoisoned: (health) => alerts.raise({ kind: "ledger_poisoned", key: `ledger_poisoned:${generationId}`, code: health.lastError?.code ?? null }) });
await store.init();
// M5 F4: the generation before this one ended without its daemon_stopping row — killed, crashed, or
// the machine went down. That used to be visible only to someone reading the ledger by hand.
const previousStart = [...store.events].reverse().find((e) => e.type === "daemon_started");
const previousEndRow = previousStart ? store.events.find((e) => e.seq > previousStart.seq && (e.type === "daemon_stopping" || e.type === "daemon_crashed") && e.generationId === previousStart.generationId) : null;
// How the last generation ended, on this generation's first row: stopped (SIGTERM/SIGINT), crashed
// (recorded and alerted by its own handler), unclean (no row at all), or null on a first start.
const previousEnd = !previousStart ? null : previousEndRow?.type === "daemon_stopping" ? "stopped" : previousEndRow ? "crashed" : "unclean";
await store.append("daemon_started", { generationId, daemonPid: process.pid, daemonProcStart: selfProcStart, buildId: BUILD_ID, settings: settingsStatus(settings), previousEnd });
if (previousEnd === "unclean") {
  const lastRow = store.events.filter((e) => e.seq < store.events.at(-1).seq).at(-1);
  await store.append("daemon_previous_unclean", { previousGenerationId: previousStart.generationId, previousPid: previousStart.daemonPid ?? null, previousStartedAt: previousStart.at, lastRowAt: lastRow?.at ?? null }).catch(() => {});
  alerts.raise({ kind: "daemon_previous_unclean", key: `daemon_previous_unclean:${previousStart.generationId}`, code: null }).catch(() => {});
}
// An exception nothing caught ends this process as it always did, but now says so: the stack in
// daemon.log, one ledger row (name and code only — no message text reaches the ledger), one alert,
// and the same cleanup a SIGTERM does, so the next start does not find a lock for a dead pid.
// The exit bound is armed first and kept referenced, so a wedged ledger cannot keep a crashed
// daemon alive. Covered from here on; a failure before this point (lock, table, ledger init) exits
// with the lock left behind, which reclaimDeadDaemon clears on the next start by pid and start time.
let crashing = false;
const bound = (read) => { try { return read(); } catch { return undefined; } };
const crash = (kind) => async (error) => {
  if (crashing) return; crashing = true;
  setTimeout(() => process.exit(1), SHUTDOWN_WAIT_MILLIS + 2000);
  try { process.stderr.write(`${new Date().toISOString()} ${kind}: ${error?.stack ?? error}\n`); } catch {}
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : null;
  const name = typeof error?.name === "string" && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : null;
  await Promise.race([store.append("daemon_crashed", { generationId, kind, name, code }), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => {});
  await Promise.race([alerts.raise({ kind: "daemon_crashed", key: `daemon_crashed:${generationId}`, code }), new Promise((resolve) => setTimeout(resolve, 1000))]).catch(() => {});
  // Before the control server exists (a crash during startup) the names below are not yet bound;
  // then only the lock this process holds is released, and the next start reclaims the rest.
  const live = { server: bound(() => server), controlSockets: bound(() => controlSockets), receiver: bound(() => receiver) };
  if (live.server && live.receiver) await shutdownResources({ ...live, store, daemonLock, paths }).catch(() => []);
  else { try { await daemonLock.close(); await fsp.unlink(paths.daemonLock); } catch {} }
  process.exit(1);
};
process.on("uncaughtException", crash("uncaught_exception"));
process.on("unhandledRejection", crash("unhandled_rejection"));
if (settings.invalid) { process.stderr.write(`universal-peer: ${paths.root}/config.json ignored (${settings.invalid}); alerts and backup not configured\n`); await store.append("daemon_config_invalid", { reason: settings.invalid }).catch(() => {}); }
// Body files no row names (a spool write whose row failed) are moved aside before anything can
// arrive, so a crash between the two never leaves a body outside retention (src/core/orphans.mjs).
await sweepOrphanBodies({ root: paths.root, store, alerts, graceMs: 0 }).catch(() => {});
// Which reader has already been served which body, so a read is recorded once per reader process.
const bodyReads = new Set(store.events.filter((row) => row.type === "inbound_body_read").map((row) => `${row.sourceSeq}|${row.readerPid}|${row.readerProcStart}`));
let maintenance = { lastRun: null, running: false };
// The shipped daemon installs no `onCorrelatedReply` and still does not — that hook is for a
// process that embeds PeerCore, and it only ever sees the correlated half of the traffic. The
// spool is first-party, loads nothing, and keeps the body of every inbound frame whether or not
// it correlated (docs/inband-reply-header.md).
const inboundSpool = new InboundSpool(paths);
let core; let milestone = null; let codeReview = null;
// core and the enabled extensions are read when a frame arrives, not when this is built, which
// is the only reason the handler can exist before them.
const onFrame = frameObserver({
  store,
  core: { acceptFrame: (frame, peer) => core.acceptFrame(frame, peer) },
  observers: [(frame, peer) => milestone?.observeFrame(frame, peer), (frame, peer) => codeReview?.observeFrame(frame, peer)]
});
const receiver = Object.keys(targets).length > 0
  ? await startReceiver(
    onFrame,
    // A frame whose writer the kernel could not name with the frame is refused before it gets
    // this far. Both are recorded so that "refused", "arrived and correlated to nothing" and
    // "nothing arrived" are three different answers here rather than one absence.
    { ...receiverOptionsForState(paths, { onFrameRefused: async (refusal) => { await store.append("peer_frame_refused", refusal); }, onReclaimSkipped: async (detail) => { await store.append("peer_stale_registry_skipped", detail); } }), ...(claudeSessionsDir ? { sessionsDir: claudeSessionsDir } : {}) }
  )
  : { address: "uds:/unpublished/universal-peer-mcp.sock", sessionId: null, close: async () => {} };
// The half of succession that rewrites the operator's table lives out here, with the files and the
// ledger, and not in the core. Two files, on purpose: the id goes into `targets.json`, which is a
// field every build already reads, and the switch and the history go into `targets-rebind.json`
// beside it, which a build that does not know about succession simply does not open
// (src/core/rebind-sidecar.mjs). The table stays byte-compatible with the build before this one, so
// this can be installed on one side while the other side is still running, and taken back out
// without leaving a file the older code refuses. When a send names an alias whose session id nothing live is
// advertising any more, this looks for a live session holding a kernel-written receipt for that id
// — `--resume <it>` in its arguments — repoints the alias at the session that answered, and writes
// down what it did (src/core/session-rebind.mjs). `afterWrite` is what makes the new id take effect
// in this process on this call rather than on the next restart.
const rebindTarget = createSessionRebinder({
  targetsFile: paths.targets, stateFile: paths.rebindState, store, resolveSuccessor,
  afterWrite: () => refreshTargets()
});
// M2: inbound frames and control-socket posts are attributed to a Claude session only through the
// kernel pid, Claude Code's registry row and the operator's table (src/core/sender-auth.mjs).
const resolveSender = createSenderResolver({ allowlist: () => targets, selfPid: process.pid, ...(claudeSessionsDir ? { sessionsDir: claudeSessionsDir } : {}) });
const resolveCodex = createCodexResolver();
// M3: the doorbell for posts delivered to Codex peers (src/core/doorbell-service.mjs). Every accepted
// post for a Codex peer gets a durable intent and one ring; intents left open by a restart are rung
// once more; unknown outcomes older than 30 minutes raise one alarm and are never resent.
const doorbell = new DoorbellService({ store, root: paths.root, settings, codexPeers: () => codexPeers, claudePeers: () => targets, alerts,
  // The Claude half: the same native path peer_send uses, with the fixed line as the whole wire body.
  sendClaude: ({ alias, messageId, threadId, line }) => core.send({ alias, messageId, threadId, kind: "doorbell", body: line }, milestoneSendOptions({ wireBody: line })) });
// M5 F0: a stuck message is reported to its sender, in the sender's own inbox (src/core/receipts.mjs).
const receipts = new ReceiptService({ store, spool: inboundSpool });
await receipts.enable();
store.onAppend = async (row) => { await doorbell.onAppend(row); await receipts.onAppend(row); };
// A sweep that fails is retried on the next minute; a failure that persists (disk, permissions) is
// reported once an hour rather than letting the feature go quiet.
const sweepReceipts = () => { receipts.sweep().catch((error) => { const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "RECEIPT_SWEEP_FAILED"; alerts.raise({ kind: "receipt_sweep_failed", key: `receipt_sweep_failed:${new Date().toISOString().slice(0, 13)}`, code }).catch(() => {}); }); };
setImmediate(sweepReceipts);
setInterval(sweepReceipts, 60 * 1000).unref();
store.onAppendFailed = (row, error) => {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "HOOK_FAILED";
  store.append("doorbell_hook_failed", { sourceSeq: row.seq, ...(typeof row.messageId === "string" ? { messageId: row.messageId } : {}), errorCode: code }).catch(() => {});
  alerts.raise({ kind: "doorbell_hook_failed", key: `doorbell_hook_failed:${row.seq}`, code }).catch(() => {});
};
// M5 F2: a Claude recipient that was away and is back in the registry gets its refused doorbells
// rung once more. Liveness is the registry reading every resolver uses (pid and its start time).
const claudeLiveness = (sessionId) => sessionLiveness(sessionId, claudeSessionsDir ? { sessionsDir: claudeSessionsDir } : {});
const reportRingAgain = (error) => { const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "RING_AGAIN_FAILED"; alerts.raise({ kind: "ring_again_failed", key: `ring_again_failed:${new Date().toISOString().slice(0, 13)}`, code }).catch(() => {}); };
setInterval(() => { doorbell.ringReturnedClaude(claudeLiveness).catch(reportRingAgain); }, 60 * 1000).unref();
const sweepDoorbells = () => { doorbell.sweep().catch((error) => { alerts.raise({ kind: "doorbell_hook_failed", key: `doorbell_sweep_failed:${new Date().toISOString().slice(0, 13)}`, code: typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "SWEEP_FAILED" }).catch(() => {}); }); };
setImmediate(sweepDoorbells);
setInterval(sweepDoorbells, 5 * 60 * 1000).unref();
core = new PeerCore({ targets, store, address: receiver.address, sender: boundedSender, inboundSpool, ...(claudeSessionsDir ? { resolverOptions: { sessionsDir: claudeSessionsDir } } : {}), rebind: rebindTarget, senderResolver: (peer) => resolveSender(peer), postRecipientFields: (alias) => recipientFieldsOf(resolvePeer(alias, { claude: targets, codex: codexPeers })) });
if (enabledExtensions.includes("milestone")) { milestone = new MilestoneExtension({ store, core }); await milestone.reconcile(); }
if (enabledExtensions.includes("code-review")) codeReview = new CodeReviewExtension({ store, core });
const token = crypto.randomBytes(32).toString("hex"); let closing = false;
const controlSockets = new Set();
const server = net.createServer((socket) => accept(socket));
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.controlSocket, resolve); });
await fsp.chmod(paths.controlSocket, 0o600);
await atomicPrivateWrite(paths.controlToken, `${token}\n`);
const identity = { pid: process.pid, procStart: selfProcStart, socketPath: paths.controlSocket, admin, enabledExtensions, startedAt: new Date().toISOString() };
await atomicPrivateWrite(paths.daemon, `${JSON.stringify(identity)}\n`);

function accept(socket) {
  controlSockets.add(socket); socket.once("close", () => controlSockets.delete(socket));
  let buffer = ""; let handled = false; socket.setEncoding("utf8");
  socket.on("data", (chunk) => { buffer += chunk; if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy(); const newline = buffer.indexOf("\n"); if (newline < 0 || handled) return; handled = true; void handle(socket, buffer.slice(0, newline)); });
}

async function handle(socket, line) {
  let request;
  try {
    request = JSON.parse(line); const peerPid = localPeerPid(socket);
    if (!safeEqual(request.token, token) || request.clientPid !== peerPid || processUid(peerPid) !== process.getuid() || normalizeProcStart(request.clientProcStart) !== normalizeProcStart(processStart(peerPid))) throw new Error("control authentication failed");
    // Before the check, not after it: the digest a caller is held against has to be the table this
    // process would actually send with, and the caller read the file for this request. It is also
    // before `daemon_status`, which is the answer the caller compares its own reading against.
    await refreshTargets();
    if (REACHES_A_TARGET.has(request.method)) assertChecked(request.expect);
    const result = await dispatch(request.method, request.args ?? {}, { pid: peerPid, procStart: normalizeProcStart(request.clientProcStart) }); socket.end(`${JSON.stringify({ requestId: request.requestId, ok: true, result })}\n`);
    if (request.method === "daemon_shutdown") setImmediate(shutdown);
  } catch (error) { socket.end(`${JSON.stringify({ requestId: request?.requestId ?? null, ok: false, error: { code: typeof error?.code === "string" ? error.code : "INTERNAL_FAILURE", message: error?.message ?? "daemon request failed", diagnostic: targetDiagnostic(error?.diagnostic), ...(typeof error?.reason === "string" && /^[a-z_]{1,40}$/.test(error.reason) ? { reason: error.reason } : {}) } })}\n`); }
}

// The methods that can reach a target session: three that name one and one that does not. A
// recovery is aimed by an identity the ledger recorded when the completion arrived, so it names
// no alias and there is no alias for the façade's allowlist check to catch — which is exactly why
// it is on this list. What the list buys is that all four are executed against the table their
// caller checked, or not at all.
const REACHES_A_TARGET = new Set(["peer_status", "peer_send", "code_review_request", "milestone_recover_ack"]);

// The condition the caller checked, enforced on the side that executes. A command that carries no
// binding is refused with the rest: an absent binding is not a weaker binding, and a caller that
// forgets one would otherwise reopen the window this closes without anything saying so. It is the
// one reading this daemon has of the table (`targetsDigest`), so passing this is what makes the
// row `core` holds the row the caller read — including for the recovery, whose alias is then
// checked against that same table (src/extensions/milestone/index.mjs).
function assertChecked(expect) {
  const bound = expect !== null && typeof expect === "object" && !Array.isArray(expect)
    && expect.daemonPid === process.pid
    && normalizeProcStart(expect.daemonProcStart) === normalizeProcStart(selfProcStart)
    && expect.targetsDigest === targetsDigest;
  if (bound) return;
  const error = new Error("this call was checked against a different daemon or a different target table");
  error.code = "TARGET_UNAVAILABLE";
  throw error;
}

// One reading of `targets.json`, taken per request and again immediately after a succession rewrote
// it. A table that could not be parsed leaves the last good one in force and is written down once
// per distinct bad version: dropping to an empty table would unpublish every alias silently, and
// serving the old one is safe because the caller's digest will not match it and the call is refused.
async function refreshTargets() {
  const codexReading = await codexWatch.read();
  if (codexReading.changed) {
    if (codexReading.unreadable) await store.append("peer_directory_reload_failed", { reason: "codex_peers_unreadable" }).catch(() => {});
    else { codexPeers = codexReading.table; if (codexReading.digestChanged) await store.append("peer_directory_reloaded", { table: "codex", peerCount: Object.keys(codexPeers).length, changedAliases: codexReading.changedAliases }).catch(() => {}); }
  }
  const reading = await tableWatch.read();
  if (!reading.changed) return;
  if (reading.unreadable) { await store.append("target_table_reload_failed", { reason: "target_table_unreadable" }).catch(() => {}); return; }
  const previousDigest = targetsDigest;
  targets = reading.table; targetsDigest = reading.digest;
  if (core) core.targets = targets;
  if (reading.digestChanged) {
    await store.append("target_table_reloaded", { previousDigest, targetsDigest, targetCount: Object.keys(targets).length, changedAliases: reading.changedAliases }).catch(() => {});
  }
}

async function dispatch(method, args, caller = null) {
  if (method === "peer_targets") return core.targetsList();
  if (method === "peer_status") return core.status(args.alias);
  if (method === "peer_send") return withInlineBodies(await core.send(publicSendArgs(args)), caller, method);
  if (method === "peer_wait") return withInlineBodies(await core.wait(args), caller, method);
  if (method === "peer_list_events") { const listing = core.events(args); return withInlineBodies({ ...listing, events: listing.events.map(publicLedgerEvent) }, caller, method); }
  if (method === "trace_attempt") return recordAttempt(store, args);
  if (method === "peer_post") return post(args, caller);
  if (method === "peer_inbox") return readInbox(args, caller);
  if (method === "peer_inbox_ack") return ackOwnInbox(args, caller);
  if (method === "peer_register") return register(args, caller);
  if (method === "peer_unregister") return unregister(args, caller);
  if (method === "peer_directory") return directory();
  if (method === "peer_overview") return peerOverview();
  if (method === "peer_post_relink") return relink(args, caller);
  if (method === "peer_whoami") { const who = await identifyCaller(caller); return who.authenticated ? { authenticated: true, alias: who.alias, kind: who.kind } : { authenticated: false, kind: who.kind ?? null, reason: who.reason, ...(who.rebind ? { rebind: who.rebind } : {}) }; }
  if (method === "peer_link_unmatched") { const op = await requireOperator(caller, args, "link", String(args.sourceSeq)); return linkUnmatched(store, { sourceSeq: args.sourceSeq, messageId: args.messageId, as: args.as, verdict: args.verdict ?? null, by: { linkedByPid: caller?.pid, operator: OPERATOR_LABEL, operatorTty: op.tty } }); }
  if (method === "inbound_body_dispose") { if (!Number.isInteger(args.sourceSeq) || args.sourceSeq < 1 || !["processed", "discard"].includes(args.disposition)) throw Object.assign(new Error("sourceSeq must be a positive integer and disposition processed or discard"), { code: "INVALID_CONTROL_ARGUMENTS" }); if (!(await ownsBody(caller, args.sourceSeq))) await requireOperator(caller, args, "dispose", String(args.sourceSeq)); return disposeInboundBody({ root: paths.root, store, sourceSeq: args.sourceSeq, disposition: args.disposition }); }
  if (method === "trace_message") { if (typeof args.messageId !== "string" || !/^[0-9a-f-]{36}$/i.test(args.messageId)) throw Object.assign(new Error("messageId must be a uuid"), { code: "INVALID_CONTROL_ARGUMENTS" }); return traceMessage(store.events, args.messageId); }
  if (method === "ledger_daily_stats") { const days = Number.isInteger(args.days) && args.days > 0 && args.days <= 400 ? args.days : 30; return { days: dailyStats(store.events, { sinceDay: dayOf(Date.now() - (days - 1) * 86_400_000) }) }; }
  if (method === "milestone_status" && milestone) return milestone.status(args);
  if (method === "milestone_list" && milestone) return milestone.list(args);
  if (method === "milestone_wait" && milestone) return milestone.wait(args);
  if (method === "milestone_recover_ack" && milestone) return milestone.recover(args);
  if (method === "code_review_status" && codeReview) return codeReview.status(args);
  if (method === "code_review_list" && codeReview) return codeReview.list(args);
  if (method === "code_review_wait" && codeReview) return codeReview.wait(args);
  if (method === "code_review_request" && codeReview) return codeReview.request(args);
  if (method === "daemon_status") return { daemonBuild: buildObservation(), running: true, pid: process.pid, procStart: identity.procStart, admin, enabledExtensions, eventSeq: store.events.at(-1)?.seq ?? 0, targetCount: Object.keys(targets).length, targetsDigest, generationId, ledger: store.health(), maintenance: { lastRun: maintenance.lastRun, running: maintenance.running }, alerts: alerts.status(), settings: settingsStatus(settings) };
  if (method === "daemon_shutdown" && admin) return { shuttingDown: true };
  throw new Error("unknown or unavailable daemon method");
}

// The three answers that carry frame rows, and the one place the body of an inbound frame is put
// into an answer. `peer_wait` and `peer_list_events` are how the receiving side reads at all, and a
// `peer_send` replay hands back the same rows for a message already sent. Nothing is written here
// and nothing the store holds is changed: `hydrateInboundBodies` returns copies, so the ledger keeps
// a file name and a digest and no body (src/core/inbound-hydrate.mjs).
//
// `peer_wait` answers with one row under `event` as well as the listing it came from. It is the same
// row, so it is replaced with the hydrated copy rather than left as the one row in the answer whose
// body is missing.
async function withInlineBodies(result, caller = null, method = null, { perBody } = {}) {
  if (!result || !Array.isArray(result.events)) return result;
  // M4 review [상]2 (+ re-review): bodies leave only through the authenticated inbox, which is already
  // filtered to the caller's session. Every other answer (peer_wait, peer_list_events, a peer_send
  // replay) is metadata — no exception for "the process that sent the request": a Codex MCP serve has
  // no thread identity and one serve can carry several threads. The compatibility window restores
  // the old behaviour for the short switch-over only.
  const open = method === "peer_inbox" || settings[LEGACY_BODIES].value;
  const withheld = new Set();
  const input = open ? result.events : result.events.map((row, index) => {
    if (typeof row?.bodyFile !== "string") return row;
    withheld.add(index); const { bodyFile, ...rest } = row; return rest;
  });
  const events = (await hydrateInboundBodies(input, { root: paths.root, expired: expiredBodyFiles(store.events), ...(perBody ? { perBody, total: perBody } : {}) })).map((row, index) => (withheld.has(index) ? { ...row, bodyInlineOmitted: "not_for_this_reader" } : row));
  await recordBodyReads(events, caller, method);
  if (!result.event || typeof result.event.seq !== "number") return { ...result, events };
  const hydrated = events.find((row) => row.seq === result.event.seq);
  return { ...result, ...(hydrated ? { event: hydrated } : {}), events };
}

// M2: an independent message from a Claude session, through the control socket. The tool issues the
// ids: one group id per send, and per recipient a UUIDv5 of (group, alias) — so resending the same
// group (same groupId) is a duplicate per recipient, never a second message. The caller must be a
// Claude session in the target table (walked up from the calling process); anything else is
// refused and recorded by digest only.
async function post(args, caller) {
  const allowed = new Set(["to", "body", "groupId", "replyTo", "expectReply"]);
  if (!args || typeof args !== "object" || Object.keys(args).some((k) => !allowed.has(k)) || typeof args.body !== "string" || args.body.length === 0) throw Object.assign(new Error("peer_post takes to[1..8], body, optional groupId, optional replyTo, optional expectReply"), { code: "INVALID_CONTROL_ARGUMENTS" });
  if (args.expectReply !== undefined && args.expectReply !== true) throw Object.assign(new Error("expectReply is true or absent"), { code: "INVALID_CONTROL_ARGUMENTS" });
  if (args.replyTo === undefined && (!Array.isArray(args.to) || args.to.length === 0 || args.to.length > 8)) throw Object.assign(new Error("peer_post takes to[1..8]"), { code: "INVALID_CONTROL_ARGUMENTS" });
  const auth = await identifyCaller(caller);
  const who = { peerPid: caller?.pid, peerProcStart: caller?.procStart, ...senderOf(auth) };
  if (!auth.authenticated) { await store.append("peer_post_refused", { reason: auth.reason, ...bodyDigest(args.body), ...who }); throw Object.assign(new Error("the calling process is not a registered peer session"), { code: "SENDER_UNAUTHENTICATED" }); }
  if (args.replyTo !== undefined) return replyPost(args, auth, who);
  // M4 deterministic routing: every name resolves to exactly one registered session before anything
  // is written; an unknown name refuses the whole send (nothing half-sent to a group).
  const recipients = [...new Set(args.to)];
  const resolved = recipients.map((alias) => [alias, resolvePeer(alias, { claude: targets, codex: codexPeers })]);
  const unknown = resolved.filter(([, peer]) => peer === null).map(([alias]) => alias);
  if (unknown.length) { await store.append("peer_post_refused", { reason: "unknown_recipient", unknownCount: unknown.length, ...bodyDigest(args.body), ...who }); throw Object.assign(new Error(`not a registered peer: ${unknown.join(", ")} (see: universal-peer-mcp peers)`), { code: "UNKNOWN_RECIPIENT" }); }
  const groupId = args.groupId ?? crypto.randomUUID();
  const results = []; const deliveredTo = new Map();
  for (const [recipient, peer] of resolved) {
    const key = identityKey(peer);
    // Two names for one session get one message (design §3-3).
    if (deliveredTo.has(key)) { results.push({ recipient, state: "same_session", deliveredAs: deliveredTo.get(key) }); continue; }
    deliveredTo.set(key, recipient);
    const messageId = recipientMessageId(groupId, recipient);
    const recipientFields = recipientFieldsOf(peer);
    results.push({ recipient, messageId, ...(await acceptPost({ store, spool: inboundSpool, messageId, recipient, body: args.body, who: { ...who, ...recipientFields, ...(args.expectReply === true ? { expectReply: true } : {}) }, source: "control" })) });
  }
  return { groupId, from: auth.alias, results };
}

// M4 re-review: an ACK/answer to a post goes to the *session that sent it* — bound to its thread or
// session id, into its own inbox — whatever the alias names now. Only a reader of the original (the
// original's session or its proven successor) may answer it.
async function replyPost(args, auth, who) {
  const replyTo = typeof args.replyTo === "string" ? args.replyTo.toLowerCase() : "";
  const original = store.events.find((e) => e.type === "peer_post" && e.messageId === replyTo);
  if (!original) throw Object.assign(new Error("no accepted post with that id"), { code: "POST_UNKNOWN" });
  const readable = original.recipient === auth.alias && lineageOf(auth).has(postBindings(store.events).get(replyTo) ?? "");
  if (!readable) { await store.append("peer_post_refused", { reason: "reply_not_allowed", replyTo, ...bodyDigest(args.body), ...who }); throw Object.assign(new Error("only the session the original was for may answer it"), { code: "REPLY_NOT_ALLOWED" }); }
  const to = typeof original.senderAlias === "string" ? original.senderAlias : null;
  const binding = original.senderKind === "codex" ? (typeof original.senderThreadId === "string" ? { recipientKind: "codex", recipientThreadId: original.senderThreadId } : null) : (typeof original.senderSessionId === "string" ? { recipientKind: "claude", recipientSessionId: original.senderSessionId } : null);
  if (!to || !binding) throw Object.assign(new Error("the original has no authenticated sender to answer"), { code: "REPLY_NOT_ALLOWED" });
  if (Array.isArray(args.to) && (args.to.length !== 1 || args.to[0] !== to)) throw Object.assign(new Error(`an answer goes to the original's sender (${to})`), { code: "INVALID_CONTROL_ARGUMENTS" });
  // M5: an answer's id is derived from (the original, the answering session, the bytes) unless the
  // caller names a group, so the same session answering the same message with the same bytes again —
  // an agent that ran its reply command twice (measured 2026-10-05: three identical replies in four
  // seconds), concurrently or not — lands on the same id and acceptPost answers duplicate. A caller
  // that means to send the same text again as a new message passes --group-id.
  const me = senderOf(auth);
  const derivedGroup = uuidv5(`reply:${replyTo}:${me.senderSessionId ?? me.senderThreadId}:${bodyDigest(args.body).bodySha256}`);
  const groupId = args.groupId ?? derivedGroup;
  const messageId = recipientMessageId(groupId, to);
  return { groupId, from: auth.alias, replyTo, results: [{ recipient: to, messageId, ...(await acceptPost({ store, spool: inboundSpool, messageId, recipient: to, body: args.body, who: { ...who, ...binding, replyTo }, source: "control" })) }] };
}

// M4: who is calling, as one of the registered peers. Claude first (a registry row in the caller's
// ancestry, src/core/sender-auth.mjs), because a Claude session started from a Codex shell inherits
// the thread variable and is still the Claude session; Codex only when no Claude row is found.
// M5 F2: a recipient that runs any authenticated command is back; doorbells refused while it was
// away are rung once more (DoorbellService.ringAgain). At most once a minute per alias, never awaited.
const lastReturnCheck = new Map();
function noticeReturn(who) {
  if (!who?.authenticated) return who;
  const now = Date.now(); if (now - (lastReturnCheck.get(who.alias) ?? 0) < 60_000) return who;
  lastReturnCheck.set(who.alias, now);
  doorbell.ringAgain(who.alias, { binding: who.kind === "codex" ? who.threadId : who.sessionId, trigger: "activity" }).catch(reportRingAgain);
  return who;
}
async function identifyCaller(caller) { return noticeReturn(await identifyCallerOnce(caller)); }
async function identifyCallerOnce(caller) {
  const claude = await resolveSender({ pid: caller?.pid, procStart: caller?.procStart }, { walk: true });
  // Nested sessions: whichever host is nearer the caller is the caller's session. The Codex host's
  // depth is compared, not the depth of the variable: a Claude session started from a Codex shell
  // inherits CODEX_THREAD_ID into every command it runs, and is still the Claude session; a Codex
  // host started inside a Claude session's tree is the Codex thread.
  const codex = resolveCodex(caller?.pid);
  if (codex.proven && (!Number.isInteger(claude.depth) || codex.hostDepth < claude.depth)) return codexCaller(codex);
  if (claude.authenticated) return { authenticated: true, kind: "claude", alias: claude.alias, sessionId: claude.sessionId, pid: claude.pid, procStart: claude.procStart, cwd: claude.cwd };
  if (claude.reason === "session_not_allowlisted") {
    const rebound = await rebindCaller(claude);
    if (rebound) return rebound;
    return { authenticated: false, kind: "claude", reason: claude.reason, ...(claude.rebind ? { rebind: claude.rebind } : {}), sessionId: claude.sessionId, pid: claude.pid, procStart: claude.procStart, cwd: claude.cwd };
  }
  if (claude.reason !== "no_session_row") return { authenticated: false, kind: "claude", reason: claude.reason };
  if (!codex.proven) return codex.reason === "no_codex_thread" ? { authenticated: false, kind: null, reason: "no_session" } : { authenticated: false, kind: "codex", reason: codex.reason };
  return codexCaller(codex);
}
function codexCaller(codex) {
  const alias = aliasOfCodexThread(codexPeers, codex.threadId);
  if (!alias) return { authenticated: false, kind: "codex", reason: "session_not_allowlisted", threadId: codex.threadId };
  return { authenticated: true, kind: "codex", alias, threadId: codex.threadId, pid: codex.carrierPid, procStart: codex.carrierProcStart };
}
function senderOf(auth) {
  if (!auth.authenticated) return { senderAuth: auth.reason };
  return auth.kind === "claude" ? { senderAlias: auth.alias, senderSessionId: auth.sessionId, senderSessionPid: auth.pid, senderSessionProcStart: auth.procStart } : { senderAlias: auth.alias, senderKind: "codex", senderThreadId: auth.threadId };
}

// M4 restart per session: a Claude session that is not in the table but was started with
// `--resume <id>` for exactly one alias's session is offered to the existing succession proof
// (src/core/session-rebind.mjs → registry.resolveSuccessor), which keeps every M2 refusal: same
// process (/clear, picker), --fork-session, chained succession, cwd, the daemon's own row. No proof,
// or proof for two aliases, is no rebind.
async function rebindCaller(claude) {
  if (!Number.isInteger(claude.pid)) return null;
  const claims = resumeClaims(claude.pid);
  if (claims.ids.length === 0) return null;
  let history = {}; try { history = (await readRebindState(paths.rebindState)).history ?? {}; } catch {}
  const current = Object.keys(targets).filter((alias) => claims.ids.some((id) => sameUuid(id, targets[alias].sessionId)));
  const older = Object.keys(targets).filter((alias) => !current.includes(alias) && claims.ids.some((id) => (history[alias] ?? []).some((old) => sameUuid(old, id))));
  const aliases = [...new Set([...current, ...older])];
  if (aliases.length !== 1) return null;
  const alias = aliases[0]; const expectedId = targets[alias].sessionId;
  const fail = async (reason, recovery) => { claude.rebind = reason; await store.append("target_rebind_failed", { alias, expectedSessionId: expectedId, reason, candidateCount: 0, recovery }).catch(() => {}); return null; };
  if (claims.fork) return fail("rebind_fork_refused", "--fork-session starts a new conversation; it never inherits an alias. Register it by hand: universal-peer-mcp register --alias <name>");
  // The same process under a new id (/clear, picker) is never inherited, whatever its argv says: the
  // ledger remembers which process last proved the alias's current id.
  const last = [...store.events].reverse().find((e) => (e.senderSessionId === expectedId || ((e.type === "peer_registered" || e.type === "peer_session_rebound") && e.sessionId === expectedId)) && Number.isInteger(e.senderSessionPid ?? e.sessionPid));
  if (last && (last.senderSessionPid ?? last.sessionPid) === claude.pid && normalizeProcStart(last.senderSessionProcStart ?? last.sessionProcStart) === normalizeProcStart(claude.procStart)) {
    return fail("rebind_same_process", "the same process now holds a new session id (/clear or picker); re-register by hand: universal-peer-mcp register --alias <name> --replace");
  }
  // Everything else — a current id, or an older id of this alias (chained: refused inside) — goes to
  // the existing succession proof, which records its own refusal.
  try { await rebindTarget({ alias, expected: targets[alias], options: claudeSessionsDir ? { sessionsDir: claudeSessionsDir } : {} }); }
  catch (error) { claude.rebind = targetDiagnostic(error?.diagnostic) ?? "rebind_failed"; return null; }
  const again = await resolveSender({ pid: claude.pid, procStart: claude.procStart }, { walk: false });
  if (!again.authenticated) return null;
  await store.append("peer_session_rebound", { alias: again.alias, sessionId: again.sessionId, previousSessionId: expectedId, sessionPid: again.pid, sessionProcStart: again.procStart }).catch(() => {});
  return { authenticated: true, kind: "claude", alias: again.alias, sessionId: again.sessionId, pid: again.pid, procStart: again.procStart, cwd: again.cwd, rebound: true };
}

// The `--resume <id>` receipts in the kernel's argv of a session process and its launchers, stopping
// at another session's process (the same boundary the succession proof uses).
function resumeClaims(pid) {
  const ids = []; let fork = false; let current = pid; const seen = new Set();
  let boundary = new Set(); try { boundary = new Set(fs.readdirSync(claudeSessionsDir ?? DEFAULT_SESSIONS_DIR).map((n) => /^(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number)); } catch {}
  for (let depth = 0; depth <= 8; depth += 1) {
    if (!Number.isInteger(current) || current <= 1 || seen.has(current) || (depth > 0 && boundary.has(current))) break;
    seen.add(current);
    let argv = null; try { argv = readProcessArgv(current); } catch {}
    if (Array.isArray(argv)) {
      if (argv.includes("--fork-session")) fork = true;
      argv.forEach((token, i) => { if ((token === "--resume" || token === "-r") && typeof argv[i + 1] === "string" && /^[0-9a-f-]{36}$/i.test(argv[i + 1])) ids.push(argv[i + 1].toLowerCase()); else if (typeof token === "string" && token.startsWith("--resume=") && /^[0-9a-f-]{36}$/i.test(token.slice(9))) ids.push(token.slice(9).toLowerCase()); });
    }
    try { current = processParent(current); } catch { break; }
  }
  return { ids, fork };
}

// M4: an inbox is read only by the session it belongs to. The alias comes from the proof, not from
// the arguments; naming another alias is refused, never answered.
async function readInbox(args, caller) {
  const who = await identifyCaller(caller);
  if (!who.authenticated) throw Object.assign(new Error(`this process is not a registered peer session (${who.reason}); register first: universal-peer-mcp register --alias <name>`), { code: "SENDER_UNAUTHENTICATED" });
  if (args.recipient !== undefined && args.recipient !== who.alias) { await store.append("peer_inbox_refused", { reason: "not_own_inbox", readerAlias: who.alias, readerPid: caller?.pid }).catch(() => {}); throw Object.assign(new Error(`this session is ${who.alias}; it cannot read another peer's inbox`), { code: "RECIPIENT_MISMATCH" }); }
  // M3: what the inbox returns is peer content for review, never an owner instruction or approval.
  const events = inbox(store.events, who.alias, { afterSeq: Number.isInteger(args.afterSeq) ? args.afterSeq : 0, lineage: lineageOf(who) });
  // `--message-id <id>` (the id a doorbell named): say plainly what became of it, so a late doorbell
  // for a message already handled is skipped without guessing. Only for this reader's own mail.
  let lookup = null;
  if (typeof args.messageId === "string") {
    const id = args.messageId.toLowerCase();
    const post = store.events.find((e) => e.type === "peer_post" && e.messageId === id && e.recipient === who.alias);
    const done = post ? store.events.find((e) => e.type === "peer_post_processed" && e.messageId === id) : null;
    lookup = { messageId: id, state: !post ? "not_found" : done ? "already_processed" : events.some((e) => e.messageId === id) ? "pending" : "held_for_owner", ...(done ? { processedSeq: done.seq } : {}) };
  }
  return withInlineBodies({ provenance: "peer_content_not_owner_instruction", alias: who.alias, ...(lookup ? { lookup } : {}), events: lookup ? events.filter((e) => e.messageId === lookup.messageId) : events }, caller, "peer_inbox",
    // M5: one message asked for by id is read whole (up to the spool's own cap), not cut at the 8 KiB a
    // listing inlines per row — a long review used to arrive truncated with no way to read the rest.
    lookup ? { perBody: LOOKUP_BODY_MAX_BYTES } : {});
}
async function ackOwnInbox(args, caller) {
  const who = await identifyCaller(caller);
  if (!who.authenticated) throw Object.assign(new Error(`this process is not a registered peer session (${who.reason})`), { code: "SENDER_UNAUTHENTICATED" });
  const row = store.events.find((e) => e.type === "peer_post" && typeof args.messageId === "string" && e.messageId === args.messageId.toLowerCase());
  if (row && row.recipient !== who.alias) throw Object.assign(new Error(`message ${args.messageId} is not addressed to ${who.alias}`), { code: "NOT_RECIPIENT" });
  if (row && inbox(store.events, who.alias, { lineage: lineageOf(who) }).every((e) => e.messageId !== row.messageId) && !store.events.some((e) => e.type === "peer_post_processed" && e.messageId === row.messageId)) throw Object.assign(new Error(`message ${args.messageId} was for the session ${who.alias} named before; it is held for the Owner`), { code: "NOT_RECIPIENT" });
  return ackInbox(store, { messageId: args.messageId, reader: { readerPid: caller?.pid, readerProcStart: caller?.procStart, readerAlias: who.alias } });
}

// M4 onboarding. The session being registered runs this itself; its identity is proven the same way
// a sender's is (kernel pid → Claude registry row, or kernel exec environment → Codex thread) and
// nothing about it is taken from the arguments except the alias.
async function register(args, caller) {
  const allowed = new Set(["alias", "replace"]);
  if (!args || typeof args !== "object" || Object.keys(args).some((k) => !allowed.has(k)) || typeof args.alias !== "string") throw Object.assign(new Error("peer_register takes alias and optional replace"), { code: "INVALID_CONTROL_ARGUMENTS" });
  const who = await identifyCaller(caller);
  let identity = null;
  if (who.kind === "claude" && (who.authenticated || who.reason === "session_not_allowlisted")) {
    if (typeof who.cwd !== "string") return refused("claude_session_without_cwd");
    let cwd; try { cwd = await fsp.realpath(who.cwd); } catch { return refused("claude_cwd_missing"); }
    let permissionMode = null;
    for (const mode of ["bypass", "prompting"]) { try { provePermissionMode(mode, who.pid, who.procStart); permissionMode = mode; break; } catch {} }
    if (!permissionMode) return refused("permission_mode_unproven", "the Claude session must be started with an explicit --permission-mode (for example: --permission-mode bypassPermissions) by absolute path");
    identity = { kind: "claude", sessionId: who.sessionId, cwd, permissionMode };
  } else if (who.kind === "codex" && (who.authenticated || who.reason === "session_not_allowlisted")) {
    identity = { kind: "codex", threadId: who.threadId };
  } else return refused(who.reason ?? "no_session");
  let result;
  try { result = await registerPeer({ targetsFile: paths.targets, codexFile: codexPeersFile, alias: args.alias, identity, replace: args.replace === true }); }
  catch (error) { await store.append("peer_register_refused", { reason: typeof error?.code === "string" ? error.code : "INTERNAL_FAILURE", alias: /^[a-z][a-z0-9-]{1,47}$/.test(args.alias) ? args.alias : null, kind: identity.kind, peerPid: caller?.pid }).catch(() => {}); throw error; }
  await refreshTargets();
  if (result.state === "registered") await store.append("peer_registered", { alias: result.alias, kind: result.kind, ...(identity.kind === "claude" ? { sessionId: identity.sessionId, permissionMode: identity.permissionMode, sessionPid: who.pid, sessionProcStart: who.procStart } : { threadId: identity.threadId }), replaced: result.replaced, peerPid: caller?.pid });
  return { ...result, ...(identity.kind === "claude" ? { sessionId: identity.sessionId, permissionMode: identity.permissionMode } : { threadId: identity.threadId }) };
  async function refused(reason, hint = null) {
    await store.append("peer_register_refused", { reason, peerPid: caller?.pid }).catch(() => {});
    throw Object.assign(new Error(hint ?? `this process is not a Claude or Codex session this daemon can prove (${reason}); run the command from inside the session you want to register`), { code: "SESSION_UNPROVEN", reason });
  }
}
async function unregister(args, caller) {
  if (!args || typeof args.alias !== "string" || Object.keys(args).some((k) => !["alias", "operator"].includes(k))) throw Object.assign(new Error("peer_unregister takes alias"), { code: "INVALID_CONTROL_ARGUMENTS" });
  // A registered session may remove its own alias; any other alias is the operator's.
  const who = await identifyCaller(caller);
  if (!(who.authenticated && who.alias === args.alias)) await requireOperator(caller, args, "unregister", args.alias);
  const result = await removePeer({ targetsFile: paths.targets, codexFile: codexPeersFile, alias: args.alias });
  await refreshTargets();
  await store.append("peer_unregistered", { alias: result.alias, kind: result.kind, peerPid: caller?.pid });
  return result;
}

function recipientFieldsOf(peer) {
  if (!peer) return {};
  return { recipientKind: peer.kind, ...(peer.kind === "claude" ? { recipientSessionId: peer.sessionId } : { recipientThreadId: peer.threadId }) };
}
function lineageOf(who) { return sessionLineage(store.events, who.alias, who.kind === "claude" ? { kind: "claude", sessionId: who.sessionId } : { kind: "codex", threadId: who.threadId }); }
// operator(interactive-tty): see src/core/operator.mjs for what it is and is not.
async function requireOperator(caller, args, action, target) {
  const refuse = async (reason) => {
    await store.append("operator_refused", { action, reason, operator: OPERATOR_LABEL, peerPid: caller?.pid }).catch(() => {});
    throw Object.assign(new Error(`${action} needs the operator: run it yourself in an interactive terminal outside any agent session and type ${operatorPhrase(target)} (${reason})`), { code: "OPERATOR_REQUIRED", reason });
  };
  const who = await identifyCaller(caller);
  if (who.kind !== null && who.kind !== undefined) return refuse("inside_session");
  const tty = controllingTty(caller?.pid);
  if (!tty) return refuse("no_tty");
  if (args?.operator?.confirm !== operatorPhrase(target)) return refuse("confirm_mismatch");
  await store.append("operator_action", { action, target, operator: OPERATOR_LABEL, tty, peerPid: caller?.pid });
  return { tty };
}
// A body the caller received itself: a post addressed to its alias and bound to its session.
async function ownsBody(caller, sourceSeq) {
  const row = store.events.find((e) => e.seq === sourceSeq);
  if (!row || row.type !== "peer_post") return false;
  const who = await identifyCaller(caller);
  return who.authenticated && row.recipient === who.alias && lineageOf(who).has(postBindings(store.events).get(row.messageId) ?? "");
}

// The directory, with what each alias's current session may not read: posts that were waiting for a
// session the alias no longer names (moved with --replace). Counts only; bodies stay put.
function directory() {
  const peers = listPeers({ claude: targets, codex: codexPeers }).map((peer) => {
    const lineage = sessionLineage(store.events, peer.alias, peer.kind === "claude" ? { kind: "claude", sessionId: peer.sessionId } : { kind: "codex", threadId: peer.threadId });
    const held = heldPosts(store.events, peer.alias, lineage).length;
    return held ? { ...peer, heldForPreviousSession: held } : peer;
  });
  const registered = new Set(peers.map((p) => p.alias));
  const processed = new Set(store.events.filter((e) => e.type === "peer_post_processed").map((e) => e.messageId));
  const unregisteredHeld = store.events.filter((e) => e.type === "peer_post" && e.recipient !== "*" && !registered.has(e.recipient) && !processed.has(e.messageId)).length;
  return { peers, ...(unregisteredHeld ? { heldForUnregistered: unregisteredHeld } : {}), ...(settings[LEGACY_BODIES].value ? { warning: LEGACY_BODIES_WARNING } : {}) };
}
// M5 F3: one screen of who is there and what waits on whom (src/core/overview.mjs). Metadata only.
async function peerOverview() {
  const dir = directory(); const { peers } = dir;
  const started = store.events.find((e) => e.type === "daemon_started" && e.generationId === generationId);
  const presence = new Map(); for (const p of peers) if (p.kind === "claude") presence.set(p.alias, await claudeLiveness(p.sessionId));
  const index = doorbell.againIndex();
  // The held messages by id, so the hand that moves them has the exact command to type.
  const heldIds = new Map(peers.filter((p) => p.heldForPreviousSession).map((p) => [p.alias, heldPosts(store.events, p.alias, lineageOf(p.kind === "claude" ? { kind: "claude", alias: p.alias, sessionId: p.sessionId } : { kind: "codex", alias: p.alias, threadId: p.threadId })).map((e) => e.messageId)]));
  return overview({ events: store.events, peers, presence, eligible: (post) => doorbell.eligibleAgain(post, index), heldIds,
    held: new Map(peers.filter((p) => p.heldForPreviousSession).map((p) => [p.alias, p.heldForPreviousSession])),
    daemon: { pid: process.pid, buildId: BUILD_ID, startedAt: started?.at ?? null, previousEnd: started?.previousEnd ?? null } });
}
// The Owner re-addresses one held post to the alias's current session. A registered session may not
// do this for itself: that would be the takeover this rule exists to stop.
async function relink(args, caller) {
  if (!args || typeof args.messageId !== "string" || Object.keys(args).some((k) => !["messageId", "operator"].includes(k))) throw Object.assign(new Error("peer_post_relink takes messageId"), { code: "INVALID_CONTROL_ARGUMENTS" });
  await requireOperator(caller, args, "relink", args.messageId.toLowerCase());
  const post = store.events.find((e) => e.type === "peer_post" && e.messageId === args.messageId.toLowerCase());
  const peer = post ? resolvePeer(post.recipient, { claude: targets, codex: codexPeers }) : null;
  if (post && !peer) throw Object.assign(new Error(`${post.recipient} is not registered now`), { code: "UNKNOWN_RECIPIENT" });
  const result = await relinkPost(store, { messageId: args.messageId.toLowerCase(), identity: peer ?? { kind: "codex", threadId: null }, by: { relinkedByPid: caller?.pid } });
  // M5: the session that holds the message now is told so, at once (measured 2026-10-06: a relinked
  // answer sat unannounced in the new session's inbox).
  const rung = await doorbell.ringRelinked(args.messageId.toLowerCase()).catch(() => null);
  return { ...result, doorbell: rung?.state ?? null };
}

// "Receiver read" for M1: a body handed out inline to a caller process is a read by that process.
// Recorded once per (row, reader process); never fails the read that triggered it.
async function recordBodyReads(rows, caller, method) {
  if (!caller || !Number.isInteger(caller.pid)) return;
  let written = 0;
  for (const row of rows) {
    if (typeof row.body !== "string" || !Number.isInteger(row.seq)) continue;
    const key = `${row.seq}|${caller.pid}|${caller.procStart}`;
    if (bodyReads.has(key)) continue;
    if (written >= 50) break;
    bodyReads.add(key); written += 1;
    await store.append("inbound_body_read", { sourceSeq: row.seq, ...(typeof row.messageId === "string" ? { messageId: row.messageId } : {}), ...(typeof row.bodySha256 === "string" ? { bodySha256: row.bodySha256 } : {}), readerPid: caller.pid, readerProcStart: caller.procStart, method }).catch(() => {});
  }
}

async function maintain() {
  if (maintenance.running || closing) return;
  maintenance.running = true;
  try { const report = await runMaintenance({ root: paths.root, store, alerts, config: { ...maintenanceConfig(), backupDestination: settings.archiveBackup.value } }); maintenance.lastRun = { at: report.at, archived: report.archived.length, late: report.late.length, expired: report.expiry?.expired ?? 0, backup: report.backup?.configured ? (report.backup.error ?? "ok") : "not_configured", errors: report.errors.map((e) => `${e.step}:${e.code}`) }; }
  catch (error) { maintenance.lastRun = { at: new Date().toISOString(), errors: [`maintenance:${typeof error?.code === "string" ? error.code : "FAILED"}`] }; }
  finally { maintenance.running = false; }
}
setTimeout(maintain, Number(process.env.UNIVERSAL_PEER_MAINTENANCE_DELAY_MS ?? 60_000)).unref();
setInterval(maintain, MAINTENANCE_INTERVAL_MS).unref();

async function shutdown() {
  if (closing) return; closing = true;
  await store.append("daemon_stopping", { generationId }).catch(() => {});
  const problems = await shutdownResources({ server, controlSockets, receiver, store, daemonLock, paths });
  for (const problem of problems) process.stderr.write(`shutdown incomplete: ${/^[A-Z0-9_]{1,64}$/.test(problem.reason?.code ?? "") ? problem.reason.code : "INTERNAL_FAILURE"}\n`);
  process.exit(problems.length > 0 ? 1 : 0);
}
// A written connection is held until the receiver closes it. When our own bound ends the hold
// first, that is written down: the bound stops an unbounded hold, it does not promise that the
// bytes were read. See docs/known-issues.md.
function boundedSender(target, frames, options) {
  return directSend(target, frames, { ...options, onHoldBound: (detail) => store.append("peer_socket_hold_bounded", detail) });
}
function safeEqual(a, b) { if (typeof a !== "string" || typeof b !== "string") return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function publicSendArgs(args) {
  const allowed = new Set(["alias", "messageId", "threadId", "replyTo", "kind", "body"]);
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !allowed.has(key))) {
    const error = new Error("peer_send control arguments contain unsupported fields"); error.code = "INVALID_CONTROL_ARGUMENTS"; throw error;
  }
  return args;
}
function parseExtensions(value) { if (!value) return []; const names = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort(); if (names.some((name) => !["code-review", "milestone"].includes(name))) throw new Error("unsupported extension"); return names; }
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
// Test daemons only: an uncaught exception after startup, so the crash path above can be exercised
// end to end (test/m5/daemon-death.test.mjs). Inert unless the variable is exactly "1".
if (process.env.UNIVERSAL_PEER_TEST_CRASH === "1") setTimeout(() => { throw Object.assign(new Error("test crash"), { code: "TEST_CRASH" }); }, 300);
