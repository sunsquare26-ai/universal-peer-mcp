import { sameUuid } from "./limits.mjs";
import { targetDiagnostic } from "./target-diagnostics.mjs";
import { rebindTargetSessionId } from "./target-config.mjs";
import { DEFAULT_REBIND_MODE, previousSessionIdsFor, readRebindState, recordSuccession } from "./rebind-sidecar.mjs";

// The forms a resumed Claude Code session's receipt is written in. `claude --help` advertises
// `-r, --resume [value]`, and a commander option in that shape is given on a command line three
// ways: `--resume <id>`, `--resume=<id>` and `-r <id>`. All three are the same launch, so all three
// are the same receipt; recognising only the first would refuse a session that is plainly a
// successor. Ids are compared with `sameUuid`, so case is not part of the answer.
//
// `--continue` and `-c` are deliberately not here and must not be added. They resume *a* session —
// the most recent one — without naming which, so a process launched with one carries no statement
// about the id in the operator's table. Accepting it would make "some session was resumed" stand in
// for "this session was resumed", which is the one thing this proof exists to refuse.
export const RESUME_FLAGS = Object.freeze(["--resume", "-r"]);
const RESUME_ASSIGNMENT = "--resume=";

// How far up the process tree the receipt is looked for. Measured on this machine 2026-09-11, the
// live session carries it at depth 0 — `/opt/homebrew/bin/claude --resume <id> --permission-mode
// bypassPermissions` is the session's own argv. A launcher that execs the session instead of being
// it puts the receipt one or more steps up, so the walk exists; it is bounded because a process
// tree read through `ps` is read one fork at a time and a cycle in it would not end.
export const MAX_ANCESTOR_DEPTH = 8;

// Did some live process take over the session the table is still naming?
//
// The answer is yes only when a process — the one a registry row names, or one of its ancestors —
// was executed with a receipt for the id the table holds, literally in its arguments. That receipt
// is read out of the kernel rather than out of a file anything else can write, and it is the only
// thing this function will accept. A matching display name is not a proof and neither is a matching
// directory; they are conditions imposed elsewhere on a candidate that already has a receipt.
//
// A pid whose arguments cannot be read is not an error here — it is a process that proves nothing,
// and the walk goes on to its parent.
export function proveResumeSuccession(pid, expectedSessionId, { argvReader, parentReader, boundary = new Set(), maxDepth = MAX_ANCESTOR_DEPTH } = {}) {
  if (typeof argvReader !== "function" || typeof parentReader !== "function") return null;
  if (typeof expectedSessionId !== "string" || expectedSessionId === "") return null;
  const seen = new Set();
  let current = pid;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (!Number.isInteger(current) || current <= 1 || seen.has(current)) return null;
    // The walk stops at the first ancestor that is itself a live session, and that boundary is the
    // reason the walk is safe to have at all. Sessions launch sessions: a session resumed from X
    // that starts a second session Y is Y's ancestor, and without this, Y's walk would reach X,
    // find X's own receipt for X and announce that Y had taken over X — from a receipt that belongs
    // to the process still holding it. A receipt stops being evidence at the process it was issued
    // to. Depth 0 is exempt because the candidate is itself a live session, which is the whole
    // reason it is a candidate.
    if (depth > 0 && boundary.has(current)) return null;
    seen.add(current);
    let argv = null;
    try { argv = argvReader(current); } catch { argv = null; }
    if (Array.isArray(argv) && carriesReceipt(argv, expectedSessionId)) return Object.freeze({ pid: current, depth, proof: "resume_argv" });
    let parent = null;
    try { parent = parentReader(current); } catch { return null; }
    current = parent;
  }
  return null;
}

function carriesReceipt(argv, expectedSessionId) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string") continue;
    if (token.startsWith(RESUME_ASSIGNMENT)) { if (sameUuid(token.slice(RESUME_ASSIGNMENT.length), expectedSessionId)) return true; continue; }
    if (RESUME_FLAGS.includes(token) && index + 1 < argv.length && sameUuid(argv[index + 1], expectedSessionId)) return true;
  }
  return false;
}

