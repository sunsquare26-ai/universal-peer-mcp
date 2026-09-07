const NULLABLE_STRING = { type: ["string", "null"] };
// An allowlist with nothing on it is advertised as one, not as an enum no value can satisfy. An
// empty enum refuses every call as malformed parameters, and that refusal names the caller's
// arguments instead of the table behind them — which is how an install whose table was written
// after the server started reads as six working tools that answer nothing. Nothing is opened by
// this: an empty table allows no alias either way, the advertised string is still bound to the
// shape an alias may have, and the call is refused before it reaches the daemon with the reason
// that says the table is what is missing (src/server.mjs).
// The shape is written here rather than read from the loader on purpose. It is consulted in one
// case only — the table is empty — and in that case every alias is refused whatever it looks
// like, so a shape that drifts from the loader's can widen nothing and narrow nothing that was
// ever going to be allowed. What it does is keep the advertised parameter bounded instead of
// unbounded while there is no allowlist to bound it.
const EMPTY_ALIAS = { type: "string", pattern: "^[a-z][a-z0-9-]{1,47}$", description: "The target table is empty, so no alias is allowlisted and a call naming one is refused." };

// peer_targets answers with the list under a name. It used to answer with the list itself, and
// an array is a legal structuredContent on the 2026-07-28 wire but not on 2025-06-18, where the
// field is typed as an object: measured in fixtures/mcp/legacy-output.golden.jsonl as
// `"structuredContent":[]`, the one array root among every tool this package has, extensions
// included. A strict legacy client refused the call rather than reading it. Naming the list also
// gives the tool an outputSchema it can advertise — the root of one has to be an object schema —
// so peer_targets is now declared like every other tool instead of carrying its contract out of
// band, and there is one place a field can be added to it later without moving position zero.
const TARGETS_RESULT_SCHEMA = { type: "object", required: ["targets"], properties: { targets: { type: "array", items: { type: "object", required: ["alias", "connected", "permissionMode", "expectedDisplayName", "observedDisplayName"], properties: { alias: { type: "string" }, connected: { type: "boolean" }, permissionMode: { type: "string", enum: ["prompting", "bypass"] }, expectedDisplayName: NULLABLE_STRING, observedDisplayName: NULLABLE_STRING }, additionalProperties: false } } }, additionalProperties: false };

// The contract a raw daemon result is projected down to and validated against before it is
// published. A tool with no contract has none, and the adapters refuse its result rather than
// publish an unfiltered one.
export function publicResultSchema(tool) { return tool?.outputSchema ?? null; }

