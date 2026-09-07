import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { statePaths } from "../src/core/state-paths.mjs";

// The order every install actually runs in: the host registers the server, the server starts,
// and the target table is written after that. A table read once at start is empty for the whole
// life of the process, and so is every alias allowlist built from it — the tools list normally
// and not one of the calls they advertise can be made. That is the failure this file pins: the
// list has to be the table as it is when the list is asked for, and the call has to be checked
// against the same table the list was built from.
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const REPO = new URL("..", import.meta.url).pathname;
const roots = []; const servers = [];

afterEach(async () => {
  for (const child of servers.splice(0)) { try { child.kill("SIGTERM"); } catch {} }
  for (const root of roots.splice(0)) {
    try { process.kill(JSON.parse(await fsp.readFile(statePaths(root).daemon, "utf8")).pid, "SIGTERM"); } catch {}
    await Bun.sleep(30);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function target(cwd) { return { sessionId: crypto.randomUUID(), cwd, permissionMode: "prompting" }; }

async function writeTargets(file, table) {
  await fsp.writeFile(file, `${JSON.stringify(table)}\n`, { mode: 0o600 });
  await fsp.chmod(file, 0o600);
}

// One server on a private state directory of its own, spoken to the way a host speaks to it:
// one framed request at a time over stdin, one framed response read back off stdout.
async function open({ table = null, env = {} } = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-target-table-"));
  await fsp.chmod(made, 0o700);
  const root = await fsp.realpath(made); roots.push(root);
  const targetsFile = statePaths(root).targets;
  if (table) await writeTargets(targetsFile, table(root));
  const child = spawn("bun", ["src/server.mjs"], { cwd: REPO, env: { ...process.env, ...env, UNIVERSAL_PEER_MCP_STATE_DIR: root } });
  servers.push(child);
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  // A response is only a response once its newline has arrived; a half written line is not read.
  const complete = () => { const parts = stdout.split("\n"); parts.pop(); return parts.filter(Boolean); };
  let taken = 0; let id = 0;
  async function request(method, params = {}) {
    id += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: META, ...params } })}\n`);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && complete().length <= taken) await Bun.sleep(10);
    if (stderr) throw new Error(stderr);
    const rows = complete(); const row = rows[taken];
    if (!row) throw new Error(`no response to ${method}`);
    taken = rows.length;
    return JSON.parse(row);
  }
  return { root, targetsFile, request };
}

function aliasSchema(list, name) { return list.result.tools.find((tool) => tool.name === name)?.inputSchema?.properties?.alias ?? null; }
function aliasEnum(list, name) { return aliasSchema(list, name)?.enum ?? null; }

test("an alias written after the server started is advertised on the next list", async () => {
  const server = await open();
  const before = await server.request("tools/list");
  expect(aliasEnum(before, "peer_send") ?? []).not.toContain("added");
  await writeTargets(server.targetsFile, { added: target(server.root) });
  const after = await server.request("tools/list");
  expect(aliasEnum(after, "peer_send")).toEqual(["added"]);
  expect(aliasEnum(after, "peer_status")).toEqual(["added"]);
});

test("a call is checked against the table the list was built from, not the one read at start", async () => {
  const server = await open();
  await server.request("tools/list");
  await writeTargets(server.targetsFile, { added: target(server.root) });
  const call = await server.request("tools/call", { name: "peer_status", arguments: { alias: "added" } });
  // The call is dispatched instead of being refused as malformed parameters, which is what this
  // file is about. It still fails, because the daemon holds its own start-time copy of the table
  // (src/daemon.mjs) and that copy is empty: the two tables are compared by content before the
  // call is passed on, and a call naming an alias the daemon has never seen is refused rather
  // than sent somewhere else (test/target-table-identity.test.mjs).
  expect(call.error).toBeUndefined();
  expect(call.result.isError).toBeTrue();
  expect(call.result.structuredContent).toEqual({ reason: "target_unavailable" });
});

test("an alias removed after the server started stops being advertised and stops being callable", async () => {
  const server = await open({ table: (root) => ({ alpha: target(root), beta: target(root) }) });
  const before = await server.request("tools/list");
  expect(aliasEnum(before, "peer_send")).toEqual(["alpha", "beta"]);
  await writeTargets(server.targetsFile, { alpha: target(server.root) });
  const after = await server.request("tools/list");
  expect(aliasEnum(after, "peer_send")).toEqual(["alpha"]);
  expect(aliasEnum(after, "peer_status")).toEqual(["alpha"]);
  const call = await server.request("tools/call", { name: "peer_status", arguments: { alias: "beta" } });
  expect(call.error).toEqual({ code: -32602, message: "invalid tools/call parameters" });
});

test("with no target table the call says the table is empty instead of failing schema validation", async () => {
  const server = await open();
  const list = await server.request("tools/list");
  // Nothing to allow is not the same as a list of nothing: an empty enum is a schema no caller
  // can satisfy, and the refusal it produces names the parameters rather than the table.
  expect(aliasEnum(list, "peer_send")).toBeNull();
  expect(aliasSchema(list, "peer_send").description).toMatch(/target table/i);
  expect(aliasSchema(list, "peer_status").description).toMatch(/target table/i);
  const status = await server.request("tools/call", { name: "peer_status", arguments: { alias: "nobody" } });
  expect(status.error).toBeUndefined();
  expect(status.result.isError).toBeTrue();
  expect(status.result.structuredContent).toEqual({ reason: "target_unavailable" });
  expect(status.result.content[0].text).toContain("대상");
  const send = await server.request("tools/call", { name: "peer_send", arguments: { alias: "nobody", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "work", body: "nothing to send this to" } });
  expect(send.error).toBeUndefined();
  expect(send.result.isError).toBeTrue();
  expect(send.result.structuredContent).toEqual({ reason: "target_unavailable" });
  // and the refusal is ahead of the daemon: no reservation, no event, nothing written.
  const events = await server.request("tools/call", { name: "peer_list_events", arguments: {} });
  expect(events.result.structuredContent.events).toEqual([]);
});

test("a table that cannot be read allowlists nothing and refuses the calls it used to allow", async () => {
  const server = await open({ table: (root) => ({ alpha: target(root) }) });
  expect(aliasEnum(await server.request("tools/list"), "peer_send")).toEqual(["alpha"]);

  // "I could not read it" is not "there is nothing in it", and it is not "it is still what I read
  // last time" either. A torn write, a file that has stopped being ours, a mode that changed:
  // none of them is evidence about the table on disk now, and holding the last good copy over
  // them is what let a call be checked against a table this process could no longer see and
  // answered "allowed" out of a copy. So a read that failed retires every alias until one
  // succeeds.
  await fsp.writeFile(server.targetsFile, "{ this is not a table", { mode: 0o600 });
  expect(aliasEnum(await server.request("tools/list"), "peer_send")).toBeNull();
  const refused = await server.request("tools/call", { name: "peer_status", arguments: { alias: "alpha" } });
  expect(refused.error).toBeUndefined();
  expect(refused.result.isError).toBeTrue();
  expect(refused.result.structuredContent).toEqual({ reason: "target_unavailable" });
  // and the refusal is ahead of the daemon: nothing reserved, nothing written.
  expect((await server.request("tools/call", { name: "peer_list_events", arguments: {} })).result.structuredContent.events).toEqual([]);

  // a table that is gone is a table with nothing in it, which is the same allowlist by another
  // route; a table that can be read again is read again, so the refusal is not sticky.
  await fsp.rm(server.targetsFile);
  expect(aliasEnum(await server.request("tools/list"), "peer_send")).toBeNull();
  await writeTargets(server.targetsFile, { alpha: target(server.root) });
  expect(aliasEnum(await server.request("tools/list"), "peer_send")).toEqual(["alpha"]);
});

// The two numbers an operator reads side by side when nothing works. They come from two reads of
// one file at two times — the daemon's, taken when it started, and this server's, taken for this
// request — so they can differ, and the whole point of carrying both is that the difference is
// legible instead of being an empty allowlist next to a count that says there is a target.
// The count answers "as many rows"; `targetTableMismatch` answers "the same rows", and only the
// second one refuses calls. Two tables that differ in content but not in size are in
// test/target-table-identity.test.mjs.
test("the daemon count and the advertised allowlist are one number, or the answer says they are two", async () => {
  const together = await open({ table: (root) => ({ alpha: target(root) }) });
  const list = await together.request("tools/list");
  const status = (await together.request("tools/call", { name: "daemon_status", arguments: {} })).result.structuredContent;
  expect(status.targetCount).toBe(1);
  expect(status.advertisedTargetCount).toBe(status.targetCount);
  expect(aliasEnum(list, "peer_send")).toHaveLength(status.advertisedTargetCount);
  expect(status.targetCountMismatch).toBeFalse();
  expect(status.targetTableMismatch).toBeFalse();

  // the first request is what makes the daemon's copy the empty one: it is only certain to have
  // started, and to have read the table, once an answer has come back through it.
  const apart = await open();
  await apart.request("tools/list");
  await writeTargets(apart.targetsFile, { added: target(apart.root) });
  const laterList = await apart.request("tools/list");
  const later = (await apart.request("tools/call", { name: "daemon_status", arguments: {} })).result.structuredContent;
  expect(aliasEnum(laterList, "peer_send")).toEqual(["added"]);
  expect(aliasEnum(laterList, "peer_send")).toHaveLength(later.advertisedTargetCount);
  expect(later.targetCount).toBe(0);
  expect(later.targetCountMismatch).toBeTrue();
  expect(later.targetTableMismatch).toBeTrue();
});
