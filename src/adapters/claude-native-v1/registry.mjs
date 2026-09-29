import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProcStart, processParent, processStart, processUid, provePermissionMode, readProcessArgv } from "./darwin-procargs.mjs";
import { proveResumeSuccession } from "../../core/session-rebind.mjs";

export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
export const SUPPORTED_PEER_PROTOCOL = 1;
export const REQUIRED_PEER_FEATURES = Object.freeze(["notify_idle", "reply_across_default_dirs"]);
// How many same-lane live sessions a refusal is allowed to name. The list exists so a person
// reading the failure can see what is actually running; a bound exists because the refusal is
// written to an append-only ledger with a 64 KiB line cap.
const MAX_REPORTED_CANDIDATES = 8;

export async function resolveTarget(expected, options = {}) {
  const reading = readerOptions(options);
  await assertPrivateDirectory(reading.sessionsDir);
  const candidates = await liveRows(reading, (row) => row.sessionId === expected.sessionId);
  if (candidates.length !== 1) throw new Error(`target resolved to ${candidates.length} live candidates`);
  return verifyCandidate(candidates[0], expected, reading, options);
}

// The second answer to one failure, and only to that one: the table names a session id and nothing
// live is advertising it. That is what a Claude Code session resumed with `--resume` looks like from
// here — the session is running, its registry row is fresh, and the id in the row is a new one the
// operator's table has never seen. Measured 2026-09-11: every send to alias `friday-main` failed as
// `no_live_session_for_session_id` while the session it named was up, because the id it was resumed
// from is not the id it now advertises.
//
// What makes the new id the same session is not its name, not its directory and not its being the
// only one left. It is that the kernel's copy of some live process's arguments literally contains
// `--resume <the id the table holds>`: the successor carries a receipt for the session it took over.
// Nothing here follows a display name or a working directory on its own — those are conditions a
// candidate must also satisfy, never the reason one is chosen. And a proof that fits more than one
// live session chooses none of them.
export async function resolveSuccessor(expected, options = {}) {
  const reading = readerOptions(options);
  const argvReader = options.argvReader ?? readProcessArgv;
  const parentReader = options.processParentReader ?? processParent;
  await assertPrivateDirectory(reading.sessionsDir);
  // One scan of the directory, read twice. `sameLane` is (d) same product and lane, judged the way
  // the resolver judges it, plus (c) the directory the table recorded — both read off the row, so a
  // directory full of other lanes' rows costs nothing extra. `boundary` is every live session in it,
  // this lane or another, and it is what the argv walk is not allowed to walk through.
  const live = await liveRows(reading, () => true);
  const boundary = new Set(live.map(({ row }) => row.pid).filter((pid) => Number.isInteger(pid)));
  const sameLane = (await sameLaneRows(live, expected)).filter(({ row }) => !isSelfRow(row, options));
  const cwdCheck = expected?.cwd == null ? "skipped" : "enforced";
  // (a) is already true of everything in `sameLane` — `liveRows` proved the process behind each row
  // is this account's and started when the row says it did. (b) is this loop.
  const proven = [];
  for (const entry of sameLane) {
    const proof = proveResumeSuccession(entry.row.pid, expected.sessionId, { argvReader, parentReader, boundary });
    if (proof) proven.push({ ...entry, proof });
  }
  if (proven.length === 0 && Array.isArray(options.previousSessionIds) && options.previousSessionIds.length > 0) {
    // A live session carrying a receipt for an id the table held *before* the current one is a
    // chain (A -> B -> C). Nothing proves C took over B, so it is refused by name, not as "no proof".
    const chained = sameLane.some((entry) => options.previousSessionIds.some((id) => proveResumeSuccession(entry.row.pid, id, { argvReader, parentReader, boundary })));
    if (chained) throw Object.assign(new Error(`alias session ${expected.sessionId} has no successor; a live session resumes an older id of this alias, and chained succession is not supported — re-register the alias by hand`), { diagnostic: "rebind_chain_unsupported", expectedSessionId: expected.sessionId, candidateCount: 0, cwdCheck, liveCandidates: reportedCandidates(sameLane) });
  }
  if (proven.length !== 1) {
    const diagnostic = proven.length === 0 ? "rebind_no_proof" : "rebind_ambiguous";
    throw Object.assign(new Error(successionRefusal(diagnostic, expected, sameLane)), {
      diagnostic, expectedSessionId: expected.sessionId, candidateCount: proven.length, cwdCheck,
      liveCandidates: reportedCandidates(sameLane)
    });
  }
  const chosen = proven[0];
  // The process that last held the expected id, as the ledger saw it. The same process now under a
  // different id changed sessions in place (`/clear`, a picker switch): not a successor.
  const prior = options.previousGeneration;
  if (prior && Number.isInteger(prior.pid) && chosen.row.pid === prior.pid && normalizeProcStart(chosen.row.procStart) === normalizeProcStart(prior.procStart)) {
    throw Object.assign(new Error(`alias session ${expected.sessionId} changed id inside the same process (pid ${prior.pid}); an in-place session change (/clear, continue, picker) is never inherited — re-register the alias by hand`), { diagnostic: "rebind_same_process", expectedSessionId: expected.sessionId, candidateCount: 1, cwdCheck, liveCandidates: reportedCandidates(sameLane) });
  }
  // The successor is then put through the identical verification an exactly-matching row goes
  // through — cwd, protocol, socket privacy, key identity, permission-mode argv. Succession decides
  // *which* row is examined and relaxes nothing about what the row has to survive.
  const target = await verifyCandidate(chosen, expected, reading, options);
  return {
    target,
    evidence: {
      expectedSessionId: expected.sessionId, observedSessionId: target.sessionId,
      candidateCount: proven.length, proof: "resume_argv", proofPid: chosen.proof.pid,
      proofDepth: chosen.proof.depth, cwdCheck, liveCandidates: reportedCandidates(sameLane)
    }
  };
}

