// M0 contract, as agreed 2026-09-29 (design §3-2, Friday canon docs/008 §2.1 revision).
//
// A `codex queue` message lands in the Codex thread as a `role:user` item with that thread's full
// permissions. So nothing a peer wrote may travel through it. The queue carries one fixed line
// that names a message id and nothing else; the body is read later through an authenticated MCP
// tool result, which is data, not an instruction.
//
// This file is the executable statement of that contract. It has no dependency on product code.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DOORBELL = /^PEER_DOORBELL v=1 message_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export const DOORBELL_BYTES = 65;

export function doorbell(messageId) {
  if (!UUID.test(messageId)) throw Object.assign(new Error("messageId must be a lowercase uuid"), { code: "INVALID_MESSAGE_ID" });
  return `PEER_DOORBELL v=1 message_id=${messageId}`;
}

export function isDoorbell(text) {
  return typeof text === "string" && Buffer.byteLength(text) === DOORBELL_BYTES && DOORBELL.test(text);
}

// The only argv a queue call may have: the subcommand, the thread UUID, the doorbell.
// Anything else (sandbox, approval, model, cwd, add-dir, profile, config, a thread *name*,
// `--flag=value` spellings, extra positionals) is a rejection.
export function checkQueueArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 5) return { ok: false, reason: "argv_shape" };
  const [sub, threadFlag, thread, messageFlag, message] = argv;
  if (sub !== "queue" || threadFlag !== "--thread" || messageFlag !== "--message") return { ok: false, reason: "argv_shape" };
  if (!UUID.test(thread)) return { ok: false, reason: "thread_not_uuid" };
  if (!isDoorbell(message)) return { ok: false, reason: "message_not_doorbell" };
  return { ok: true, messageId: DOORBELL.exec(message)[1] };
}

export const FORBIDDEN_QUEUE_FLAGS = Object.freeze([
  ["-s", "danger-full-access"], ["--sandbox", "workspace-write"], ["--dangerously-bypass-approvals-and-sandbox"],
  ["--approve-for-me"], ["-m", "gpt-x"], ["-C", "/"], ["--add-dir", "/"], ["-p", "profile"], ["-c", "approval_policy=never"]
]);
