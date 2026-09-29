// Why a target could not be reached, as a closed list. Nothing outside it leaves this process:
// `targetDiagnostic` answers `undefined` for a value that is not on it, so a resolver message, a
// path or a caller-supplied string cannot arrive at a reader dressed as a diagnosis.
//
// The four `rebind_*`/`rebound_*` entries are the succession path (src/core/session-rebind.mjs).
// They are diagnoses about the same one failure — the table names a session id nothing live is
// advertising — and they say which of the four answers that attempt reached: it succeeded against
// a proven successor, nothing proved succession, more than one thing did, or the attempt was not
// made because the table switched it off.
const DIAGNOSTICS = new Set([
  "no_live_session_for_session_id", "multiple_live_sessions_for_session_id", "cwd_mismatch",
  "unsupported_peer_protocol", "process_identity_changed", "socket_not_private", "key_not_private",
  "key_identity_mismatch", "argv_executable_mismatch", "permission_mode_unproven",
  "sessions_directory_not_private", "unrecognised_resolver_failure", "target_table_empty",
  "alias_not_allowlisted", "target_table_unreadable", "target_table_stale", "checked_daemon_changed",
  "rebound_via_resume_chain", "rebind_no_proof", "rebind_ambiguous", "rebind_disabled", "rebind_write_failed"
]);
export function targetDiagnostic(value) { return DIAGNOSTICS.has(value) ? value : undefined; }