// The alias-level half of succession: the ledger row, the table write, the history beside it, and
// the switch that turns the whole thing off. `resolveSuccessor` is injected rather than imported so
// that this file does not depend on the adapter that depends on it, and so a test can drive the
// decision without a process tree underneath it.
//
// Every outcome is written down, and that now includes the ones that are nobody's fault. A write
// that fails is reported as a write that failed: it used to leave this function as an unrecognised
// error, which the caller read back as "no live session for that session id" — the diagnosis this
// path had just disproved — with no row of its own in the ledger.
export function createSessionRebinder({
  targetsFile, store, resolveSuccessor, stateFile = null,
  mode = null,
  writeSessionId = rebindTargetSessionId,
  writeHistory = recordSuccession,
  readState = readRebindState,
  afterWrite = async () => {},
  maxPrevious = 8
}) {
  const modeOf = typeof mode === "function" ? mode : async () => (stateFile === null ? DEFAULT_REBIND_MODE : (await readState(stateFile)).mode);
  return async function rebind({ alias, expected, options = {} }) {
    let chosen;
    try { chosen = await modeOf(); }
    catch (error) {
      // The switch could not be read, so whether the operator turned succession off is unknown, and
      // an unknown switch is treated as off. Nothing is redirected on a guess about permission.
      const message = `the succession switch beside the target table could not be read (${error?.code ?? error?.message ?? "unknown"}); refusing to redirect alias ${alias}`;
      await record(store, "target_rebind_failed", { alias, expectedSessionId: expected.sessionId, reason: "rebind_disabled", candidateCount: 0, recovery: message });
      throw Object.assign(new Error(message), { diagnostic: "rebind_disabled" });
    }
    if (chosen === "off") {
      const message = `succession is switched off for this state directory (rebind: "off"); alias ${alias} still names session ${expected.sessionId}, which is not live`;
      await record(store, "target_rebind_failed", { alias, expectedSessionId: expected.sessionId, reason: "rebind_disabled", candidateCount: 0, rebind: chosen, recovery: message });
      throw Object.assign(new Error(message), { diagnostic: "rebind_disabled" });
    }
    let found;
    try { found = await resolveSuccessor(expected, options); }
    catch (error) {
      // A refusal this path recognises carries its own diagnostic. Anything else is a failure of the
      // ordinary verification — a moved directory, a socket that is not private — and it is left
      // exactly as it is, so the caller names it with the same list every other resolver failure is
      // named from.
      const reason = targetDiagnostic(error?.diagnostic) ?? "unrecognised_resolver_failure";
      await record(store, "target_rebind_failed", {
        alias, expectedSessionId: expected.sessionId, reason, rebind: chosen,
        candidateCount: Number.isInteger(error?.candidateCount) ? error.candidateCount : 0,
        ...(typeof error?.cwdCheck === "string" ? { cwdCheck: error.cwdCheck } : {}),
        ...(Array.isArray(error?.liveCandidates) ? { liveCandidates: error.liveCandidates } : {}),
        recovery: typeof error?.message === "string" ? error.message : "target could not be resolved"
      });
      throw error;
    }
    // The table is rewritten before the row is written, so a ledger line that says a succession
    // happened is only ever written after the file that makes it durable has landed. A write that
    // changes nothing — the same succession proven twice inside one send, once to resolve and once
    // to re-verify — reports `changed: false` and records no second history entry.
    let written;
    try { written = await writeSessionId(targetsFile, alias, found.target.sessionId, { maxPrevious }); }
    catch (error) {
      const message = `alias ${alias} has a proven successor (${found.target.sessionId}) and the target table could not be rewritten (${error?.code ?? error?.message ?? "unknown"}); the alias still names ${expected.sessionId}`;
      await record(store, "target_rebind_failed", {
        alias, expectedSessionId: expected.sessionId, observedSessionId: found.target.sessionId,
        reason: "rebind_write_failed", rebind: chosen, candidateCount: found.evidence.candidateCount,
        cwdCheck: found.evidence.cwdCheck, proof: found.evidence.proof, recovery: message
      });
      throw Object.assign(new Error(message), { diagnostic: "rebind_write_failed" });
    }
    // The history lives beside the table and is a record, not a routing fact. Failing to write it
    // does not undo a succession that has already landed, so it is reported on the row rather than
    // thrown — and the row says which of the two happened.
    let previousSessionIds = [];
    let historyRecorded = true;
    if (written.changed && stateFile !== null) {
      try { previousSessionIds = (await writeHistory(stateFile, alias, written.previousSessionId, { maxPrevious })).previousSessionIds; }
      catch { historyRecorded = false; }
    } else if (stateFile !== null) {
      try { previousSessionIds = previousSessionIdsFor(await readState(stateFile), alias); } catch { historyRecorded = false; }
    }
    // A refresh that fails does not lose a succession that is already on disk; the next request
    // reads the file again anyway.
    try { await afterWrite(); } catch {}
    await record(store, "target_rebound", {
      alias, expectedSessionId: found.evidence.expectedSessionId, observedSessionId: found.evidence.observedSessionId,
      candidateCount: found.evidence.candidateCount, proof: found.evidence.proof, cwdCheck: found.evidence.cwdCheck,
      rebind: chosen, tableChanged: written.changed, historyRecorded, previousSessionIds
    });
    return found.target;
  };
}

// A diagnosis is worth less than the thing it diagnoses. A ledger that cannot be appended to is
// already reported by every other writer on this path, and losing the original failure to it would
// leave the caller with nothing at all.
async function record(store, type, data) {
  try { return await store?.append(type, data); } catch { return null; }
}
