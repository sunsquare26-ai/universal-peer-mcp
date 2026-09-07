import { controlCall, ensureDaemon } from "./core/control.mjs";
import { statePaths } from "./core/state-paths.mjs";
import { createFacade } from "./mcp/facade.mjs";
import { toolDefinitions } from "./mcp/tools.mjs";
import { loadTargets, targetTableDigest } from "./core/target-config.mjs";

const paths = statePaths();
await ensureDaemon();
const daemon = await controlCall("daemon_status");
const admin = daemon.admin === true;
const enabledExtensions = Array.isArray(daemon.enabledExtensions) ? daemon.enabledExtensions : [];
const requestedExtensions = parseExtensions(process.env.CLAUDE_PEER_MCP_EXTENSIONS);

// A host registers this server first and the target table is written after that, which is the
// order every install runs in. A table read once here is therefore the empty one for the whole
// life of the process, and so is every alias allowlist built from it: the tools list normally
// and not one of the calls they advertise can be made. So the table is read per request, and the
// tools that request is answered with and the aliases its call is checked against are that one
// read.
// A table that is gone is a table with nothing in it. Anything else is "I could not read it" —
// a torn write, a file this process may not open, a mode that changed — and that is neither a
// removal nor a reading. The last table that was read used to stand in its place, and standing in
// its place is what let a call be checked against a table this process could no longer see and
// answered "allowed" out of a copy: the aliases were advertised, the digest still matched the
// daemon's, and nothing in the answer said the file behind them had not been read. So a failed
// read allowlists nothing until a read succeeds, and it is kept apart from an empty table so the
// refusal can name which of the two it was. Only an ENOENT naming the table itself is an absence
// — an ENOENT naming a target's directory is not, and reading it as one would silently empty a
// table that is on disk and populated.
let reading = { table: {}, unreadable: null };
async function targetTable() {
  try { reading = { table: await loadTargets(paths.targets), unreadable: null }; }
  catch (error) { reading = { table: {}, unreadable: error?.code === "ENOENT" && error.path === paths.targets ? null : error }; }
  return reading;
}

// Frames are dispatched as they arrive and each answer is written when it is ready, so two
// requests that read nothing but the table can answer in either order: measured 2026-09-07,
// server/discover and tools/list against one empty table came back reversed in 2 of 6 runs,
// because two reads of the same file are not guaranteed to finish in the order they were
// started. Nothing in JSON-RPC forbids that and everything downstream correlates by id, but a
// transcript recorded byte for byte is recorded in arrival order, and a wire whose transcript
// depends on how the filesystem scheduled two reads cannot be compared against a recorded one.
// So the reads are put back in arrival order — the façade asks for one request's table at a
// time — and only the reads: a call that then waits on the daemon still answers whenever it
// answers, so a 300 s peer_wait holds nothing else up.
let reads = Promise.resolve();
function orderedTable() {
  const next = reads.then(targetTable);
  reads = next.then(() => {}, () => {});
  return next;
}

const facade = createFacade(async () => {
  const reading = await orderedTable();
  return { tools: toolDefinitions(Object.keys(reading.table), { admin, extensions: enabledExtensions, requestedExtensions }), callTool: (name, args) => callTool(reading, name, args) };
});

// A call that names no alias can still reach a target. A milestone ACK recovery is aimed by the
// identity the ledger recorded when the completion arrived, so there is no alias here to hold
// against the allowlist — and a binding made when the completion arrived is not a licence the
// operator can no longer withdraw. It goes through the same checkpoint as a call that names a
// name; what the checkpoint asks of it is the second half, the one about the table rather than
// the alias, and the alias it does aim at is checked by the daemon against that same table
// (src/extensions/milestone/index.mjs).
const REACHES_A_TARGET_UNNAMED = new Set(["milestone_recover_ack"]);

