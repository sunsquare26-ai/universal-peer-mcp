import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseMarker, senderEnvelope } from "../src/adapters/claude-native-v1/protocol.mjs";
import { EventStore } from "../src/core/events.mjs";
import { PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { validateSchema } from "../src/mcp/schema-validator.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";
import { redactPublic } from "../src/mcp/redact.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const FIXTURE_UUID = /^10000000-0000-4000-8000-[0-9a-f]{12}$/;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const fixture = JSON.parse(await fsp.readFile(path.join(ROOT, "fixtures/demo-ack/session.json"), "utf8"));
const demo = await fsp.readFile(path.join(ROOT, "docs/demo-ack.md"), "utf8");

function firstLine(prefix) { return demo.split("\n").find((line) => line.startsWith(prefix)); }

test("the envelope wrapper refuses an address it cannot recognise, and carries no mode at all", () => {
  expect(() => senderEnvelope({ from: "/path/to/state/universal-peer-mcp.sock", body: "x" })).toThrow("invalid sender address");
  // A mode handed to the wrapper is not honoured, corrected or rejected — there is no parameter
  // for it. The wire form is the same whatever the caller believes about anyone's permissions.
  const bare = senderEnvelope({ from: fixture.senderAddress, body: "x" });
  expect(senderEnvelope({ from: fixture.senderAddress, body: "x", permission: { mode: "bypass", verifiedBy: "kern_procargs2" }, permissionMode: "root" })).toBe(bare);
  for (const attribute of ["from-mode=", "from-mode-verified-by=", "from_mode"]) expect(bare).not.toContain(attribute);
});

test("the demo ACK line parses with the shipped marker parser", () => {
  const line = firstLine("PEER_ACK ");
  expect(typeof line).toBe("string");
  expect(parseMarker(line)).toEqual({ type: "ack", messageId: fixture.ack.messageId, threadId: fixture.threadId, replyTo: fixture.request.messageId, verdict: null });
});

test("the demo REPLY line parses with the shipped marker parser", () => {
  const line = firstLine("PEER_REPLY ");
  expect(typeof line).toBe("string");
  expect(parseMarker(line)).toEqual({ type: "reply", messageId: fixture.reply.messageId, threadId: fixture.threadId, replyTo: fixture.request.messageId, verdict: fixture.reply.verdict });
});

test("an ACK carrying a verdict is still refused, as the demo says", () => {
  expect(parseMarker(`${firstLine("PEER_ACK ")} verdict=pass`)).toBe(null);
});

test("the demo peer_send arguments validate against the published tool schema", () => {
  const send = toolDefinitions([fixture.alias]).find((tool) => tool.name === "peer_send");
  const args = { alias: fixture.alias, messageId: fixture.request.messageId, threadId: fixture.threadId, kind: fixture.request.kind, body: fixture.request.body };
  expect(validateSchema(send.inputSchema, args)).toEqual({ valid: true, errors: [] });
  expect(demo).toContain(JSON.stringify(args, null, 2));
});

test("every identifier in the demo is inside the fixture band", () => {
  const found = demo.match(UUID) ?? [];
  expect(found.length).toBeGreaterThan(0);
  expect(found.filter((value) => !FIXTURE_UUID.test(value))).toEqual([]);
  for (const value of [fixture.threadId, fixture.request.messageId, fixture.ack.messageId, fixture.reply.messageId, fixture.subscriptionId]) expect(FIXTURE_UUID.test(value)).toBe(true);
});

test("the demo carries no home path and names no real socket", () => {
  expect(demo).not.toContain(os.homedir());
  expect(demo).not.toMatch(/\/Users\//);
  expect(fixture.senderAddress.startsWith("uds:/path/to/")).toBe(true);
});

test("redaction removes what an unsanitized capture of the same round trip would carry", () => {
  const home = os.homedir();
  const unsafe = {
    alias: fixture.alias,
    socketPath: `${home}/Library/Application Support/universal-peer-mcp/control.sock`,
    controlToken: "f".repeat(64),
    envelope: senderEnvelope({ from: `uds:${home}/Library/state/universal-peer-mcp.sock`, body: `Bearer ${"a".repeat(24)} at ${home}/project`, permission: { mode: "prompting", verifiedBy: "kern_procargs2" } }),
    note: `failed at ${home}/project with sk-${"A".repeat(24)}`
  };
  const clean = redactPublic(unsafe);
  const serialized = JSON.stringify(clean);
  expect(serialized).not.toContain(home);
  expect(serialized).not.toContain(".sock");
  expect(serialized).not.toContain("aaaaaaaa");
  expect(serialized).not.toContain("AAAAAAAA");
  expect(clean.socketPath).toBeUndefined();
  expect(clean.controlToken).toBeUndefined();
  expect(clean.alias).toBe(fixture.alias);
  expect(clean.note).toContain("[credential]");
  expect(clean.note).toContain("[path]");
});

// The demo is only worth shipping if it is the software's own output. Everything below drives
// the real core, the real façade and the real marker parser, then compares against the page.
const README = await fsp.readFile(path.join(ROOT, "README.md"), "utf8");
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

async function liveCore() {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-demo-")); roots.push(made);
  await fsp.chmod(made, 0o700);
  const root = await fsp.realpath(made);
  const store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: "10000000-0000-4000-8000-000000000012", cwd: root, permissionMode: fixture.permissionMode };
  const resolved = { ...target, pid: 99, procStart: "start", socketPath: "/tmp/fake.sock", token: "1".repeat(32), permission: { mode: fixture.permissionMode, verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const frames = [];
  const core = new PeerCore({ targets: { [fixture.alias]: target }, store, address: fixture.senderAddress, resolver: async () => resolved, sender: async (_target, sent) => { frames.push(...sent); return { bytesWritten: 1 }; } });
  return { core, store, frames, peer: { pid: 99, procStart: "start" } };
}

function documentedCalls(markdown) {
  const found = [];
  for (const block of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    let value = null;
    try { value = JSON.parse(block[1]); } catch { continue; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const keys = Object.keys(value);
    if (!keys.includes("messageId")) continue;
    found.push({ tool: keys.includes("body") ? "peer_send" : "peer_wait", args: value });
  }
  return found;
}

const documented = [...documentedCalls(README), ...documentedCalls(demo)];

test("the documented calls are the ones a reader would copy, and there are some of each", () => {
  expect(documented.filter((call) => call.tool === "peer_send").length).toBeGreaterThan(0);
  expect(documented.filter((call) => call.tool === "peer_wait").length).toBeGreaterThan(0);
});

test("every documented tool call is accepted by the published input schema", () => {
  const tools = toolDefinitions([fixture.alias]);
  const rejected = [];
  for (const { tool, args } of documented) {
    const result = validateSchema(tools.find((entry) => entry.name === tool).inputSchema, args);
    if (!result.valid) rejected.push(`${tool}: ${result.errors.join("; ")}`);
  }
  expect(rejected).toEqual([]);
});

test("every documented tool call reaches dispatch instead of an invalid params error", async () => {
  const dispatched = [];
  const facade = createFacade({
    tools: toolDefinitions([fixture.alias]),
    callTool: async (name, args) => {
      dispatched.push(name);
      return name === "peer_send"
        ? { replay: false, messageId: args.messageId, requestHash: "0".repeat(64), status: "written" }
        : { timedOut: true, messageId: args.messageId, require: args.require ?? "reply", state: "written", events: [] };
    }
  });
  let id = 0;
  for (const { tool, args } of documented) {
    id += 1;
    const response = await facade.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: modernMeta(), name: tool, arguments: args } });
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBeUndefined();
  }
  expect(dispatched).toEqual(documented.map((call) => call.tool));
});

test("the demo shows the bytes the shipped core really writes, canonical body included", async () => {
  const { core, frames } = await liveCore();
  const sent = await core.send({ alias: fixture.alias, messageId: fixture.request.messageId, threadId: fixture.threadId, kind: fixture.request.kind, body: fixture.request.body });
  expect(sent.status).toBe("written");
  const content = frames.find((frame) => frame.type === "user").message.content;
  expect(demo).toContain(content);
  const lines = content.split("\n");
  expect(JSON.parse(lines.slice(1, -1).join("\n"))).toEqual({
    alias: fixture.alias, messageId: fixture.request.messageId, threadId: fixture.threadId,
    replyTo: null, kind: fixture.request.kind, body: fixture.request.body
  });
});

test("the demo ACK and REPLY lines drive the shipped receive path to the documented result", async () => {
  const { core, peer } = await liveCore();
  await core.send({ alias: fixture.alias, messageId: fixture.request.messageId, threadId: fixture.threadId, kind: fixture.request.kind, body: fixture.request.body });
  await core.acceptFrame({ message: { content: firstLine("PEER_ACK ") } }, peer);
  const acked = await core.wait({ messageId: fixture.request.messageId, require: "ack", timeoutMs: 200 });
  expect(acked.event.type).toBe("peer_ack");
  expect(acked.event.responseMessageId).toBe(fixture.ack.messageId);
  await core.acceptFrame({ message: { content: demo.slice(demo.indexOf(firstLine("PEER_REPLY "))).split("```")[0] } }, peer);
  const replied = await core.wait({ messageId: fixture.request.messageId, require: "reply", timeoutMs: 200 });
  expect(replied.event.type).toBe("peer_reply");
  expect(replied.event.verdict).toBe(fixture.reply.verdict);
  expect(replied.event.responseMessageId).toBe(fixture.reply.messageId);
});
