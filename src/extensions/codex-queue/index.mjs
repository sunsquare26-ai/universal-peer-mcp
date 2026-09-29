import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPrivateFile, ensurePrivateDirectory, atomicPrivateWrite } from "../../core/state-paths.mjs";
import { DOORBELL, doorbell, queueArgv } from "../../core/doorbell.mjs";

export const codexWakeExtension = Object.freeze({ enabled: false, available: true, transport: "existing-app-server" });
const runFile = promisify(execFile);

// The installed Codex CLI owns its native queue. Never write its SQLite files.
// M3: the queue carries only the fixed doorbell (Friday docs/008 §2.1). Exactly two call values —
// a thread UUID and a doorbell — and nothing else: no body, no thread name, no extra argument.
export async function enqueueCodex(target, text, ...extra) {
  if (extra.length > 0) throw fail("INVALID_QUEUE_CALL");
  if (!UUID_LOWER.test(target?.threadId ?? "")) throw fail("INVALID_QUEUE_CALL");
  const match = DOORBELL.exec(typeof text === "string" ? text : "");
  if (!match) throw fail("INVALID_QUEUE_CALL");
  const argv = queueArgv(target.threadId, match[1]);
  const { stdout } = await runFile(target.cliPath, argv, { cwd: target.cwd, timeout: 15000, maxBuffer: 65536 });
  if (!stdout.includes(`for thread ${target.threadId}`) || !stdout.includes("Queued message")) throw fail("DELIVERY_UNCERTAIN");
}

// Version check (M3): the CLI that queues and the app-server that owns the thread must be the same
// release. A mismatch (measured 2026-09-29: CLI 0.157.0, app-server 0.159.0) stops the send.
export function versionOf(text) { const m = /(\d+\.\d+\.\d+)/.exec(typeof text === "string" ? text : ""); return m ? m[1] : null; }
export async function cliVersion(cliPath) { const { stdout } = await runFile(cliPath, ["--version"], { timeout: 10000, maxBuffer: 4096 }); return versionOf(stdout); }

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UUID_LOWER = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TARGET_KEYS = new Set(["transport", "cliPath", "threadId", "cwd", "socketPath", "codexVersion"]);
const fail = (code) => Object.assign(new Error(code), { code });

