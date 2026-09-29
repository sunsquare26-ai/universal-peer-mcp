#!/usr/bin/env bun
import { shutdownResources } from "./core/shutdown.mjs";
import crypto from "node:crypto";
import { targetDiagnostic } from "./core/target-diagnostics.mjs";
import { observeBuild } from "./core/build-identity.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import { EventStore } from "./core/events.mjs";
import { hydrateInboundBodies } from "./core/inbound-hydrate.mjs";
import { InboundSpool } from "./core/inbound-spool.mjs";
import { frameObserver, PeerCore } from "./core/peer-core.mjs";
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
const startupTable = await tableWatch.read();
if (startupTable.unreadable) throw startupTable.unreadable;
let targets = startupTable.table;
// Not the one reading this daemon will ever have — the reading it has now. It is answered with
// `daemon_status` and enforced by `assertChecked`, and it is refreshed from disk before every
// request, so a table an operator repaired is in force on the next call instead of on the next
// restart. What the check means is unchanged: a command still executes only against the table its
// caller checked it against.
let targetsDigest = startupTable.digest;
const store = new EventStore(paths); await store.init();
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
    receiverOptionsForState(paths, { onFrameRefused: async (refusal) => { await store.append("peer_frame_refused", refusal); }, onReclaimSkipped: async (detail) => { await store.append("peer_stale_registry_skipped", detail); } })
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
core = new PeerCore({ targets, store, address: receiver.address, sender: boundedSender, inboundSpool, rebind: rebindTarget });
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
    const result = await dispatch(request.method, request.args ?? {}); socket.end(`${JSON.stringify({ requestId: request.requestId, ok: true, result })}\n`);
    if (request.method === "daemon_shutdown") setImmediate(shutdown);
  } catch (error) { socket.end(`${JSON.stringify({ requestId: request?.requestId ?? null, ok: false, error: { code: typeof error?.code === "string" ? error.code : "INTERNAL_FAILURE", message: error?.message ?? "daemon request failed", diagnostic: targetDiagnostic(error?.diagnostic) } })}\n`); }
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

async function dispatch(method, args) {
  if (method === "peer_targets") return core.targetsList();
  if (method === "peer_status") return core.status(args.alias);
  if (method === "peer_send") return withInlineBodies(await core.send(publicSendArgs(args)));
  if (method === "peer_wait") return withInlineBodies(await core.wait(args));
  if (method === "peer_list_events") { const listing = core.events(args); return withInlineBodies({ ...listing, events: listing.events.map(publicLedgerEvent) }); }
  if (method === "milestone_status" && milestone) return milestone.status(args);
  if (method === "milestone_list" && milestone) return milestone.list(args);
  if (method === "milestone_wait" && milestone) return milestone.wait(args);
  if (method === "milestone_recover_ack" && milestone) return milestone.recover(args);
  if (method === "code_review_status" && codeReview) return codeReview.status(args);
  if (method === "code_review_list" && codeReview) return codeReview.list(args);
  if (method === "code_review_wait" && codeReview) return codeReview.wait(args);
  if (method === "code_review_request" && codeReview) return codeReview.request(args);
  if (method === "daemon_status") return { daemonBuild: buildObservation(), running: true, pid: process.pid, procStart: identity.procStart, admin, enabledExtensions, eventSeq: store.events.at(-1)?.seq ?? 0, targetCount: Object.keys(targets).length, targetsDigest };
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
async function withInlineBodies(result) {
  if (!result || !Array.isArray(result.events)) return result;
  const events = await hydrateInboundBodies(result.events, { root: paths.root });
  if (!result.event || typeof result.event.seq !== "number") return { ...result, events };
  const hydrated = events.find((row) => row.seq === result.event.seq);
  return { ...result, ...(hydrated ? { event: hydrated } : {}), events };
}

async function shutdown() {
  if (closing) return; closing = true;
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
