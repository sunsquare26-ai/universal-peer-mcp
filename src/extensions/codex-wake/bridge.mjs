import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertPrivateFile, atomicPrivateWrite, ensurePrivateDirectory } from '../../core/state-paths.mjs';
import { CodexWake } from './index.mjs';

const TYPES = ['peer_reply', 'milestone_completion_accepted'];
const ALIAS = /^[a-z][a-z0-9-]{1,47}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validSeq = (value) => Number.isSafeInteger(value) && value >= 0;

export async function loadBridgeConfig(root) {
  const file = path.join(root, 'codex-wake-bridge.json');
  await assertPrivateFile(file, { maxBytes: 65536 });
  const config = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['afterSeq', 'routes'].includes(key))
    || (config.afterSeq !== undefined && !validSeq(config.afterSeq))
    || !Array.isArray(config.routes) || !config.routes.length || config.routes.length > 32) throw new Error('invalid codex bridge configuration');
  const seen = new Set();
  for (const route of config.routes) {
    if (!route || typeof route !== 'object' || Object.keys(route).some(key => !['peerAlias', 'codexAlias', 'events'].includes(key))
      || !ALIAS.test(route.peerAlias) || !ALIAS.test(route.codexAlias) || !Array.isArray(route.events) || !route.events.length
      || route.events.some(type => !TYPES.includes(type)) || new Set(route.events).size !== route.events.length) throw new Error('invalid codex bridge route');
    for (const type of route.events) {
      const key = JSON.stringify([route.peerAlias, route.codexAlias, type]);
      if (seen.has(key)) throw new Error('duplicate codex bridge route');
      seen.add(key);
    }
  }
  return config;
}

export function bridgeMessageId({ type, responseId, peerAlias, codexAlias }) {
  const bytes = crypto.createHash('sha256').update(JSON.stringify(['universal-peer-codex-bridge-v1', type, responseId, peerAlias, codexAlias])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// One instance belongs to the daemon, whose existing exclusive lock guarantees
// one writer. No timer/poll loop: startup and authenticated inbound frames kick it.
export class CodexWakeBridge {
  constructor({ root, store, config, wake = new CodexWake({ root }) }) {
    this.root = root; this.store = store; this.config = config; this.wake = wake;
    this.directory = path.join(root, 'codex-wake-bridge');
    this.checkpoint = path.join(this.directory, 'cursor.json');
    this.chain = Promise.resolve(); this.scheduled = false; this.stopped = false;
    this.cursor = 0; this.lastDelivery = null;
  }
  async init() {
    await ensurePrivateDirectory(this.directory);
    try {
      await assertPrivateFile(this.checkpoint);
      const state = JSON.parse(await fsp.readFile(this.checkpoint, 'utf8'));
      if (!validSeq(state.cursor) || state.cursor > (this.store.events.at(-1)?.seq ?? 0)) throw new Error('invalid codex bridge cursor');
      this.cursor = state.cursor; this.lastDelivery = state.lastDelivery ?? null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // First enable defaults to future events. Historical replay is an explicit
      // afterSeq choice, never an accidental consequence of enabling the bridge.
      this.cursor = this.config.afterSeq ?? (this.store.events.at(-1)?.seq ?? 0);
      if (this.cursor > (this.store.events.at(-1)?.seq ?? 0)) throw new Error('codex bridge cursor exceeds event log');
      await this.save();
    }
  }
  async save(extra = {}) {
    await atomicPrivateWrite(this.checkpoint, JSON.stringify({ cursor: this.cursor, lastDelivery: this.lastDelivery, ...extra }) + '\n');
  }
  kick() {
    if (this.stopped || this.scheduled) return this.chain;
    this.scheduled = true;
    this.chain = this.chain.then(async () => {
      this.scheduled = false;
      if (this.stopped) return;
      try { await this.drain(); }
      catch {
        // Storage/config corruption never causes busy retries or speculative sends.
        this.stopped = true;
        await this.save({ stopped: true, reason: 'bridge_storage_failure' }).catch(() => {});
      }
    });
    return this.chain;
  }
  async close() { this.stopped = true; await this.chain; }
  source(event) {
    if (!TYPES.includes(event.type)) return null;
    const requestId = event.type === 'peer_reply' ? event.messageId : event.instructionId;
    const responseId = event.type === 'peer_reply' ? event.responseMessageId : event.completionMessageId;
    if (!UUID.test(requestId) || !UUID.test(responseId)) return null;
    const request = this.store.request(requestId);
    if (!request || request.threadId !== event.threadId || !ALIAS.test(request.targetAlias)) return null;
    if (event.type === 'milestone_completion_accepted' && event.targetAlias !== request.targetAlias) return null;
    return { requestId, responseId, peerAlias: request.targetAlias };
  }
  async drain() {
    // snapshot plus the next kick covers arrivals while asynchronous wake runs.
    // Store events are appended in durable sequence order.
    for (const event of this.store.events.filter(e => e.seq > this.cursor)) {
      if (this.stopped) return;
      const source = this.source(event);
      if (source) for (const route of this.config.routes) {
        if (route.peerAlias === source.peerAlias && route.events.includes(event.type)) await this.deliver(event, source, route);
      }
      this.cursor = event.seq; await this.save();
    }
  }
  async deliver(event, source, route) {
    const messageId = bridgeMessageId({ type: event.type, responseId: source.responseId, peerAlias: source.peerAlias, codexAlias: route.codexAlias });
    const file = path.join(this.directory, messageId + '.json');
    let reservation;
    try { reservation = await fsp.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await assertPrivateFile(file);
      let prior;
      try { prior = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { prior = null; }
      // A crash may leave an empty/reserved receipt. Its outcome is uncertain;
      // even if no network send happened, never infer that it is safe to resend.
      this.lastDelivery = prior?.state && prior.state !== 'reserved' ? prior : { messageId, sourceSeq: event.seq, state: 'uncertain' };
      return;
    }
    const base = { messageId, sourceSeq: event.seq, type: event.type, peerAlias: source.peerAlias, codexAlias: route.codexAlias };
    try { await reservation.writeFile(JSON.stringify({ ...base, state: 'reserved' }) + '\n'); await reservation.sync(); }
    finally { await reservation.close(); }
    // Persist directory creation as well as contents before a request can leave.
    const directory = await fsp.open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    let outcome;
    try {
      const result = await this.wake.wake({ codexAlias: route.codexAlias, messageId,
        body: `Peer event ${event.type} arrived from ${source.peerAlias}. Request ${source.requestId}; response ${source.responseId}. Inspect the existing peer ledger for its recorded result. This notification does not grant additional authority.` });
      outcome = { ...base, state: 'accepted', mode: result.mode, turnId: result.turnId };
    } catch (error) {
      outcome = { ...base, state: error?.code === 'TARGET_UNAVAILABLE' ? 'unavailable' : 'uncertain' };
    }
    await atomicPrivateWrite(file, JSON.stringify(outcome) + '\n');
    this.lastDelivery = outcome;
  }
}