async function callTool(reading, name, args) {
  const { table, unreadable } = reading;
  const aliases = Object.keys(table);
  const digest = targetTableDigest(table);
  let checkedBinding = null;
  if (typeof args?.alias === "string" || REACHES_A_TARGET_UNNAMED.has(name)) {
    // No reading, no target. A read that failed is not a table with nothing in it and is not the
    // last table either, and the refusal says which of the two this is.
    if (unreadable) throw targetTableUnreadable();
    // The allowlist is enforced here as well as advertised, against the same read the tools list
    // was built from. With nothing in the table there is no enum to advertise and nothing to
    // allow, so this is what refuses the call — ahead of the daemon, so an empty table reserves
    // nothing and writes nothing — and the refusal carries the reason for the missing target
    // rather than a complaint about the caller's parameters.
    if (typeof args?.alias === "string" && !aliases.includes(args.alias)) throw targetUnavailable(aliases.length === 0);
    // An alias is a name for a row, and the daemon holds its own copy of that row from the
    // moment it started. Two readings agreeing on how many rows there are said nothing about
    // whether they are the same rows: repoint one alias at another session and the count is
    // unchanged, the alias is still allowlisted, and the message went to the session the
    // operator had just taken it off — with `targetCountMismatch: false` in the answer. So the
    // digest of the row this call was checked against is compared with the digest of the table
    // the daemon would send it with, and a disagreement stops the call here rather than
    // delivering it somewhere the caller did not name. It is read for this call and not cached:
    // a daemon that died and was replaced between two calls is holding a different table, and
    // the reading that matters is the one taken next to the send.
    const checked = await controlCall("daemon_status");
    if (checked.targetsDigest !== digest) throw staleTargetTable();
    // This comparison is a reading, and a reading goes out of date the moment it is made: the
    // daemon can be replaced and the file rewritten between the answer above and the request
    // below, which are two requests and were never one. So the command carries what was checked
    // — this daemon, this table — and is refused unless both still hold when it lands
    // (src/daemon.mjs). The refusal above is the one that names the reason; this is the one that
    // makes it a guarantee rather than a hope about timing.
    checkedBinding = { daemonPid: checked.pid, daemonProcStart: checked.procStart, targetsDigest: digest };
  }
  const result = await controlCall(name, args, { expect: checkedBinding });
  if (name !== "daemon_status") return result;
  const advertisedTargetCount = aliases.length;
  const counts = { advertisedTargetCount, targetCountMismatch: result.targetCount !== advertisedTargetCount, targetTableMismatch: result.targetsDigest !== digest };
  const extensionMismatch = JSON.stringify(requestedExtensions) !== JSON.stringify(enabledExtensions);
  if (!extensionMismatch && requestedExtensions.length === 0) return { ...result, ...counts };
  return { ...result, ...counts, requestedExtensions, extensionMismatch };
}

// The message stays here: what is published is the code, mapped to one of the reasons the
// façade already answers with (src/mcp/redact.mjs).
function targetUnavailable(empty) {
  const error = new Error(empty ? "the target table is empty; no alias is allowlisted" : "target alias is not allowlisted");
  error.code = "TARGET_UNAVAILABLE";
  return error;
}

// Same code as any other unreachable target, and deliberately: from the caller's side the target
// it named is not one this connection can reach, which is what that code says. Which of the two
// it was is in `daemon_status` — `targetTableMismatch` is true for exactly as long as this
// refusal stands, and it is false again once the daemon has been restarted on the current file.
function staleTargetTable() {
  const error = new Error("the running daemon holds a different target table than this call was checked against; restart the daemon");
  error.code = "TARGET_UNAVAILABLE";
  return error;
}

// And the same code again, for the third way a target can fail to be reachable: the table that
// would say whether it is reachable could not be read. `daemon_status` is what separates the
// three — it answers while this refusal stands, and `targetTableMismatch` is true for as long as
// there is no reading behind the allowlist.
function targetTableUnreadable() {
  const error = new Error("the target table could not be read; no alias is allowlisted until it can be");
  error.code = "TARGET_UNAVAILABLE";
  return error;
}
export const MAX_STDIN_FRAME_BYTES = 1024 * 1024;
let buffer = Buffer.alloc(0); let discardingFrame = false;
process.stdin.on("data", (chunk) => {
  let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (discardingFrame) {
    const newline = incoming.indexOf(0x0a);
    if (newline < 0) return;
    discardingFrame = false; incoming = incoming.subarray(newline + 1);
  }
  buffer = Buffer.concat([buffer, incoming]);
  while (true) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    const frame = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
    if (frame.byteLength > MAX_STDIN_FRAME_BYTES) { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "frame too large" } }); continue; }
    const line = frame.toString("utf8"); if (!line.trim()) continue; void handle(line);
  }
  if (buffer.byteLength > MAX_STDIN_FRAME_BYTES) {
    buffer = Buffer.alloc(0); discardingFrame = true;
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "frame too large" } });
  }
});
async function handle(line) { let request; try { request = JSON.parse(line); } catch { return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); } const response = await facade.handle(request); if (response !== null) write(response); }
function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function parseExtensions(value) { if (!value) return []; const names = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort(); return names.filter((name) => ["code-review", "milestone"].includes(name)); }
