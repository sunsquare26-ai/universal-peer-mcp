import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Alarms this package can raise, and where they go.
//
// The host's alarm path (an intent outbox, design note 010 §8) is intent-only on the Mini with a
// single dispatcher that is not live yet (PRODUCTION_READY = False, sending is its M11). So this
// sink does the two things that are in our hands and names the third:
//
//   1. a durable local record, `alerts.jsonl` in the state directory (0600, fsync, first-wins per
//      key, so one incident is one line however often it is re-detected);
//   2. an optional bridge command (`UNIVERSAL_PEER_ALERT_COMMAND`, an absolute path to an
//      executable this user owns), run with a fixed argv of closed-list words and no shell — the
//      place a host intent writer or an Air notifier is plugged in at installation;
//   3. the Air: not reached by this module. Arrival on the Air is the bridge's job and is only
//      claimed after it is observed there.
//
// No free text: an alert is a kind, a key and a closed set of short codes. No body, no path.
export const ALERT_KINDS = Object.freeze(["ledger_poisoned", "ledger_append_failed", "archive_failed", "archive_late_rows", "backup_failed", "retention_stopped", "retention_unprocessed", "doorbell_unknown", "doorbell_not_sent", "doorbell_hook_failed", "attempt_outcome_unrecorded", "github_relay_needed"]);
const KEY = /^[a-z0-9_:.-]{1,160}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const run = promisify(execFile);

export class AlertSink {
  constructor({ file, command = null, exec = run }) { this.file = file; this.command = command; this.exec = exec; this.keys = null; this.last = null; this.lastCommand = null; this.inflight = new Map(); }

  async #load() {
    if (this.keys) return;
    this.keys = new Set();
    try {
      for (const line of (await fsp.readFile(this.file, "utf8")).split("\n")) { if (!line) continue; try { this.keys.add(JSON.parse(line).key); } catch {} }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  // One raise per key at a time: a second caller for the same key while the first is still writing
  // shares its result instead of passing the "already raised" check too.
  raise(alert) {
    const key = alert?.key;
    if (typeof key === "string" && this.inflight.has(key)) return this.inflight.get(key);
    const job = this.#raise(alert).finally(() => this.inflight.delete(key));
    if (typeof key === "string") this.inflight.set(key, job);
    return job;
  }

  async #raise({ kind, key, code = null }) {
    if (!ALERT_KINDS.includes(kind) || !KEY.test(key) || (code !== null && !CODE.test(code))) throw Object.assign(new Error("invalid alert"), { code: "INVALID_ALERT" });
    await this.#load();
    if (this.keys.has(key)) return { raised: false, duplicate: true };
    const record = { schema: "universal-peer.alert/1", kind, key, ...(code === null ? {} : { code }), at: new Date().toISOString(), pid: process.pid };
    const handle = await fsp.open(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
    this.keys.add(key); this.last = record;
    this.lastCommand = await this.#bridge(record);
    return { raised: true, record, bridge: this.lastCommand };
  }

  async #bridge(record) {
    if (!this.command) return { configured: false };
    try {
      const stat = await fsp.stat(this.command);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) return { configured: true, ran: false, reason: "command_not_private" };
      await this.exec(this.command, ["universal-peer", record.kind, record.key, record.code ?? "-"], { timeout: 10_000, maxBuffer: 16_384 });
      return { configured: true, ran: true, ok: true };
    } catch (error) {
      return { configured: true, ran: true, ok: false, reason: typeof error?.code === "string" ? error.code : "command_failed" };
    }
  }

  status() { return { file: "alerts.jsonl", bridgeConfigured: Boolean(this.command), raisedThisProcess: this.last ? { kind: this.last.kind, key: this.last.key, at: this.last.at } : null, lastBridge: this.lastCommand }; }
}