export function toolDefinitions(aliases, { admin = false, extensions = [], requestedExtensions = [] } = {}) {
  const allowlist = [...aliases].sort();
  const alias = allowlist.length > 0 ? { type: "string", enum: allowlist } : EMPTY_ALIAS;
  const nullableString = NULLABLE_STRING;
  const uuid = { type: "string", format: "uuid" };
  const event = {
    type: "object",
    required: ["seq", "type", "at"],
    properties: {
      seq: { type: "integer", minimum: 1 }, type: { type: "string" }, at: { type: "string", format: "date-time" },
      messageId: uuid, subscriptionId: uuid, responseMessageId: uuid, threadId: uuid, replyTo: { type: ["string", "null"], format: "uuid" },
      alias: { type: "string" }, kind: { type: "string" }, requestHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      bytesWritten: { type: "integer", minimum: 0 }, errorCode: { type: "string" }, status: { type: "string" }, state: { type: "string" },
      verdict: nullableString, evidence: nullableString, expected: nullableString, observed: nullableString
    },
    additionalProperties: false
  };
  const events = { type: "array", items: event };
  const extensionNames = { type: "array", items: { type: "string", enum: [...new Set([...extensions, ...requestedExtensions])].sort() } };
  const exposeExtensionStatus = extensions.length > 0 || requestedExtensions.length > 0;
  // targetCount is the daemon's table, read when it started and the one its core enforces.
  // advertisedTargetCount is the table behind the alias allowlist in this list, read for this
  // request. They are two reads of one file at two times and they can differ; when they did,
  // nothing in the answer said so. Neither is required: only the server attaches the second,
  // and it attaches both comparisons with it.
  // targetCountMismatch answers "are there as many rows", targetTableMismatch answers "are they
  // the same rows". Only the second one is a gate — while it is true every call naming an alias
  // is refused, because an alias whose row moved is a name for a session the caller did not
  // choose. The count is kept because it is the number an operator reads first.
  const daemonRequired = ["running", "pid", "procStart", "admin", "eventSeq", "targetCount", ...(exposeExtensionStatus ? ["enabledExtensions"] : [])];
  const daemonProperties = { running: { type: "boolean" }, pid: { type: "integer", minimum: 1 }, procStart: { type: "string" }, admin: { type: "boolean" }, eventSeq: { type: "integer", minimum: 0 }, targetCount: { type: "integer", minimum: 0 }, advertisedTargetCount: { type: "integer", minimum: 0 }, targetCountMismatch: { type: "boolean" }, targetTableMismatch: { type: "boolean" }, ...(exposeExtensionStatus ? { enabledExtensions: extensionNames, requestedExtensions: extensionNames, extensionMismatch: { type: "boolean" } } : {}) };
  const tools = [
    { name: "peer_targets", description: "List local target aliases and their configured state.", inputSchema: { type: "object", additionalProperties: false }, outputSchema: TARGETS_RESULT_SCHEMA },
    { name: "peer_status", description: "Verify one allowlisted running Claude Code session without sending.", inputSchema: { type: "object", required: ["alias"], properties: { alias }, additionalProperties: false }, outputSchema: { type: "object", required: ["alias", "connected", "sessionId", "cwdMatches", "permission", "observedDisplayName", "pid", "procStart"], properties: { alias: { type: "string" }, connected: { type: "boolean" }, sessionId: uuid, cwdMatches: { type: "boolean" }, permission: { type: "object", required: ["mode", "verifiedBy"], properties: { mode: { type: "string", enum: ["prompting", "bypass"] }, verifiedBy: { type: "string" } }, additionalProperties: false }, observedDisplayName: nullableString, pid: { type: "integer", minimum: 1 }, procStart: { type: "string" } }, additionalProperties: false } },
    { name: "peer_send", description: "Send one idempotent message. A failure is never retried automatically.", inputSchema: { type: "object", required: ["alias", "messageId", "threadId", "kind", "body"], properties: { alias, messageId: uuid, threadId: uuid, replyTo: { type: ["string", "null"], format: "uuid" }, kind: { type: "string", minLength: 2, maxLength: 64, pattern: "^[a-z][a-z0-9_-]{1,63}$" }, body: { type: "string", minLength: 1, maxLength: 65536 } }, additionalProperties: false }, outputSchema: { type: "object", required: ["replay", "messageId", "requestHash", "status"], properties: { replay: { type: "boolean" }, messageId: uuid, threadId: uuid, subscriptionId: uuid, requestHash: { type: "string", pattern: "^[0-9a-f]{64}$" }, alias: { type: "string" }, status: { type: "string", enum: ["requested", "written", "held", "delivered", "idle", "acknowledged", "replied", "terminal", "uncertain_failure", "unknown"] }, events }, additionalProperties: false } },
    { name: "peer_wait", description: "Wait for a correlated ACK, reply, or idle notice without resending.", inputSchema: { type: "object", required: ["messageId"], properties: { messageId: uuid, require: { type: "string", enum: ["ack", "reply", "idle"] }, timeoutMs: { type: "integer", minimum: 1, maximum: 300000 } }, additionalProperties: false }, outputSchema: { type: "object", anyOf: [{ required: ["event", "events"] }, { required: ["timedOut", "messageId", "require", "state", "events"] }], properties: { event, events, evidence: nullableString, timedOut: { type: "boolean" }, messageId: uuid, require: { type: "string" }, state: { type: "string" } }, additionalProperties: false } },
    { name: "peer_list_events", description: "Read durable local events after a sequence cursor.", inputSchema: { type: "object", properties: { afterSeq: { type: "integer", minimum: 0 }, messageId: { type: ["string", "null"], format: "uuid" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["cursor", "events"], properties: { cursor: { type: "integer", minimum: 0 }, events }, additionalProperties: false } },
    { name: "daemon_status", description: "Read redacted daemon health and event cursor.", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", required: daemonRequired, properties: daemonProperties, additionalProperties: false } }
  ];
  if (extensions.includes("milestone")) tools.push(...milestoneTools(uuid));
  if (extensions.includes("code-review")) tools.push(...codeReviewTools(uuid, alias));
  if (admin) tools.push({ name: "daemon_shutdown", description: "Stop the local daemon. Available only when it was started in admin mode.", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", required: ["shuttingDown"], properties: { shuttingDown: { type: "boolean" } }, additionalProperties: false } });
  return tools;
}

function milestoneTools(uuid) {
  const hash = { type: "string", pattern: "^[0-9a-f]{64}$" }; const nullableUuid = { type: ["string", "null"], format: "uuid" };
  const milestoneEvent = { type: "object", required: ["seq", "type", "at"], properties: { seq: { type: "integer", minimum: 1 }, type: { type: "string", pattern: "^milestone_" }, at: { type: "string", format: "date-time" }, completionMessageId: uuid, incomingCompletionMessageId: uuid, attemptId: uuid, incomingAttemptId: uuid, milestoneId: { type: "string" }, instructionId: uuid, threadId: uuid, payloadHash: hash, ackMessageId: uuid, ackTransportMessageId: uuid, ackSubscriptionId: uuid, reason: { type: "string" }, status: { type: "string" }, evidence: { type: "string" } }, additionalProperties: false };
  const payload = { type: "object", required: ["instruction_id", "attempt_id", "milestone_id", "files", "tests", "blockers", "last_signal_at"], properties: { instruction_id: uuid, attempt_id: uuid, milestone_id: { type: "string" }, manifest_hash: hash, plan_hash: hash, preview_url: { type: ["string", "null"] }, files: { type: "array", items: { type: "string" } }, tests: { type: "array", items: { type: "object", required: ["command", "scope", "pass", "fail", "skip"], properties: { command: { type: "string" }, scope: { type: "string" }, pass: { type: "integer", minimum: 0 }, fail: { type: "integer", minimum: 0 }, skip: { type: "integer", minimum: 0 } }, additionalProperties: false } }, blockers: { type: "array", items: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } }, additionalProperties: false } }, last_signal_at: { type: "string", format: "date-time" } }, additionalProperties: false };
  const completion = { type: "object", required: ["completionMessageId", "attemptId", "milestoneId", "instructionId", "threadId", "payloadHash", "payload"], properties: { completionMessageId: uuid, attemptId: uuid, milestoneId: { type: "string" }, instructionId: uuid, threadId: uuid, payloadHash: hash, payload }, additionalProperties: false };
  const ack = { type: ["object", "null"], properties: { messageId: uuid, transportMessageId: nullableUuid, subscriptionId: nullableUuid }, additionalProperties: false };
  const view = { type: "object", required: ["found", "complete", "state", "cursor"], properties: { found: { type: "boolean" }, complete: { type: "boolean" }, state: { type: "string" }, cursor: { type: "integer", minimum: 0 }, completion, ack, lastEvent: milestoneEvent, alreadyDelivered: { type: "boolean" }, alreadyRecovered: { type: "boolean" } }, additionalProperties: false };
  return [
    { name: "milestone_status", description: "Read one durable milestone completion and ACK state.", inputSchema: { type: "object", properties: { completionMessageId: nullableUuid, attemptId: nullableUuid }, additionalProperties: false }, outputSchema: view },
    { name: "milestone_list", description: "List accepted milestone completions after a durable cursor.", inputSchema: { type: "object", properties: { afterSeq: { type: "integer", minimum: 0 }, milestoneId: { type: ["string", "null"] }, attemptId: nullableUuid }, additionalProperties: false }, outputSchema: { type: "object", required: ["cursor", "milestones"], properties: { cursor: { type: "integer", minimum: 0 }, milestones: { type: "array", items: view } }, additionalProperties: false } },
    { name: "milestone_wait", description: "Wait for milestone ledger changes without waking or retrying a peer.", inputSchema: { type: "object", properties: { afterSeq: { type: "integer", minimum: 0 }, completionMessageId: nullableUuid, attemptId: nullableUuid, timeoutMs: { type: "integer", minimum: 1, maximum: 300000 } }, additionalProperties: false }, outputSchema: { type: "object", required: ["cursor", "events", "milestone"], properties: { cursor: { type: "integer", minimum: 0 }, events: { type: "array", items: milestoneEvent }, milestone: { anyOf: [view, { type: "null" }] }, timedOut: { type: "boolean" } }, additionalProperties: false } },
    { name: "milestone_recover_ack", description: "Explicitly open at most one recovery transport for an undelivered milestone ACK.", inputSchema: { type: "object", required: ["completionMessageId", "payloadHash"], properties: { completionMessageId: uuid, payloadHash: hash }, additionalProperties: false }, outputSchema: view }
  ];
}

function codeReviewTools(uuid, alias) {
  const hash = { type: "string", pattern: "^[0-9a-f]{64}$" }; const nullableUuid = { type: ["string", "null"], format: "uuid" }; const text = (max) => ({ type: "string", minLength: 1, maxLength: max }); const targetKind = { type: "string", enum: ["design", "implementation"] }; const verdict = { type: "string", enum: ["pass", "fail"] };
  const hashBoundVerdict = { anyOf: [{ not: { required: ["verdict"] } }, { required: ["artifactHash"] }] };
  const codeReviewEvent = { type: "object", required: ["seq", "type", "at"], properties: { seq: { type: "integer", minimum: 1 }, type: { type: "string", pattern: "^code_review_" }, at: { type: "string", format: "date-time" }, reviewId: uuid, round: { type: "integer", minimum: 1 }, requestMessageId: uuid, receiptMessageId: uuid, incomingReceiptMessageId: uuid, existingReceiptMessageId: uuid, threadId: uuid, targetKind, artifactHash: hash, incomingArtifactHash: hash, payloadHash: hash, incomingPayloadHash: hash, existingPayloadHash: hash, transportMessageId: uuid, subscriptionId: uuid, verdict, reason: { type: "string" } }, additionalProperties: false, allOf: [hashBoundVerdict] };
  const requestPayload = { type: "object", required: ["review_id", "target_kind", "artifact_hash", "scope", "non_goals", "evidence"], properties: { review_id: uuid, target_kind: targetKind, artifact_hash: hash, scope: { type: "array", items: { type: "string" } }, non_goals: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "object", required: ["command", "summary"], properties: { command: { type: "string" }, summary: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false };
  const receiptPayload = { type: "object", required: ["review_id", "verdict", "review_thread_id", "rounds", "reviewed_at", "artifact_hash", "mandatory_changes", "unresolved"], properties: { review_id: uuid, verdict, review_thread_id: { type: "string" }, rounds: { type: "integer", minimum: 1 }, reviewed_at: { type: "string", format: "date-time" }, artifact_hash: hash, mandatory_changes: { type: "array", items: { type: "object", required: ["location", "message"], properties: { location: { type: "string" }, message: { type: "string" } }, additionalProperties: false } }, unresolved: { type: "array", items: { type: "object", required: ["topic", "message"], properties: { topic: { type: "string" }, message: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false };
  const review = { type: "object", required: ["reviewId", "round", "requestMessageId", "threadId", "alias", "targetKind", "artifactHash", "payloadHash", "payload"], properties: { reviewId: uuid, round: { type: "integer", minimum: 1 }, requestMessageId: uuid, threadId: uuid, alias: { type: "string" }, targetKind, artifactHash: hash, payloadHash: hash, payload: requestPayload }, additionalProperties: false };
  const request = { type: "object", required: ["messageId", "transportMessageId", "subscriptionId", "delivery"], properties: { messageId: uuid, transportMessageId: nullableUuid, subscriptionId: nullableUuid, delivery: { type: "string", enum: ["unsent", "reserved", "failed", "written", "delivered", "terminal"] } }, additionalProperties: false };
  const receipt = { type: ["object", "null"], required: ["receiptMessageId", "verdict", "reviewThreadId", "rounds", "reviewedAt", "artifactHash", "payloadHash", "payload"], properties: { receiptMessageId: uuid, verdict, reviewThreadId: { type: "string" }, rounds: { type: "integer", minimum: 1 }, reviewedAt: { type: "string", format: "date-time" }, artifactHash: hash, payloadHash: hash, payload: receiptPayload }, additionalProperties: false };
  const history = { type: "array", items: { type: "object", required: ["round", "requestMessageId", "artifactHash", "verdict", "receiptMessageId", "stale"], properties: { round: { type: "integer", minimum: 1 }, requestMessageId: uuid, artifactHash: hash, verdict: { type: ["string", "null"], enum: ["pass", "fail", null] }, receiptMessageId: nullableUuid, stale: { type: "boolean" } }, additionalProperties: false } };
  const view = { type: "object", required: ["found", "passed", "state", "cursor"], properties: { found: { type: "boolean" }, passed: { type: "boolean" }, state: { type: "string", enum: ["not_found", "awaiting_receipt", "passed", "failed", "superseded"] }, stale: { type: "boolean" }, cursor: { type: "integer", minimum: 0 }, review, request, receipt, history, lastEvent: codeReviewEvent, replay: { type: "boolean" } }, additionalProperties: false };
  const evidence = { type: "array", maxItems: 16, items: { type: "object", required: ["command", "summary"], properties: { command: text(512), summary: text(1024) }, additionalProperties: false } };
  return [
    { name: "code_review_status", description: "Read one durable code review round and the receipt bound to its artifact hash.", inputSchema: { type: "object", properties: { reviewId: nullableUuid, requestMessageId: nullableUuid }, additionalProperties: false }, outputSchema: view },
    { name: "code_review_list", description: "List code review rounds after a durable cursor.", inputSchema: { type: "object", properties: { afterSeq: { type: "integer", minimum: 0 }, reviewId: nullableUuid }, additionalProperties: false }, outputSchema: { type: "object", required: ["cursor", "rounds"], properties: { cursor: { type: "integer", minimum: 0 }, rounds: { type: "array", items: view } }, additionalProperties: false } },
    { name: "code_review_wait", description: "Wait for code review ledger changes without waking or retrying a peer.", inputSchema: { type: "object", properties: { afterSeq: { type: "integer", minimum: 0 }, reviewId: nullableUuid, requestMessageId: nullableUuid, timeoutMs: { type: "integer", minimum: 1, maximum: 300000 } }, additionalProperties: false }, outputSchema: { type: "object", required: ["cursor", "events", "review"], properties: { cursor: { type: "integer", minimum: 0 }, events: { type: "array", items: codeReviewEvent }, review: { anyOf: [view, { type: "null" }] }, timedOut: { type: "boolean" } }, additionalProperties: false } },
    { name: "code_review_request", description: "Send one idempotent review request bound to an artifact hash. A failure is never retried automatically.", inputSchema: { type: "object", required: ["alias", "reviewId", "requestMessageId", "threadId", "targetKind", "artifactHash", "scope", "nonGoals", "evidence"], properties: { alias, reviewId: uuid, requestMessageId: uuid, threadId: uuid, targetKind, artifactHash: hash, scope: { type: "array", minItems: 1, maxItems: 32, items: text(256) }, nonGoals: { type: "array", maxItems: 32, items: text(256) }, evidence }, additionalProperties: false }, outputSchema: view }
  ];
}