export async function reverifyTarget(target, expected, options = {}) {
  const current = await resolveTarget(expected, options);
  for (const key of ["sessionId", "cwd", "pid", "procStart", "socketPath"]) if (current[key] !== target[key]) throw new Error("target identity changed before write");
  return current;
}

function readerOptions(options) {
  return {
    sessionsDir: options.sessionsDir ?? DEFAULT_SESSIONS_DIR,
    startReader: options.processStartReader ?? processStart,
    uidReader: options.processUidReader ?? processUid
  };
}

// Every row in `~/.claude/sessions` this account wrote, whose process is still the process the row
// names, and which `accept` wants. It is the one place a row becomes a live candidate, so the
// exact-match path and the succession path cannot drift apart about what "live" means.
async function liveRows({ sessionsDir, startReader, uidReader }, accept) {
  const rows = [];
  for (const name of await fsp.readdir(sessionsDir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const file = path.join(sessionsDir, name);
      const stat = await fsp.lstat(file);
      // The one file in this adapter judged on write alone, because it is the one we do not write.
      // Claude Code 2.1.260 publishes ~/.claude/sessions/<pid>.json at 0644 — measured on every
      // live row on this machine — so demanding 0600 here refused every real session and closed
      // nothing: the row carries pid, session id, cwd and a socket path, and the secret that
      // admits a sender is the peerToken in the separate key file below, which stays 0600. What a
      // mode can still prove about a file we do not own is that no other account can rewrite it,
      // and rewriting it is the whole attack — a row another account can edit points this resolver
      // at a socket of its choosing. So group and other write are refused and read is not.
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) continue;
      const row = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!accept(row)) continue;
      if (typeof row.procStart !== "string" || uidReader(row.pid) !== process.getuid() || normalizeProcStart(startReader(row.pid)) !== normalizeProcStart(row.procStart)) continue;
      rows.push({ row, file });
    } catch {}
  }
  return rows;
}

// The rows a successor could come from: a live session of this product, on this protocol, with the
// features this build needs, in the directory the operator's table recorded, and not already the id
// the table holds. Excluding the held id is what keeps this off the exact-match path — if that row
// were live the caller would never be here.
// The daemon registers itself in the same directory as a Claude session (it is the receiver Claude
// replies to). Its row is never a successor (M2; seq 4305 had it as the only live candidate).
export const SELF_ROW_NAME = "universal-peer-mcp";
function isSelfRow(row, options = {}) { return row?.name === SELF_ROW_NAME || row?.pid === (options.selfPid ?? process.pid); }

