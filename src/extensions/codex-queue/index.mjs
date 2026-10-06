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
// M3: the queue carries only the fixed doorbell (design note 008 §2.1). Exactly two call values —
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
async function privateSocket(p) { try { const st = await fsp.lstat(p); return st.isSocket() && !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o077) === 0; } catch { return false; } }
async function privateBinary(p) { try { const st = await fsp.stat(p); return st.isFile() && [0, process.getuid()].includes(st.uid) && (st.mode & 0o022) === 0 && (st.mode & 0o111) !== 0; } catch { return false; } }
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
  // `targets(alias)` (optional) supplies the entry instead of `<root>/codex-targets.json` — the
  // daemon builds it from the peer directory and its settings. `authorize(alias, messageId, entry)`
  // (optional) is asked before anything is reserved or sent; the daemon uses it to allow only a
  // message that is in its inbox for that alias and thread and not yet processed.
  constructor({ root, connect = connectAppServer, enqueue = enqueueCodex, cliVersion: readCliVersion = cliVersion, targets = null, authorize = null, cliFor = null, sockets = null }) { this.root = root; this.connect = connect; this.enqueue = enqueue; this.cliVersion = readCliVersion; this.targets = targets; this.authorize = authorize; this.cliFor = cliFor; this.sockets = sockets; }
  // `given`: an entry supplied by the caller for this one call (immutable; the daemon passes the
  // thread of the post being rung). Validated exactly like one read from a file.
  async target(alias, given = null) {
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(alias)) throw fail("TARGET_UNAVAILABLE");
    let entry;
    if (given) entry = given;
    else if (this.targets) entry = await this.targets(alias);
    else {
      const file = path.join(this.root, "codex-targets.json");
      await assertPrivateFile(file, { maxBytes: 65536 });
      entry = JSON.parse(await fsp.readFile(file, "utf8"))[alias];
    }
    // cwd is optional: when given, the thread must be running there.
    if (!entry || !UUID_LOWER.test(entry.threadId) || (entry.cwd !== undefined && !path.isAbsolute(entry.cwd))) throw fail("TARGET_UNAVAILABLE");
    // A target entry is identity and location only; a key that could carry permissions, model or
    // argv (sandbox, extraArgs, ...) makes the whole entry untrusted.
    if (Object.keys(entry).some((key) => !TARGET_KEYS.has(key))) throw fail("TARGET_UNAVAILABLE");
    if (entry.codexVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(entry.codexVersion)) throw fail("TARGET_UNAVAILABLE");
    if (entry.transport === "cli-queue") {
      if (!path.isAbsolute(entry.cliPath ?? "")) throw fail("TARGET_UNAVAILABLE");
      const cli = await fsp.stat(entry.cliPath);
      if (!cli.isFile() || (cli.mode & 0o022) !== 0 || ![0, process.getuid()].includes(cli.uid)) throw fail("TARGET_UNAVAILABLE");
      await fsp.access(entry.cliPath, 1);
      if (entry.cwd !== undefined) await fsp.realpath(entry.cwd);
      // The queue is used only where the thread's app-server can also be asked whether a turn is
      // running and which release it is: without that, "queued" would hide a held message.
      if (!path.isAbsolute(entry.socketPath ?? "")) throw fail("TARGET_UNAVAILABLE");
      return entry;
    }
    if (entry.transport !== undefined && entry.transport !== "existing-app-server") throw fail("TARGET_UNAVAILABLE");
    // Shape only here. The configured CLI and socket are the first candidates, not preconditions: an
    // update can remove the old release or socket, and the search must still find the new ones
    // (inspect checks owner and mode of every candidate it actually uses).
    if (!path.isAbsolute(entry.cliPath ?? "") || !path.isAbsolute(entry.socketPath ?? "")) throw fail("TARGET_UNAVAILABLE");
    return entry;
  }
  // Which app-server holds the thread: the target's socket first, then any other socket the caller
  // offers (`sockets()`, e.g. every private socket under the Codex daemon directory). The thread must
  // be in that server's loaded list; nothing is ever loaded into a server.
  async inspect(alias, action, given = null) {
    const target = await this.target(alias, given);
    const candidates = [target.socketPath, ...((await this.sockets?.()) ?? [])].filter((p, i, a) => typeof p === "string" && a.indexOf(p) === i);
    for (const socketPath of candidates) {
      // A candidate that is missing, not a private socket of this user, dead, fails to initialize or
      // does not list the thread is skipped. Once a server lists the thread, its answer is final.
      if (!(await privateSocket(socketPath))) continue;
      try { return await this.#inspectOn({ ...target, socketPath }, action); }
      catch (error) { if (!error?.skipCandidate) throw error; }
    }
    throw fail("TARGET_UNAVAILABLE");
  }

  async #inspectOn(target, action) {
    const rpc = this.connect(target.socketPath);
    const skip = () => Object.assign(fail("THREAD_NOT_HERE"), { skipCandidate: true });
    try {
      let init;
      try { init = await rpc.call("initialize", { clientInfo: { name: "universal-peer-mcp", version: "0.1.0" }, capabilities: { experimentalApi: true } }); }
      catch { throw skip(); }
      rpc.notify("initialized");
      // Ownership first: this server must list the thread as loaded; otherwise try the next one.
      let loaded = false;
      try {
        let cursor = null;
        for (let n = 0; n < 128; n++) {
          const result = await rpc.call("thread/loaded/list", { cursor, limit: 100 });
          if (result.data?.includes(target.threadId)) { loaded = true; break; }
          cursor = result.nextCursor; if (!cursor) break;
        }
      } catch { throw skip(); }
      if (!loaded) throw skip();
      const serverVersion = versionOf(init?.userAgent);
      if (!serverVersion) throw fail("VERSION_UNKNOWN");
      // The release follows the server (it updates itself): the CLI used with it is chosen now, for
      // the version the server just reported — the configured one if it matches, otherwise the one
      // `cliFor(version)` finds (e.g. the daemon's own releases directory). No match: not sent.
      // Every CLI used (configured or found) must be this user's (or root's) regular file that no one
      // else can write, and report the server's release.
      let cliPath = target.cliPath;
      if (!(await privateBinary(cliPath)) || (await this.cliVersion(cliPath).catch(() => null)) !== serverVersion) {
        cliPath = (await this.cliFor?.(serverVersion)) ?? null;
        if (!cliPath || !(await privateBinary(cliPath)) || (await this.cliVersion(cliPath).catch(() => null)) !== serverVersion) throw fail("VERSION_MISMATCH");
      }
      target = { ...target, cliPath };
      // thread/read alone can read a persisted but unloaded thread; ownership was proven above from
      // this server's loaded list, and nothing is ever loaded into a server.
      // Metadata only. `includeTurns: true` hydrates the whole rollout: 38,490,010 bytes for the live
      // codex-main thread (386 turns, measured 2026-09-29 23:3x KST), past the transport's 8 MiB frame
      // bound, so the socket closed ("Max payload size exceeded") and every running-turn doorbell fell
      // back to the queue as held. The protocol marks full hydration deprecated for paginated threads.
      const { thread } = await rpc.call("thread/read", { threadId: target.threadId });
      if (thread.id !== target.threadId || (target.cwd !== undefined && await fsp.realpath(thread.cwd) !== await fsp.realpath(target.cwd))) throw fail("TARGET_UNAVAILABLE");
      const state = thread.status?.type;
      if (!["idle", "active"].includes(state)) throw fail("TARGET_UNAVAILABLE");
      // The running turn's id, when there is one, from the newest turn only (one small page).
      let activeTurnId = null;
      if (state === "active") {
        const page = await rpc.call("thread/turns/list", { threadId: target.threadId, limit: 1 });
        const newest = Array.isArray(page?.data) ? page.data[0] : null;
        if (newest?.status === "inProgress" && typeof newest.id === "string" && newest.id) activeTurnId = newest.id;
      }
      return await action({ rpc, thread, target, state, serverVersion, activeTurnId });
    } finally { rpc.close(); }
  }
  async status({ codexAlias }) {
    try { return await this.inspect(codexAlias, async ({ state }) => ({ available: true, state })); }
    catch { return { available: false, state: "unavailable" }; }
  }
  // Rings the doorbell for one message already in the daemon's inbox. The body is not an argument:
  // it never travels by this path (design note 008 §2.1). Idle thread: a new turn with the doorbell.
  // Running turn: app-server `turn/steer` into that turn when the target is an app-server; with the
  // CLI queue the doorbell waits for the turn to end and the answer says so
  // (`held_behind_running_turn`). Never retried here: an attempt with no clear answer is
  // DELIVERY_UNCERTAIN, and the same messageId answers from the reservation afterwards.
  // `attemptKey` (M5): the reservation's key. It is the messageId, except for a doorbell rung after
  // the Owner relinked the message to another thread: that is a new attempt at a new thread, and a
  // success recorded for the old one must not answer for it. The doorbell text always names messageId.
  async wake({ codexAlias, messageId, target: given = null, attemptKey = messageId }) {
    if (given !== null) given = Object.freeze({ ...given });
    if (!UUID_LOWER.test(messageId ?? "") || !UUID_LOWER.test(attemptKey ?? "")) throw fail("TARGET_UNAVAILABLE");
    if (this.authorize) { const verdict = await this.authorize(codexAlias, messageId); if (verdict !== true) throw fail(typeof verdict === "string" ? verdict : "WAKE_NOT_AUTHORIZED"); }
    const directory = path.join(this.root, "codex-wake"); await ensurePrivateDirectory(directory);
    const file = path.join(directory, attemptKey + ".json");
    const hash = crypto.createHash("sha256").update(JSON.stringify([codexAlias, attemptKey])).digest("hex");
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
      const result = await this.inspect(codexAlias, async ({ rpc, thread, target, state, serverVersion, activeTurnId }) => {
        if (target.transport === "cli-queue") {
          attempted = true;
          await this.enqueue(target, bell);
          return { accepted: true, mode: state === "active" ? "held_behind_running_turn" : "queued", turnId: null, replay: false };
        }
        const params = { threadId: target.threadId, clientUserMessageId: attemptKey, input: [{ type: "text", text: bell, text_elements: [] }] };
        let method = "turn/start";
        if (state === "active") {
          if (!activeTurnId) throw fail("TARGET_UNAVAILABLE");
          params.expectedTurnId = activeTurnId; method = "turn/steer";
        }
        attempted = true;
        const response = await rpc.call(method, params);
        const turnId = response?.turn?.id ?? response?.turnId;
        if (typeof turnId !== "string" || !turnId) throw fail("DELIVERY_UNCERTAIN");
        return { accepted: true, mode: state === "active" ? "steered" : "started", turnId, replay: false };
      }, given);
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
