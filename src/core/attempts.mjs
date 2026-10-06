import { sameUuid } from "./limits.mjs";

// `trace_attempt`: the one way a path outside the daemon (a `codex queue` doorbell, a fallback
// file, a manual send) writes into the ledger. The caller records the intent first and sends only
// if that write succeeded; then records the outcome. Every value is from a closed shape — ids,
// a path name, an alias, an outcome, a code. There is no field for text.
export const ATTEMPT_PATHS = Object.freeze(["codex_queue", "fallback_file", "peer_send", "manual"]);
export const ATTEMPT_OUTCOMES = Object.freeze(["queued", "written", "failed", "unknown"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALIAS = /^[a-z][a-z0-9-]{1,47}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

const invalid = (message) => Object.assign(new Error(message), { code: "INVALID_CONTROL_ARGUMENTS" });

export function attemptRow(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid("trace_attempt arguments must be an object");
  const allowed = args.phase === "intent"
    ? ["phase", "messageId", "attemptId", "path", "receiverAlias", "receiverThreadId"]
    : ["phase", "messageId", "attemptId", "outcome", "returnedId", "errorCode"];
  if (!["intent", "outcome"].includes(args.phase)) throw invalid("phase must be intent or outcome");
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalid(`unsupported field ${key}`);
  if (!UUID.test(args.messageId ?? "")) throw invalid("messageId must be a lowercase uuid");
  if (!UUID.test(args.attemptId ?? "")) throw invalid("attemptId must be a lowercase uuid");
  if (args.phase === "intent") {
    if (!ATTEMPT_PATHS.includes(args.path)) throw invalid("unknown path");
    if (args.receiverAlias === undefined && args.receiverThreadId === undefined) throw invalid("a receiver is required");
    if (args.receiverAlias !== undefined && !ALIAS.test(args.receiverAlias)) throw invalid("receiverAlias is not an alias");
    if (args.receiverThreadId !== undefined && !UUID.test(args.receiverThreadId)) throw invalid("receiverThreadId must be a uuid");
    const { phase, ...data } = args; return { type: "attempt_intent", data };
  }
  if (!ATTEMPT_OUTCOMES.includes(args.outcome)) throw invalid("unknown outcome");
  if (args.returnedId !== undefined && !UUID.test(args.returnedId)) throw invalid("returnedId must be a uuid");
  if (args.errorCode !== undefined && !CODE.test(args.errorCode)) throw invalid("errorCode must be a code");
  const { phase, ...data } = args; return { type: "attempt_outcome", data };
}

// Decided inside the store's write chain (EventStore.appendChecked).
export function attemptConflict(type, data) {
  return (events) => {
    const same = events.filter((row) => row.attemptId === data.attemptId && (row.type === "attempt_intent" || row.type === "attempt_outcome"));
    if (type === "attempt_intent" && same.length > 0) return Object.assign(new Error("attempt already recorded"), { code: "ATTEMPT_DUPLICATE" });
    if (type === "attempt_outcome") {
      const intent = same.find((row) => row.type === "attempt_intent");
      if (!intent) return Object.assign(new Error("no intent recorded for this attempt"), { code: "ATTEMPT_UNKNOWN" });
      if (!sameUuid(intent.messageId, data.messageId)) return Object.assign(new Error("attempt belongs to another message"), { code: "ATTEMPT_UNKNOWN" });
      if (same.some((row) => row.type === "attempt_outcome")) return Object.assign(new Error("outcome already recorded"), { code: "ATTEMPT_DUPLICATE" });
    }
    return null;
  };
}

export async function recordAttempt(store, args) {
  const { type, data } = attemptRow(args);
  const event = await store.appendChecked(type, data, attemptConflict(type, data));
  return { recorded: true, seq: event.seq, type };
}
