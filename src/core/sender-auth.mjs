import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SESSIONS_DIR, SELF_ROW_NAME, rowFileProblem } from "../adapters/claude-native-v1/registry.mjs";
import { normalizeProcStart, processParent, processStart } from "../adapters/claude-native-v1/darwin-procargs.mjs";
import { sameUuid } from "./limits.mjs";

// Who wrote this? (M2) The kernel names the writing process (pid + start time); Claude Code's own
// registry row for that pid names its session; the operator's target table names which sessions
// are ours. A message is authenticated only when all three agree:
//
//   - `~/.claude/sessions/<pid>.json` exists, is this account's, is not group/other writable, and
//     its `procStart` is the start time the kernel reports for that pid (a recycled pid fails);
//   - the row is not the daemon's own registration (`name: universal-peer-mcp`, or this pid);
//   - its sessionId is an alias in the target table.
//
// Frames on the receive socket are checked at the writing pid only. Control-socket callers (a CLI a
// session ran) are checked up their ancestry, stopping at the first Claude session row, so a
// command run by claude-main is claude-main and one run by any other session is that session.
// The `from` text inside a message is never evidence.
export const MAX_SENDER_DEPTH = 8;

export function createSenderResolver({ sessionsDir = DEFAULT_SESSIONS_DIR, allowlist, startReader = processStart, parentReader = processParent, selfPid = process.pid, maxDepth = MAX_SENDER_DEPTH } = {}) {
  // A row, or null with the reason it was refused (`problem`); a pid with no row file has neither.
  // Refusals are the same file checks the resolver makes (rowFileProblem), and a refused row is
  // never used — the walk goes on to the parent exactly as if it were absent. The first one is only
  // reported, so "no session" can say the row was there (seq 99208: a session in use for twelve days
  // was told it was not a session at all, and the owner restarted it twice).
  async function readRow(pid) {
    const file = path.join(sessionsDir, `${pid}.json`);
    let stat;
    try { stat = await fsp.lstat(file); } catch (error) { return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? { row: null, problem: null } : { row: null, problem: "row_unreadable" }; }
    const problem = rowFileProblem(stat);
    if (problem) return { row: null, problem };
    let text; try { text = await fsp.readFile(file, "utf8"); } catch { return { row: null, problem: "row_unreadable" }; }
    let row; try { row = JSON.parse(text); } catch { return { row: null, problem: "row_unparsable" }; }
    return row && row.pid === pid && typeof row.sessionId === "string" && typeof row.procStart === "string" ? { row, problem: null } : { row: null, problem: "row_malformed" };
  }
  return async function resolveSender(peer, { walk = false } = {}) {
    if (!peer || !Number.isInteger(peer.pid)) return { authenticated: false, reason: "no_peer_identity" };
    let pid = peer.pid;
    let refused = null;
    for (let depth = 0; depth <= (walk ? maxDepth : 0); depth += 1) {
      if (!Number.isInteger(pid) || pid <= 1) break;
      let row = null;
      try { const read = await readRow(pid); row = read.row; if (read.problem && !refused) refused = { pid, depth, problem: read.problem }; } catch { row = null; }
      if (row) {
        if (row.name === SELF_ROW_NAME || pid === selfPid) return { authenticated: false, reason: "self_registration", pid, depth };
        let live = null; try { live = normalizeProcStart(startReader(pid)); } catch {}
        if (live === null || live !== normalizeProcStart(row.procStart)) return { authenticated: false, reason: "process_identity_changed", pid, depth };
        if (depth === 0 && peer.procStart && normalizeProcStart(peer.procStart) !== live) return { authenticated: false, reason: "process_identity_changed", pid, depth };
        const table = allowlist?.() ?? {};
        const alias = Object.keys(table).find((name) => sameUuid(table[name]?.sessionId ?? "", row.sessionId));
        if (!alias) return { authenticated: false, reason: "session_not_allowlisted", pid, sessionId: row.sessionId, procStart: row.procStart, cwd: typeof row.cwd === "string" ? row.cwd : null, depth };
        return { authenticated: true, alias, sessionId: row.sessionId, pid, procStart: row.procStart, cwd: typeof row.cwd === "string" ? row.cwd : null, depth };
      }
      if (!walk) break;
      try { pid = parentReader(pid); } catch { break; }
    }
    return { authenticated: false, reason: "no_session_row", ...(refused ? { refusedRow: refused } : {}) };
  };
}

// The fields every inbound row carries about its writer.
export function senderFields(peer, auth) {
  return {
    ...(Number.isInteger(peer?.pid) ? { peerPid: peer.pid } : {}),
    ...(typeof peer?.procStart === "string" ? { peerProcStart: peer.procStart } : {}),
    ...(auth?.authenticated ? { senderAlias: auth.alias, senderSessionId: auth.sessionId } : auth ? { senderAuth: auth.reason } : {})
  };
}