async function sameLaneRows(live, expected) {
  const shaped = live.filter(({ row }) => typeof row?.sessionId === "string"
    && row.sessionId !== expected.sessionId
    && row.peerProtocol === SUPPORTED_PEER_PROTOCOL
    && Array.isArray(row.peerFeatures) && REQUIRED_PEER_FEATURES.every((feature) => row.peerFeatures.includes(feature)));
  if (expected?.cwd == null) return shaped;
  const kept = [];
  for (const entry of shaped) {
    try { if (await fsp.realpath(entry.row.cwd) === await fsp.realpath(expected.cwd)) kept.push(entry); } catch {}
  }
  return kept;
}

function reportedCandidates(rows) {
  return rows.slice(0, MAX_REPORTED_CANDIDATES).map(({ row }) => ({ sessionId: String(row.sessionId), pid: Number(row.pid), cwd: String(row.cwd) }));
}

// A refusal a person can act on in one line. The id that was expected, what is actually running
// beside it, and the edit that would fix it by hand — because the alternative, and what this
// replaced, is `no_live_session_for_session_id` with nothing else in it.
function successionRefusal(diagnostic, expected, rows) {
  const listed = reportedCandidates(rows).map((row) => `${row.sessionId} (pid ${row.pid}, cwd ${row.cwd})`).join("; ") || "none";
  if (diagnostic === "rebind_ambiguous") {
    return `target session ${expected.sessionId} has more than one live successor claiming --resume; refusing to choose. live in this lane: ${listed}`;
  }
  return `target session ${expected.sessionId} is not live and no live session proves it resumed it. live in this lane: ${listed}. to repair by hand, set this alias's sessionId in targets.json to the id of the session you meant`;
}

async function verifyCandidate({ row, file }, expected, { startReader }, options) {
  // The row was rendered by the session that wrote it and is compared against a rendering made
  // here; only the squeezed form of either is the fact. It is squeezed once and it is the
  // squeezed one that travels, so every later check — the key file, the argv proof, the
  // re-verify before a write, the peer identity on an inbound frame — compares one form.
  const recordedStart = normalizeProcStart(row.procStart);
  const expectedCwd = await fsp.realpath(expected.cwd); const actualCwd = await fsp.realpath(row.cwd);
  if (expectedCwd !== actualCwd) throw new Error("target cwd mismatch");
  if (row.peerProtocol !== SUPPORTED_PEER_PROTOCOL || !Array.isArray(row.peerFeatures) || REQUIRED_PEER_FEATURES.some((feature) => !row.peerFeatures.includes(feature))) throw new Error("unsupported Claude peer protocol");
  if (normalizeProcStart(startReader(row.pid)) !== recordedStart) throw new Error("target process identity changed");
  const socket = row.messagingSocketPath;
  const socketStat = await fsp.lstat(socket);
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o077) !== 0) throw new Error("target socket is not private");
  const keyPath = path.join(path.dirname(file), `${row.pid}.${crypto.createHash("sha256").update(path.resolve(socket)).digest("hex")}.key`);
  const keyStat = await fsp.lstat(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.uid !== process.getuid() || (keyStat.mode & 0o077) !== 0) throw new Error("target key is not private");
  const key = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  if (normalizeProcStart(key.procStart) !== recordedStart || typeof key.peerToken !== "string" || key.peerToken.length < 16) throw new Error("target key identity mismatch");
  const permission = provePermissionMode(expected.permissionMode, row.pid, recordedStart, options.argvReader, options.startReader ?? startReader);
  return {
    sessionId: row.sessionId, cwd: actualCwd, pid: row.pid, procStart: recordedStart,
    socketPath: socket, token: key.peerToken, permission, peerFeatures: row.peerFeatures,
    observedDisplayName: typeof row.name === "string" ? row.name : null,
    expectedDisplayName: expected.expectedDisplayName, registryPath: file
  };
}

async function assertPrivateDirectory(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Claude sessions directory is not private");
}
