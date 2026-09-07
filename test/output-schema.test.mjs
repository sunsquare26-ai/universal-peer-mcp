import { expect, test } from "bun:test";
import crypto from "node:crypto";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { validateSchema } from "../src/mcp/schema-validator.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";

// A standard MCP client validates every advertised outputSchema before it will offer the tool.
// mcporter 0.12.3 refused all six core tools and listed them as unavailable, because every
// outputSchema was an `anyOf` wrapper with no `type` at its root. outputSchema describes the
// structuredContent of a successful call; a tool failure is reported with isError and content,
// not as a branch of the output schema. These tests hold both halves at once: the declaration
// stays an object schema that does not admit the failure shape, and the failure shape itself,
// and the projection that redacts a result, stay exactly what they were.

const EVERY_TOOL = { admin: true, extensions: ["code-review", "milestone"], requestedExtensions: ["code-review", "milestone"] };
const FAILURE = { reason: "target_unavailable" };

function facadeFor(callTool, options = EVERY_TOOL) { return createFacade({ tools: toolDefinitions(["review"], options), callTool }); }

async function advertised(era) {
  const facade = facadeFor(async () => ({}));
  if (era === "legacy") {
    await facade.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } } });
    return (await facade.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  }
  return (await facade.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } })).result.tools;
}

test("every advertised outputSchema is a top level object schema on both wires", async () => {
  for (const era of ["modern", "legacy"]) {
    const tools = await advertised(era);
    expect(tools.length).toBeGreaterThan(0);
    const rooted = tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => `${era} ${tool.name}: ${tool.outputSchema.type}`);
    expect(rooted.length).toBeGreaterThan(0);
    expect(rooted).toEqual(rooted.map((line) => `${line.split(":")[0]}: object`));
  }
});

test("no advertised outputSchema admits the tool failure shape", async () => {
  for (const era of ["modern", "legacy"]) {
    const accepting = (await advertised(era)).filter((tool) => tool.outputSchema !== undefined && validateSchema(tool.outputSchema, FAILURE).valid).map((tool) => `${era} ${tool.name}`);
    expect(accepting).toEqual([]);
  }
});

test("a tool failure still answers with isError, a reason and a message on both wires", async () => {
  const throwing = () => { const error = new Error("unsupported Claude peer protocol"); error.code = "TARGET_UNAVAILABLE"; return error; };
  const modern = await facadeFor(async () => { throw throwing(); }).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "peer_status", arguments: { alias: "review" } } });
  expect(modern.result.isError).toBe(true);
  expect(modern.result.structuredContent).toEqual(FAILURE);
  expect(modern.result.content).toEqual([{ type: "text", text: "대상 세션을 확인할 수 없습니다." }]);

  const legacyFacade = facadeFor(async () => { throw throwing(); });
  await legacyFacade.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  const legacy = await legacyFacade.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "peer_status", arguments: { alias: "review" } } });
  expect(legacy.result.isError).toBe(true);
  expect(legacy.result.structuredContent).toEqual(FAILURE);
  expect(legacy.result.content).toEqual([{ type: "text", text: "대상 세션을 확인할 수 없습니다." }]);
});

// peer_targets names its list, so it has an object schema to advertise like every other tool.
// Advertising it must not change the projection: the allowlist that turns a daemon record into a
// public one is the same gate that keeps a pid, a token and a socket path out of the answer.
test("peer_targets still projects its result down to the public fields", async () => {
  const raw = { targets: [{ alias: "review", connected: false, permissionMode: "bypass", expectedDisplayName: null, observedDisplayName: null, pid: 7, token: "must-not-leak", socketPath: "/must-not-leak.sock" }] };
  const modern = await facadeFor(async () => raw).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "peer_targets", arguments: {} } });
  expect(modern.result.isError).toBeUndefined();
  expect(modern.result.structuredContent).toEqual({ targets: [{ alias: "review", connected: false, permissionMode: "bypass", expectedDisplayName: null, observedDisplayName: null }] });
  expect(JSON.stringify(modern)).not.toContain("must-not-leak");
  expect(JSON.stringify(modern)).not.toContain('"pid"');
});

// The same gate, read from the other side: a daemon record that is missing a required public
// field is refused rather than published. The bare list the daemon used to answer with is one
// of those — a result that is not an object no longer satisfies the contract at all.
test("peer_targets refuses a result that does not meet its public contract", async () => {
  for (const raw of [{ targets: [{ alias: "review", connected: false, token: "must-not-leak" }] }, [{ alias: "review", connected: false, permissionMode: "bypass", expectedDisplayName: null, observedDisplayName: null, token: "must-not-leak" }]]) {
    const modern = await facadeFor(async () => raw).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "peer_targets", arguments: {} } });
    expect(modern.result.isError).toBe(true);
    expect(modern.result.structuredContent).toEqual({ reason: "invalid_public_result" });
    expect(JSON.stringify(modern)).not.toContain("must-not-leak");
  }
});

// The fault this shape closes, pinned on the wire it broke: the 2025-06-18 field is typed as an
// object and peer_targets was the one tool in this package — extensions included — that answered
// it with an array. Measured before the change as `"structuredContent":[]`.
test("no tool answers the 2025-06-18 wire with an array at the root of structuredContent", async () => {
  const results = {
    peer_targets: { targets: [] },
    peer_status: { alias: "review", connected: true, sessionId: "10000000-0000-4000-8000-000000000001", cwdMatches: true, permission: { mode: "bypass", verifiedBy: "kern_procargs2" }, observedDisplayName: null, pid: 3, procStart: "start" },
    peer_list_events: { cursor: 0, events: [] },
    daemon_status: { running: true, pid: 3, procStart: "start", admin: true, eventSeq: 0, targetCount: 0, enabledExtensions: ["code-review", "milestone"] },
    milestone_list: { cursor: 0, milestones: [] },
    code_review_list: { cursor: 0, rounds: [] }
  };
  const facade = facadeFor(async (name) => results[name]);
  await facade.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  const roots = [];
  for (const [index, name] of Object.keys(results).entries()) {
    const answer = await facade.handle({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name, arguments: name === "peer_status" ? { alias: "review" } : {} } });
    roots.push(answer.result.isError ? `${name}: refused as ${JSON.stringify(answer.result.structuredContent)}` : `${name}: ${Array.isArray(answer.result.structuredContent) ? "array" : typeof answer.result.structuredContent}`);
  }
  expect(roots).toEqual(Object.keys(results).map((name) => `${name}: object`));
});

test("peer_wait keeps its two shapes inside one object schema", async () => {
  const schema = (await advertised("modern")).find((tool) => tool.name === "peer_wait").outputSchema;
  const messageId = crypto.randomUUID();
  const event = { seq: 1, type: "peer_message_status", at: "2026-09-03T00:00:00.000Z", messageId, status: "delivered" };
  expect(schema.type).toBe("object");
  expect(validateSchema(schema, { event, events: [event] }).valid).toBeTrue();
  expect(validateSchema(schema, { timedOut: true, messageId, require: "ack", state: "waiting", events: [] }).valid).toBeTrue();
  expect(validateSchema(schema, { events: [event] }).valid).toBeFalse();
});