// Connect to the existing server only: websocket over its unix socket, carried by a node child
// (./transport.mjs, `ws` pinned in package.json). Measured 2026-09-29: `codex app-server proxy`
// does not answer JSON-RPC on stdio for a `--listen unix://` server, `ws` over the socket does.
// Never spawn `codex exec`, resume a stored thread into another server, or change its model,
// permissions, or effort.
export function connectAppServer(socketPath, { timeoutMs = 10000 } = {}) {
  const child = spawn("node", [fileURLToPath(new URL("./transport.mjs", import.meta.url)), socketPath], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map(); let counter = 0; let buffer = ""; let closed = false;
  function rejectAll() { closed = true; for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(fail("TARGET_UNAVAILABLE")); } pending.clear(); }
  child.on("error", rejectAll); child.on("exit", rejectAll); child.stdin.on("error", rejectAll);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { rejectAll(); child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let frame; try { frame = JSON.parse(line); } catch { rejectAll(); child.kill(); return; }
      // Leave all server-originated approvals/input requests to the owning host.
      if (frame.method) continue;
      const waiter = pending.get(frame.id); if (!waiter) continue;
      pending.delete(frame.id); clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(fail("TARGET_UNAVAILABLE")); else waiter.resolve(frame.result);
    }
  });
  return {
    call(method, params) {
      if (closed) return Promise.reject(fail("TARGET_UNAVAILABLE"));
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(fail("TARGET_UNAVAILABLE")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    notify(method) { if (!closed) child.stdin.write(JSON.stringify({ method }) + "\n"); },
    close() { rejectAll(); child.stdin.end(); child.kill(); }
  };
}

export class CodexWake {
  constructor({ root, connect = connectAppServer, enqueue = enqueueCodex, cliVersion: readCliVersion = cliVersion }) { this.root = root; this.connect = connect; this.enqueue = enqueue; this.cliVersion = readCliVersion; }
  async target(alias) {
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(alias)) throw fail("TARGET_UNAVAILABLE");
    const file = path.join(this.root, "codex-targets.json");
    await assertPrivateFile(file, { maxBytes: 65536 });
    const entry = JSON.parse(await fsp.readFile(file, "utf8"))[alias];
    if (!entry || !UUID_LOWER.test(entry.threadId) || !path.isAbsolute(entry.cwd ?? "")) throw fail("TARGET_UNAVAILABLE");
    // A target entry is identity and location only; a key that could carry permissions, model or
    // argv (sandbox, extraArgs, ...) makes the whole entry untrusted.
    if (Object.keys(entry).some((key) => !TARGET_KEYS.has(key))) throw fail("TARGET_UNAVAILABLE");
    if (entry.codexVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(entry.codexVersion)) throw fail("TARGET_UNAVAILABLE");
    if (entry.transport === "cli-queue") {
      if (!path.isAbsolute(entry.cliPath ?? "")) throw fail("TARGET_UNAVAILABLE");
      const cli = await fsp.stat(entry.cliPath);
      if (!cli.isFile() || (cli.mode & 0o022) !== 0 || ![0, process.getuid()].includes(cli.uid)) throw fail("TARGET_UNAVAILABLE");
      await fsp.access(entry.cliPath, 1);
      await fsp.realpath(entry.cwd);
      // The queue is used only where the thread's app-server can also be asked whether a turn is
      // running and which release it is: without that, "queued" would hide a held message.
      if (!path.isAbsolute(entry.socketPath ?? "")) throw fail("TARGET_UNAVAILABLE");
      return entry;
    }
    if (entry.transport !== undefined && entry.transport !== "existing-app-server") throw fail("TARGET_UNAVAILABLE");
    // The Codex CLI beside the app-server: its release is checked against the server's (inspect).
    if (!path.isAbsolute(entry.cliPath ?? "")) throw fail("TARGET_UNAVAILABLE");
    { const cli = await fsp.stat(entry.cliPath); if (!cli.isFile() || (cli.mode & 0o022) !== 0 || ![0, process.getuid()].includes(cli.uid)) throw fail("TARGET_UNAVAILABLE"); }
    if (!path.isAbsolute(entry.socketPath ?? "")) throw fail("TARGET_UNAVAILABLE");
    const stat = await fsp.lstat(entry.socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw fail("TARGET_UNAVAILABLE");
    return entry;
  }
  async inspect(alias, action) {
    const target = await this.target(alias); const rpc = this.connect(target.socketPath);
    try {
      const init = await rpc.call("initialize", { clientInfo: { name: "universal-peer-mcp", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      const serverVersion = versionOf(init?.userAgent);
      if (!serverVersion) throw fail("VERSION_UNKNOWN");
      if (target.codexVersion && target.codexVersion !== serverVersion) throw fail("VERSION_MISMATCH");
      // The CLI that queues or proxies and the app-server that owns the thread: one release.
      if ((await this.cliVersion(target.cliPath)) !== serverVersion) throw fail("VERSION_MISMATCH");
      rpc.notify("initialized");
      // thread/read alone can read a persisted but unloaded thread. Never load it
      // into a different server: verify ownership in this server's loaded list.
      let cursor = null; let loaded = false;
      for (let n = 0; n < 128; n++) {
        const result = await rpc.call("thread/loaded/list", { cursor, limit: 100 });
        if (result.data?.includes(target.threadId)) { loaded = true; break; }
        cursor = result.nextCursor; if (!cursor) break;
      }
      if (!loaded) throw fail("TARGET_UNAVAILABLE");
      const { thread } = await rpc.call("thread/read", { threadId: target.threadId, includeTurns: true });
      if (thread.id !== target.threadId || await fsp.realpath(thread.cwd) !== await fsp.realpath(target.cwd)) throw fail("TARGET_UNAVAILABLE");
      const state = thread.status?.type;
      if (!["idle", "active"].includes(state)) throw fail("TARGET_UNAVAILABLE");
      return await action({ rpc, thread, target, state, serverVersion });
    } finally { rpc.close(); }
  }
  async status({ codexAlias }) {
    try { return await this.inspect(codexAlias, async ({ state }) => ({ available: true, state })); }
    catch { return { available: false, state: "unavailable" }; }
  }
  // Rings the doorbell for one message already in the daemon's inbox. The body is not an argument:
  // it never travels by this path (Friday docs/008 §2.1). Idle thread: a new turn with the doorbell.
  // Running turn: app-server `turn/steer` into that turn when the target is an app-server; with the
  // CLI queue the doorbell waits for the turn to end and the answer says so
  // (`held_behind_running_turn`). Never retried here: an attempt with no clear answer is
  // DELIVERY_UNCERTAIN, and the same messageId answers from the reservation afterwards.
  async wake({ codexAlias, messageId }) {
    if (!UUID_LOWER.test(messageId ?? "")) throw fail("TARGET_UNAVAILABLE");
    const directory = path.join(this.root, "codex-wake"); await ensurePrivateDirectory(directory);
    const file = path.join(directory, messageId + ".json");
    const hash = crypto.createHash("sha256").update(JSON.stringify([codexAlias, messageId])).digest("hex");
    let reservation;
    try { reservation = await fsp.open(file, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await assertPrivateFile(file);
      let existing; try { existing = JSON.parse(await fsp.readFile(file, "utf8")); } catch { throw fail("DELIVERY_UNCERTAIN"); }
      if (existing.hash !== hash) throw fail("MESSAGE_ID_CONFLICT");
      if (!existing.result) throw fail("DELIVERY_UNCERTAIN");
      return { ...existing.result, replay: true };
    }
    try { await reservation.writeFile(JSON.stringify({ hash, state: "reserved" })); await reservation.sync(); }
    finally { await reservation.close(); }
    const dir = await fsp.open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    const bell = doorbell(messageId);
    let attempted = false;
    try {
      const result = await this.inspect(codexAlias, async ({ rpc, thread, target, state, serverVersion }) => {
        if (target.transport === "cli-queue") {
          attempted = true;
          await this.enqueue(target, bell);
          return { accepted: true, mode: state === "active" ? "held_behind_running_turn" : "queued", turnId: null, replay: false };
        }
        const params = { threadId: target.threadId, clientUserMessageId: messageId, input: [{ type: "text", text: bell, text_elements: [] }] };
        let method = "turn/start";
        if (state === "active") {
          const active = thread.turns?.filter((turn) => turn.status === "inProgress");
          if (active?.length !== 1) throw fail("TARGET_UNAVAILABLE");
          params.expectedTurnId = active[0].id; method = "turn/steer";
        }
        attempted = true;
        const response = await rpc.call(method, params);
        const turnId = response?.turn?.id ?? response?.turnId;
        if (typeof turnId !== "string" || !turnId) throw fail("DELIVERY_UNCERTAIN");
        return { accepted: true, mode: state === "active" ? "steered" : "started", turnId, replay: false };
      });
      await atomicPrivateWrite(file, JSON.stringify({ hash, state: "accepted", result }) + "\n");
      return result;
    } catch (error) {
      if (!attempted) await fsp.unlink(file);
      if (!attempted && ["VERSION_MISMATCH", "VERSION_UNKNOWN"].includes(error?.code)) throw fail(error.code);
      throw fail(attempted ? "DELIVERY_UNCERTAIN" : "TARGET_UNAVAILABLE");
    }
  }
}

export function codexWakeTools() {
  const codexAlias = { type: "string", pattern: "^[a-z][a-z0-9-]{1,47}$" };
  return [
    { name: "codex_status", description: "Check an allowlisted Codex binding. queue_configured validates configuration only, not a live consumer. Does not run a model.", inputSchema: { type: "object", required: ["codexAlias"], properties: { codexAlias }, additionalProperties: false }, outputSchema: { type: "object", required: ["available", "state"], properties: { available: { type: "boolean" }, state: { type: "string", enum: ["idle", "active", "unavailable"] } }, additionalProperties: false } },
    { name: "codex_wake", description: "Ring the fixed doorbell (PEER_DOORBELL v=1 message_id=<id>) on an allowlisted Codex thread for a message already in the daemon inbox. Never carries a body. Idle thread: starts a turn; running turn: steers it (app-server) or is held until it ends (CLI queue). queued/held are not delivery; the receiving model's peer_inbox_ack is. Never retried automatically.", inputSchema: { type: "object", required: ["codexAlias", "messageId"], properties: { codexAlias, messageId: { type: "string", format: "uuid" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["accepted", "mode", "turnId", "replay"], properties: { accepted: { type: "boolean" }, mode: { type: "string", enum: ["started", "steered", "queued", "held_behind_running_turn"] }, turnId: { type: ["string", "null"] }, replay: { type: "boolean" } }, additionalProperties: false } }
  ];
}
