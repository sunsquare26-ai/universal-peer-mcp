import fs from "node:fs";
import fsp from "node:fs/promises";
import { MAX_EVENT_BYTES, referenceMatches, sameUuid } from "./limits.mjs";
import { assertPrivateFile, ensurePrivateDirectory } from "./state-paths.mjs";

export class EventStore {
  constructor(paths) { this.paths = paths; this.events = []; this.chain = Promise.resolve(); this.poisoned = null; }

  async init() {
    await ensurePrivateDirectory(this.paths.root);
    try { await assertPrivateFile(this.paths.events, { maxBytes: 64 * 1024 * 1024 }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const handle = await fsp.open(this.paths.events, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      await handle.close();
    }
    const bytes = await fsp.readFile(this.paths.events);
    const endsClean = bytes.length === 0 || bytes.at(-1) === 10;
    const lastLf = bytes.lastIndexOf(10);
    const completeBytes = endsClean ? bytes : bytes.subarray(0, lastLf + 1);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(completeBytes); }
    catch { throw new Error("event log is not valid UTF-8"); }
    const lines = text.split("\n");
    lines.pop();
    let expected = 1;
    for (const line of lines) {
      if (!line) throw new Error("event log has a damaged middle line");
      let event;
      try { event = JSON.parse(line); } catch { throw new Error("event log has a damaged middle line"); }
      if (!isEvent(event, expected)) throw new Error("event log has an invalid event schema");
      this.events.push(event); expected += 1;
    }
    if (!endsClean) {
      const handle = await fsp.open(this.paths.events, "r+");
      try { await handle.truncate(bytes.lastIndexOf(10) + 1); await handle.sync(); } finally { await handle.close(); }
    }
  }

  append(type, data = {}) {
    const operation = this.chain.then(() => this.#write(type, data));
    this.chain = operation.catch(() => {});
    return operation;
  }

  reserveRequest(data) {
    const operation = this.chain.then(async () => {
      if (this.poisoned) throw this.poisoned;
      const prior = this.request(data.messageId);
      if (prior) return { created: false, event: prior };
      return { created: true, event: await this.#write("send_requested", data) };
    });
    this.chain = operation.catch(() => {});
    return operation;
  }

  reserveRecovery(data) {
    const operation = this.chain.then(async () => {
      if (this.poisoned) throw this.poisoned;
      const prior = this.events.find((event) => event.type === "send_recovery_reserved" && sameUuid(event.messageId, data.messageId));
      if (prior) return { created: false, event: prior };
      return { created: true, event: await this.#write("send_recovery_reserved", data) };
    });
    this.chain = operation.catch(() => {});
    return operation;
  }

  list({ afterSeq = 0, messageId = null } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    if (messageId) this.request(messageId); // refuse ambiguous historical case collisions on waits/replays too
    return this.events.filter((event) => event.seq > afterSeq && (!messageId || sameUuid(event.messageId, messageId)));
  }

  request(messageId) {
    const matches = this.events.filter((event) => event.type === "send_requested" && sameUuid(event.messageId, messageId));
    // Older builds could reserve both spellings. Never silently choose one target/hash.
    if (matches.length > 1) throw Object.assign(new Error("ambiguous historical messageId"), { code: "MESSAGE_ID_CONFLICT" });
    return matches[0] ?? null;
  }
  // A reference is the leading hex of an id, which is what a sender that has no field to put a
  // full one in writes (src/adapters/claude-native-v1/protocol.mjs). This narrows this ledger's
  // own rows and never names a row that is not there. A reference matching more than one request
  // is refused rather than resolved: choosing one of them would bind an answer to a message
  // nobody chose, and the caller reports the ambiguity instead. `request` is unchanged and is
  // still the only way an exact id is looked up.
  requestByReference(reference) {
    const matches = new Map();
    for (const event of this.events) {
      if (event.type !== "send_requested" || typeof event.messageId !== "string") continue;
      if (!referenceMatches(event.messageId, reference)) continue;
      matches.set(event.messageId.toLowerCase(), event);
    }
    if (matches.size > 1) return { request: null, ambiguous: true };
    return { request: [...matches.values()][0] ?? null, ambiguous: false };
  }
  requestByTransport(transportMessageId) {
    const recovery = this.events.find((event) => event.type === "send_recovery_reserved" && sameUuid(event.transportMessageId, transportMessageId));
    return recovery ? this.request(recovery.messageId) : this.request(transportMessageId);
  }
  requestBySubscription(subscriptionId) {
    const recovery = this.events.find((event) => event.type === "send_recovery_reserved" && sameUuid(event.subscriptionId, subscriptionId));
    if (recovery) return this.request(recovery.messageId);
    const initial = this.events.find((event) => event.type === "send_requested" && sameUuid(event.subscriptionId, subscriptionId));
    return initial ? this.request(initial.messageId) : null;
  }
  async close() { await this.chain; }

  async #write(type, data) {
    if (this.poisoned) throw this.poisoned;
    const event = { seq: this.events.length + 1, type, at: new Date().toISOString(), ...data };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw Object.assign(new Error("event exceeds 64 KiB"), { code: "EVENT_TOO_LARGE" });
    try {
      const handle = await fsp.open(this.paths.events, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { this.poisoned = error; throw error; }
    this.events.push(event);
    return event;
  }
}

function isEvent(event, expectedSeq) {
  return event !== null && typeof event === "object" && !Array.isArray(event)
    && event.seq === expectedSeq
    && typeof event.type === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(event.type)
    && typeof event.at === "string" && Number.isFinite(Date.parse(event.at));
}
