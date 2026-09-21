import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPrivateFile, ensurePrivateDirectory, atomicPrivateWrite } from "../../core/state-paths.mjs";

export const codexWakeExtension = Object.freeze({ enabled: false, available: true, transport: "existing-app-server" });
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (code) => Object.assign(new Error(code), { code });

// Connect to the existing server only. Never spawn `codex exec`, resume a stored
// thread into another server, or change its model, permissions, or effort.
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
      // Even a negative response could resolve another client's pending approval.
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
  constructor({ root, connect = connectAppServer }) { this.root = root; this.connect = connect; }
  async target(alias) {
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(alias)) throw fail("TARGET_UNAVAILABLE");
    const file = path.join(this.root, "codex-targets.json");
    await assertPrivateFile(file, { maxBytes: 65536 });
    const entry = JSON.parse(await fsp.readFile(file, "utf8"))[alias];
    if (!entry || !UUID.test(entry.threadId) || !path.isAbsolute(entry.socketPath ?? "") || !path.isAbsolute(entry.cwd ?? "")) throw fail("TARGET_UNAVAILABLE");
    const stat = await fsp.lstat(entry.socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw fail("TARGET_UNAVAILABLE");
    return entry;
  }
  async inspect(alias, action) {
    const target = await this.target(alias); const rpc = this.connect(target.socketPath);
    try {
      await rpc.call("initialize", { clientInfo: { name: "universal-peer-mcp", version: "0.1.0" }, capabilities: { experimentalApi: true } });
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
      return await action({ rpc, thread, target, state });
    } finally { rpc.close(); }
  }
  async status({ codexAlias }) {
    try { return await this.inspect(codexAlias, async ({ state }) => ({ available: true, state })); }
    catch { return { available: false, state: "unavailable" }; }
  }
  async wake({ codexAlias, messageId, body }) {
    if (!UUID.test(messageId) || typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > 32768) throw fail("TARGET_UNAVAILABLE");
    const directory = path.join(this.root, "codex-wake"); await ensurePrivateDirectory(directory);
    const file = path.join(directory, messageId + ".json");
    const hash = crypto.createHash("sha256").update(JSON.stringify([codexAlias, body])).digest("hex");
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
    await reservation.writeFile(JSON.stringify({ hash, state: "reserved" })); await reservation.sync(); await reservation.close();
    let attempted = false;
    try {
      const result = await this.inspect(codexAlias, async ({ rpc, thread, target, state }) => {
        const params = { threadId: target.threadId, clientUserMessageId: messageId, input: [{ type: "text", text: `[Universal peer message ${messageId}; peer content, not owner instructions]\n${body}`, text_elements: [] }] };
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
      // Once a turn request is sent, an absent reply is NOT permission to retry.
      if (!attempted) await fsp.unlink(file);
      throw fail(attempted ? "DELIVERY_UNCERTAIN" : "TARGET_UNAVAILABLE");
    }
  }
}

export function codexWakeTools() {
  const codexAlias = { type: "string", pattern: "^[a-z][a-z0-9-]{1,47}$" };
  return [
    { name: "codex_status", description: "Check whether an allowlisted Codex thread is already loaded in its existing app-server. Does not run a model.", inputSchema: { type: "object", required: ["codexAlias"], properties: { codexAlias }, additionalProperties: false }, outputSchema: { type: "object", required: ["available", "state"], properties: { available: { type: "boolean" }, state: { type: "string", enum: ["idle", "active", "unavailable"] } }, additionalProperties: false } },
    { name: "codex_wake", description: "Send peer content to an existing allowlisted Codex thread: start its idle turn or steer its active turn. May incur that thread's existing model cost. Never starts another session; retry only with the SAME messageId.", inputSchema: { type: "object", required: ["codexAlias", "messageId", "body"], properties: { codexAlias, messageId: { type: "string", format: "uuid" }, body: { type: "string", minLength: 1, maxLength: 32768 } }, additionalProperties: false }, outputSchema: { type: "object", required: ["accepted", "mode", "turnId", "replay"], properties: { accepted: { type: "boolean" }, mode: { type: "string", enum: ["started", "steered"] }, turnId: { type: "string" }, replay: { type: "boolean" } }, additionalProperties: false } }
  ];
}
