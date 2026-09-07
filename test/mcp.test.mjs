import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { redactPublic } from "../src/mcp/redact.mjs";
import { validateSchema } from "../src/mcp/schema-validator.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";

const tools = toolDefinitions([], { admin: false });
const daemonStatus = { running: true, pid: 42, procStart: "start", admin: false, eventSeq: 0, targetCount: 0 };
const options = { tools, callTool: async () => daemonStatus };

describe("modern 2026-07-28", () => {
  test("advertises and projects milestone tools only when the daemon enables them", async () => {
    const enabled = toolDefinitions([], { extensions: ["milestone"], requestedExtensions: ["milestone"] });
    expect(enabled.map((tool) => tool.name)).toEqual(["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status", "milestone_status", "milestone_list", "milestone_wait", "milestone_recover_ack"]);
    const completionMessageId = crypto.randomUUID(); const attemptId = crypto.randomUUID(); const instructionId = crypto.randomUUID(); const threadId = crypto.randomUUID();
    const raw = { found: true, complete: false, state: "ack_reserved", cursor: 4, completion: { completionMessageId, attemptId, milestoneId: "M-1", instructionId, threadId, payloadHash: "a".repeat(64), payload: { instruction_id: instructionId, attempt_id: attemptId, milestone_id: "M-1", files: [], tests: [], blockers: [], last_signal_at: "2026-09-03T00:00:00Z" }, targetPid: 7, targetSocketPath: "/private.sock" }, ack: { messageId: crypto.randomUUID(), transportMessageId: crypto.randomUUID(), subscriptionId: crypto.randomUUID(), targetPid: 7 }, lastEvent: { seq: 4, type: "milestone_ack_send_reserved", at: "2026-09-03T00:00:01Z", completionMessageId, attemptId, targetPid: 7 } };
    const facade = createFacade({ tools: enabled, callTool: async () => raw });
    const response = await facade.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "milestone_status", arguments: { completionMessageId } } });
    expect(response.result.isError).toBeUndefined(); expect(response.result.structuredContent).toMatchObject({ found: true, complete: false, state: "ack_reserved" }); const bytes = JSON.stringify(response); expect(bytes).not.toContain("targetPid"); expect(bytes).not.toContain("private.sock");
  });

  test("validates discover, list, call, and unsupported-version error with the pinned official schema", async () => {
    const schemaUrl = new URL("../fixtures/mcp/official-schema-2026-07-28.json", import.meta.url);
    const source = JSON.parse(await fsp.readFile(new URL("../fixtures/mcp/schema-source.json", import.meta.url), "utf8"));
    const bytes = await fsp.readFile(schemaUrl); const schema = JSON.parse(bytes);
    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256);
    const facade = createFacade(options); const meta = modernMeta();
    const responses = [
      await facade.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
      await facade.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } }),
      await facade.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } })
    ];
    const bad = modernMeta(); bad["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
    const unsupported = await createFacade(options).handle({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: bad } });
    const jsonRpcError = await createFacade(options).handle({ jsonrpc: "2.0", id: 5, method: "missing", params: { _meta: meta } });
    for (const [definition, value] of [["DiscoverResultResponse", responses[0]], ["ListToolsResultResponse", responses[1]], ["CallToolResultResponse", responses[2]], ["UnsupportedProtocolVersionError", unsupported], ["JSONRPCErrorResponse", jsonRpcError]]) {
      expect(validateSchema(schema.$defs[definition], value, { root: schema })).toEqual({ valid: true, errors: [] });
    }
    expect(unsupported.error).toEqual({ code: -32022, message: "UnsupportedProtocolVersion", data: { requested: "2099-01-01", supported: ["2026-07-28"] } });
  });

  test("rejects invalid instances for every pinned response definition and unsupported schema assertions", async () => {
    const schema = JSON.parse(await fsp.readFile(new URL("../fixtures/mcp/official-schema-2026-07-28.json", import.meta.url), "utf8"));
    const facade = createFacade(options); const meta = modernMeta();
    const discover = await facade.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }); delete discover.result.supportedVersions;
    const list = await facade.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } }); list.result.tools[0].inputSchema = {};
    const call = await facade.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } }); call.result.resultType = 3;
    const bad = modernMeta(); bad["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
    const error = await createFacade(options).handle({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: bad } }); error.error.code = "-32022";
    const jsonRpcError = await createFacade(options).handle({ jsonrpc: "2.0", id: 5, method: "missing", params: { _meta: meta } }); jsonRpcError.error.code = "-32601";
    for (const [definition, value] of [["DiscoverResultResponse", discover], ["ListToolsResultResponse", list], ["CallToolResultResponse", call], ["UnsupportedProtocolVersionError", error], ["JSONRPCErrorResponse", jsonRpcError]]) expect(validateSchema(schema.$defs[definition], value, { root: schema }).valid).toBeFalse();
    expect(validateSchema({ type: "array", minItems: 1, maxItems: 1 }, []).valid).toBeFalse();
    expect(validateSchema({ type: "array", minItems: 1, maxItems: 1 }, [1, 2]).valid).toBeFalse();
    expect(validateSchema({ type: "string", format: "uri" }, "not a uri").valid).toBeFalse();
    expect(validateSchema({ type: "string", format: "byte" }, "***").valid).toBeFalse();
    expect(() => validateSchema({ type: "string", uniqueItems: true }, "x")).toThrow("unsupported JSON Schema keyword");
    expect(() => validateSchema({ type: "string", format: "unknown" }, "x")).toThrow("unsupported JSON Schema format");
  });

  test("discovers, lists deterministically, and calls without initialize", async () => {
    const facade = createFacade(options); const meta = modernMeta();
    const discover = await facade.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } });
    expect(discover.result.resultType).toBe("complete"); expect(discover.result.supportedVersions).toEqual(["2026-07-28"]); expect(discover.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("universal-peer-mcp");
    const first = await facade.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } });
    const second = await facade.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.result.ttlMs).toBe(0); expect(first.result.cacheScope).toBe("private"); expect(first.result.tools.map((tool) => tool.name)).toEqual(["peer_targets", "peer_status", "peer_send", "peer_wait", "peer_list_events", "daemon_status"]);
    const call = await facade.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: meta, name: "daemon_status", arguments: {} } }); expect(call.result.structuredContent.running).toBe(true);
    const serialized = JSON.stringify(call); expect(serialized).not.toContain("token"); expect(serialized).not.toContain("socketPath"); expect(serialized).not.toContain("argv");
  });

  test("enforces each advertised tool input schema before dispatch", async () => {
    let calls = 0; let seen; const facade = createFacade({ tools: toolDefinitions(["review"]), callTool: async (name, args) => { calls += 1; seen = args; return name === "peer_send" ? { replay: false, messageId: args.messageId, threadId: args.threadId, subscriptionId: crypto.randomUUID(), requestHash: "a".repeat(64), alias: args.alias, status: "written" } : daemonStatus; } });
    const meta = modernMeta(); const base = { jsonrpc: "2.0", method: "tools/call" };
    const invalid = [
      { name: "peer_status", arguments: {} },
      { name: "peer_status", arguments: { alias: 3 } },
      { name: "peer_status", arguments: { alias: "missing" } },
      { name: "peer_send", arguments: { alias: "review", messageId: "not-uuid", threadId: crypto.randomUUID(), kind: "review", body: "x" } },
      { name: "peer_send", arguments: { alias: "review", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "x", body: "x" } },
      { name: "peer_send", arguments: { alias: "review", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "1x", body: "x" } },
      { name: "peer_send", arguments: { alias: "review", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "x".repeat(65), body: "x" } },
      { name: "peer_send", arguments: { alias: "review", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "review", body: "x", recovery: true } },
      { name: "peer_wait", arguments: { messageId: crypto.randomUUID(), timeoutMs: 300001 } },
      { name: "peer_wait", arguments: { messageId: crypto.randomUUID(), timeoutMs: 0 } },
      { name: "daemon_status", arguments: { extra: true } }
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      const response = await facade.handle({ ...base, id: index + 1, params: { _meta: meta, ...invalid[index] } }); expect(response.error.code).toBe(-32602);
    }
    expect(calls).toBe(0);
    const messageId = crypto.randomUUID().toUpperCase(); const threadId = crypto.randomUUID().toUpperCase();
    const good = await facade.handle({ ...base, id: 99, params: { _meta: meta, name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
    expect(good.result.structuredContent.replay).toBe(false); expect(calls).toBe(1); expect(seen.messageId).toBe(messageId); expect(seen.threadId).toBe(threadId);
    const legacy = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => { calls += 1; return {}; } });
    await legacy.handle({ jsonrpc: "2.0", id: 100, method: "initialize", params: {} });
    expect((await legacy.handle({ jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "peer_wait", arguments: { messageId: crypto.randomUUID(), timeoutMs: 0 } } })).error.code).toBe(-32602); expect(calls).toBe(1);
    for (const extra of [{ recovery: true }, { afterReservation: "inject" }]) {
      const rejected = await legacy.handle({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "peer_send", arguments: { alias: "review", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "review", body: "x", ...extra } } });
      expect(rejected.error.code).toBe(-32602);
    }
    expect(calls).toBe(1);

    let arrayCalls = 0; const bounded = createFacade({
      tools: [{ name: "bounded", description: "test", inputSchema: { type: "object", required: ["values"], properties: { values: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } } }, additionalProperties: false } }],
      callTool: async () => { arrayCalls += 1; return {}; }
    });
    for (const values of [[], ["a", "b", "c"]]) expect((await bounded.handle({ ...base, id: `array-${values.length}`, params: { _meta: meta, name: "bounded", arguments: { values } } })).error.code).toBe(-32602);
    expect(arrayCalls).toBe(0);
  });

  test("redacts delimiter-adjacent absolute paths recursively without changing relative paths or URLs", () => {
    const repeatedUsersPath = `,${["", "", "Users", "b"].join("/")}`;
    const value = { nested: ["path:/opt/private.log", ",/var/run/private.txt", "[/tmp/private.data", "=/etc/private.conf", "'/usr/local/private'", "(/Library/private)", "//network-root/private.data", "///tmp/x.sock", "[//opt/a", repeatedUsersPath, "src/relative.mjs", "https://127.0.0.1:1234/x", "x-scheme://h/p"] };
    const bytes = JSON.stringify(redactPublic(value));
    for (const absolute of ["/opt/private.log", "/var/run/private.txt", "/tmp/private.data", "/etc/private.conf", "/usr/local/private", "/Library/private", "//network-root/private.data", "///tmp/x.sock", "[//opt/a", repeatedUsersPath]) expect(bytes).not.toContain(absolute);
    expect(bytes).toContain("src/relative.mjs"); expect(bytes).toContain("https://127.0.0.1:1234/x"); expect(bytes).toContain("x-scheme://h/p");
  });

  test("does not dispatch a hidden admin tool and redacts public result values", async () => {
    let calls = 0; const secretResult = { ...daemonStatus, token: "secret-token", key: "secret-key", apiKey: "secret-api-key", accessToken: "secret-access-token", controlToken: "secret-control-token", monkey: "kept", socketPath: `${os.homedir()}/Library/Application Support/private.sock`, argv: ["--secret"], homePath: `${os.homedir()}/private`, note: "Bearer abcdefghijklmnop", detail: "failed at /var/run/private.sock", nested: { password: "secret-password" } };
    const facade = createFacade({ tools, callTool: async () => { calls += 1; return secretResult; } });
    const hidden = await facade.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "daemon_shutdown", arguments: {} } }); expect(hidden.error.code).toBe(-32602); expect(calls).toBe(0);
    const visible = await facade.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta(), name: "daemon_status", arguments: {} } }); const bytes = JSON.stringify(visible);
    for (const secret of ["secret-token", "secret-key", "secret-api-key", "secret-access-token", "secret-control-token", "private.sock", "--secret", "secret-password", "abcdefghijklmnop", os.homedir()]) expect(bytes).not.toContain(secret);
    expect(visible.result.structuredContent).toEqual(daemonStatus);

    const messageId = crypto.randomUUID(); const threadId = crypto.randomUUID();
    const sendFacade = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => ({ replay: false, messageId, threadId, subscriptionId: crypto.randomUUID(), requestHash: "b".repeat(64), alias: "review", apiKey: "must-not-leak", status: "delivered" }) });
    const sent = await sendFacade.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: modernMeta(), name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
    expect(sent.result.structuredContent.messageId).toBe(messageId); expect(sent.result.structuredContent.threadId).toBe(threadId); expect(sent.result.structuredContent.alias).toBe("review"); expect(sent.result.structuredContent.status).toBe("delivered"); expect(JSON.stringify(sent)).not.toContain("must-not-leak");

    const malformed = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => ({ replay: false, messageId, requestHash: "c".repeat(64), apiKey: "must-not-leak", socketPath: "/var/run/private.sock" }) });
    const malformedResult = await malformed.handle({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { _meta: modernMeta(), name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
    expect(malformedResult.result.isError).toBe(true); expect(malformedResult.result.content[0].text).toBe("도구 결과가 공개 계약과 맞지 않습니다."); expect(malformedResult.result.structuredContent).toEqual({ reason: "invalid_public_result" }); expect(JSON.stringify(malformedResult)).not.toContain("must-not-leak"); expect(JSON.stringify(malformedResult)).not.toContain("private.sock");

    for (const [internalCode, internal, publicCode] of [["MESSAGE_ID_CONFLICT", "messageId reuse with different content", "message_id_conflict"], ["DELIVERY_UNCERTAIN", "send failed; delivery is uncertain and was not retried", "delivery_uncertain"], ["TARGET_UNAVAILABLE", "unsupported Claude peer protocol", "target_unavailable"]]) {
      const classified = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => { const error = new Error(internal); error.code = internalCode; throw error; } });
      const classifiedResult = await classified.handle({ jsonrpc: "2.0", id: `classified-${publicCode}`, method: "tools/call", params: { _meta: modernMeta(), name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
      expect(classifiedResult.result.isError).toBe(true); expect(classifiedResult.result.structuredContent).toEqual({ reason: publicCode }); expect(JSON.stringify(classifiedResult)).not.toContain(internal);
      const legacyClassified = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => { const error = new Error(internal); error.code = internalCode; throw error; } }); await legacyClassified.handle({ jsonrpc: "2.0", id: 40, method: "initialize", params: {} });
      const legacyClassifiedResult = await legacyClassified.handle({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
      expect(legacyClassifiedResult.result.isError).toBe(true); expect(legacyClassifiedResult.result.structuredContent).toEqual({ reason: publicCode }); expect(JSON.stringify(legacyClassifiedResult)).not.toContain(internal);
    }

    const ambiguous = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => ({ reason: "target_unavailable", replay: false }) });
    const ambiguousResult = await ambiguous.handle({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { _meta: modernMeta(), name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
    expect(ambiguousResult.result.isError).toBe(true); expect(ambiguousResult.result.structuredContent).toEqual({ reason: "invalid_public_result" });
    const strayReason = createFacade({ tools: toolDefinitions(["review"]), callTool: async () => ({ replay: false, messageId, threadId, subscriptionId: crypto.randomUUID(), requestHash: "d".repeat(64), alias: "review", status: "written", reason: "target_unavailable" }) });
    const strayReasonResult = await strayReason.handle({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { _meta: modernMeta(), name: "peer_send", arguments: { alias: "review", messageId, threadId, kind: "review", body: "x" } } });
    expect(strayReasonResult.result.isError).toBeUndefined(); expect(strayReasonResult.result.structuredContent).toMatchObject({ messageId, threadId, requestHash: "d".repeat(64), status: "written" }); expect(strayReasonResult.result.structuredContent.reason).toBeUndefined(); const strayBytes = JSON.stringify(strayReasonResult); expect(strayBytes).not.toContain('"reason"'); expect(strayBytes).not.toContain("target_unavailable");

    const legacy = createFacade({ tools, callTool: async () => secretResult }); await legacy.handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });
    const legacyBytes = JSON.stringify(await legacy.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "daemon_status", arguments: {} } }));
    for (const secret of ["secret-token", "secret-key", "secret-api-key", "secret-access-token", "secret-control-token", "private.sock", "--secret", "secret-password", "abcdefghijklmnop", os.homedir()]) expect(legacyBytes).not.toContain(secret);

    const failing = createFacade({ tools, callTool: async () => { throw new Error(`Bearer abcdefghijklmnop at /opt/run/private.sock in ${os.homedir()}`); } });
    const failedResult = await failing.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { _meta: modernMeta(), name: "daemon_status", arguments: {} } }); const failed = JSON.stringify(failedResult);
    expect(failedResult.result.structuredContent).toEqual({ reason: "internal_failure" }); expect(failedResult.result.content[0].text).toBe("로컬 도구 실행에 실패했습니다."); expect(failed).not.toContain("abcdefghijklmnop"); expect(failed).not.toContain("private.sock"); expect(failed).not.toContain(os.homedir());
    const legacyFailure = createFacade({ tools, callTool: async () => { throw new Error(`secret=abcdefghijklmnop at /opt/run/private.sock in ${os.homedir()}`); } }); await legacyFailure.handle({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
    const legacyFailedResult = await legacyFailure.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "daemon_status", arguments: {} } }); const legacyFailed = JSON.stringify(legacyFailedResult);
    expect(legacyFailedResult.result.structuredContent).toEqual({ reason: "internal_failure" }); expect(legacyFailedResult.result.content[0].text).toBe("로컬 도구 실행에 실패했습니다."); expect(legacyFailed).not.toContain("abcdefghijklmnop"); expect(legacyFailed).not.toContain("private.sock"); expect(legacyFailed).not.toContain(os.homedir());
  });

  test("projects populated success results for every remaining public tool", async () => {
    const messageId = crypto.randomUUID();
    const rawStatusEvent = { seq: 1, type: "peer_message_status", at: "2026-09-03T00:00:00.000Z", messageId, status: "delivered", evidence: "message_status", peerPid: 777, peerProcStart: "private" };
    const rawIdleEvent = { seq: 2, type: "peer_idle_notice", at: "2026-09-03T00:00:01.000Z", messageId, subscriptionId: crypto.randomUUID(), state: "idle", evidence: "idle_notice", peerPid: 777, peerProcStart: "private" };
    const statusEvent = { seq: 1, type: "peer_message_status", at: "2026-09-03T00:00:00.000Z", messageId, status: "delivered", evidence: "message_status" };
    const idleEvent = { seq: 2, type: "peer_idle_notice", at: "2026-09-03T00:00:01.000Z", messageId, subscriptionId: rawIdleEvent.subscriptionId, state: "idle", evidence: "idle_notice" };
    const results = {
      peer_targets: { targets: [{ alias: "review", connected: false, permissionMode: "bypass", expectedDisplayName: "Review", observedDisplayName: null, token: "private", socketPath: "/private.sock" }] },
      peer_status: { alias: "review", connected: true, sessionId: crypto.randomUUID(), cwdMatches: true, permission: { mode: "bypass", verifiedBy: "kern_procargs2", argv: ["private"] }, observedDisplayName: "Review", pid: 123, procStart: "start", token: "private", socketPath: "/private.sock" },
      peer_wait: { event: rawStatusEvent, events: [rawStatusEvent], evidence: "message_status" },
      peer_list_events: { cursor: 2, events: [rawStatusEvent, rawIdleEvent] },
      daemon_shutdown: { shuttingDown: true }
    };
    const expectedResults = { ...results, peer_targets: { targets: [{ alias: "review", connected: false, permissionMode: "bypass", expectedDisplayName: "Review", observedDisplayName: null }] }, peer_status: { alias: "review", connected: true, sessionId: results.peer_status.sessionId, cwdMatches: true, permission: { mode: "bypass", verifiedBy: "kern_procargs2" }, observedDisplayName: "Review", pid: 123, procStart: "start" }, peer_wait: { event: statusEvent, events: [statusEvent], evidence: "message_status" }, peer_list_events: { cursor: 2, events: [statusEvent, idleEvent] } };
    const definitions = toolDefinitions(["review"], { admin: true });
    const facade = createFacade({ tools: definitions, callTool: async (name) => results[name] });
    for (const [index, [name]] of Object.entries(results).entries()) {
      const response = await facade.handle({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { _meta: modernMeta(), name, arguments: name === "peer_status" ? { alias: "review" } : name === "peer_wait" ? { messageId } : {} } });
      expect(response.result.isError).toBeUndefined(); expect(response.result.structuredContent).toEqual(expectedResults[name]); expect(JSON.stringify(response)).not.toContain("private");
    }
    // The failure shape is not a branch of the output schema. outputSchema describes the
    // structuredContent of a successful call, and a refusal is isError with a bare reason, so
    // both halves are read here: the schema does not admit the failure, the answer still is it.
    const successSchema = definitions.find((tool) => tool.name === "peer_status").outputSchema;
    expect(successSchema.type).toBe("object");
    expect(validateSchema(successSchema, { reason: "target_unavailable" }).valid).toBeFalse();
    const unavailable = await createFacade({ tools: definitions, callTool: async () => { const error = new Error("unsupported Claude peer protocol"); error.code = "TARGET_UNAVAILABLE"; throw error; } }).handle({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { _meta: modernMeta(), name: "peer_status", arguments: { alias: "review" } } });
    expect(unavailable.result.isError).toBe(true);
    expect(unavailable.result.structuredContent).toEqual({ reason: "target_unavailable" });
    expect(Object.keys(unavailable.result.structuredContent)).toEqual(["reason"]);
  });

  test("projects evidence sequences produced by PeerCore", async () => {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-mcp-core-")); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made);
    try {
      const store = new EventStore(statePaths(root)); await store.init();
      const target = { sessionId: crypto.randomUUID(), cwd: root, permissionMode: "prompting" };
      const resolved = { ...target, pid: 777, procStart: "private-start", socketPath: "/private.sock", token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
      const core = new PeerCore({ targets: { review: target }, store, address: "uds:/tmp/sender.sock", resolver: async () => resolved, sender: async () => ({ bytesWritten: 42 }) });
      const messageId = crypto.randomUUID(); const threadId = crypto.randomUUID(); const sent = await core.send({ alias: "review", messageId, threadId, kind: "review", body: "x" });
      await core.acceptFrame({ type: "control", action: "peer_message_status", orig_msg_id: messageId, status: "delivered" }, { pid: 777, procStart: "private-start" });
      await core.acceptFrame({ type: "control", action: "peer_idle_notice", orig_msg_id: sent.subscriptionId, state: "idle" }, { pid: 777, procStart: "private-start" });
      await core.acceptFrame({ message: { content: `PEER_ACK v=1 message_id=${crypto.randomUUID()} thread_id=${threadId} reply_to=${messageId}` } }, { pid: 777, procStart: "private-start" });
      const facade = createFacade({ tools: toolDefinitions(["review"]), callTool: async (name, args) => name === "peer_wait" ? core.wait({ ...args, timeoutMs: 50 }) : core.events(args) });
      const call = (id, name, args) => facade.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: modernMeta(), name, arguments: args } });
      const sourceAck = await core.wait({ messageId, require: "ack", timeoutMs: 50 }); const sourceIdle = await core.wait({ messageId, require: "idle", timeoutMs: 50 }); const sourceList = core.events({ messageId });
      const ack = await call(50, "peer_wait", { messageId, require: "ack" }); const idle = await call(51, "peer_wait", { messageId, require: "idle" }); const listed = await call(52, "peer_list_events", { messageId });
      expect(ack.result.isError).toBeUndefined(); expect(idle.result.isError).toBeUndefined(); expect(listed.result.isError).toBeUndefined();
      expect(ack.result.structuredContent.evidence).toBe("application_ack"); expect(ack.result.structuredContent.event).toMatchObject({ seq: sourceAck.event.seq, messageId, threadId, evidence: "application_ack" });
      expect(idle.result.structuredContent.evidence).toBe("idle_notice"); expect(idle.result.structuredContent.event).toMatchObject({ seq: sourceIdle.event.seq, messageId, subscriptionId: sent.subscriptionId, state: "idle", evidence: "idle_notice" });
      expect(listed.result.structuredContent.cursor).toBe(sourceList.cursor); const listedRequested = listed.result.structuredContent.events.find((event) => event.type === "send_requested"); expect(listedRequested).toMatchObject({ messageId, threadId, seq: sourceList.events.find((event) => event.type === "send_requested").seq });
      expect(listed.result.structuredContent.events.find((event) => event.type === "peer_message_status")).toMatchObject({ messageId, status: "delivered", evidence: "message_status" });
      const bytes = JSON.stringify([ack, idle, listed]); for (const privateValue of ["peerPid", "peerProcStart", "targetPid", "targetProcStart", "private-start", "/private.sock"]) expect(bytes).not.toContain(privateValue);
    } finally { await fsp.rm(made, { recursive: true, force: true }); }
  });

  test("rejects unknown tools, malformed capabilities, and mixed eras", async () => {
    const unknown = await createFacade(options).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "missing", arguments: {} } }); expect(unknown.error.code).toBe(-32602);
    const malformed = modernMeta(); malformed["io.modelcontextprotocol/clientCapabilities"] = [];
    expect((await createFacade(options).handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: malformed } })).error.code).toBe(-32602);
    const facade = createFacade(options); await facade.handle({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: modernMeta() } });
    expect((await facade.handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} })).error.code).toBe(-32602);
    expect((await facade.handle({ jsonrpc: "2.0", id: 5, method: "notifications/initialized", params: { _meta: modernMeta() } })).error.code).toBe(-32601);
  });

  test("notifications have no response", async () => expect(await createFacade(options).handle({ jsonrpc: "2.0", method: "notice", params: { _meta: modernMeta() } })).toBeNull());

  test("runs the raw unsupported-version fixture", async () => {
    const line = (await fsp.readFile(new URL("../fixtures/mcp/version-mismatch-input.jsonl", import.meta.url), "utf8")).trim();
    const response = await createFacade(options).handle(JSON.parse(line));
    expect(response.error).toEqual({ code: -32022, message: "UnsupportedProtocolVersion", data: { requested: "2099-01-01", supported: ["2026-07-28"] } });
  });
});

describe("legacy 2025-06-18", () => {
  test("keeps initialized handling inside the legacy adapter", async () => {
    const facade = createFacade(options);
    expect((await facade.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).result.protocolVersion).toBe("2025-06-18");
    expect(await facade.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })).toBeNull();
  });
});
