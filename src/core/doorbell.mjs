import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The Claude -> Codex doorbell (Friday docs/008 §2.1, 2026-09-29): `codex queue` puts its text into
// the Codex thread as a user message with that thread's full permissions, so the only text it may
// carry is one fixed line naming a message id. The body travels through the daemon and is read as
// a tool result. This module builds that line and that argv and nothing else, and sends only after
// the attempt is on the ledger.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DOORBELL = /^PEER_DOORBELL v=1 message_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

const refuse = (code, message) => Object.assign(new Error(message), { code });

export function doorbell(messageId) {
  if (!UUID.test(messageId ?? "")) throw refuse("INVALID_MESSAGE_ID", "messageId must be a lowercase uuid");
  return `PEER_DOORBELL v=1 message_id=${messageId}`;
}

export function queueArgv(threadId, messageId) {
  if (!UUID.test(threadId ?? "")) throw refuse("INVALID_THREAD", "thread must be a lowercase session uuid, never a name");
  return ["queue", "--thread", threadId, "--message", doorbell(messageId)];
}

const run = promisify(execFile);

// trace: async (args) => void, the daemon's `trace_attempt`. Throws -> nothing is sent.
export async function sendDoorbell({ threadId, messageId, alias = null, cliPath, trace, exec = run, attemptId = crypto.randomUUID() }) {
  const argv = queueArgv(threadId, messageId);
  if (typeof cliPath !== "string" || !cliPath.startsWith("/")) throw refuse("INVALID_CLI", "codex cli path must be absolute");
  try {
    await trace({ phase: "intent", messageId, attemptId, path: "codex_queue", receiverThreadId: threadId, ...(alias ? { receiverAlias: alias } : {}) });
  } catch (error) {
    return { state: "not_sent", reason: "trace_intent_failed", code: typeof error?.code === "string" ? error.code : null, attemptId };
  }
  let outcome; let returnedId; let errorCode;
  try {
    const { stdout } = await exec(cliPath, argv, { timeout: 15_000, maxBuffer: 65_536 });
    const match = /Queued message ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(stdout ?? "");
    if (match && String(stdout).includes(`for thread ${threadId}`)) { outcome = "queued"; returnedId = match[1].toLowerCase(); }
    else { outcome = "unknown"; errorCode = "UNRECOGNISED_RESPONSE"; }
  } catch (error) {
    // Not started at all is a failure; anything after the process started (a timeout, a non-zero
    // exit after it may have queued) is unknown, and unknown is never retried automatically.
    if (error?.code === "ENOENT" || error?.code === "EACCES") { outcome = "failed"; errorCode = "CLI_NOT_STARTED"; }
    else { outcome = "unknown"; errorCode = error?.killed ? "CLI_TIMEOUT" : "CLI_EXIT"; }
  }
  const recorded = { phase: "outcome", messageId, attemptId, outcome, ...(returnedId ? { returnedId: UUID.test(returnedId) ? returnedId : undefined } : {}), ...(errorCode ? { errorCode } : {}) };
  if (recorded.returnedId === undefined) delete recorded.returnedId;
  try { await trace(recorded); }
  catch { return { state: "unknown", reason: "trace_outcome_failed", outcome, attemptId }; }
  return { state: outcome, attemptId, ...(returnedId ? { returnedId } : {}) };
}
