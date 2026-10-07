import { CodexWake, cliVersion as readCliVersion, enqueueCodex } from "../extensions/codex-queue/index.mjs";
import { claudeDoorbell, claudeDoorbellVersions, doorbell } from "./doorbell.mjs";
import { canonicalSend, sha256 } from "./dedupe.mjs";
const WRITTEN_STATES = new Set(["written", "delivered", "held", "idle", "acknowledged", "replied"]);
import { sameUuid } from "./limits.mjs";
import { uuidv5 } from "./posts.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the Codex app-server daemon keeps its releases and its sockets. It updates itself (measured
// 2026-09-30 05:58 KST: 0.159.0 -> 0.159.1 under the same socket path), so the CLI is chosen per ring
// for the version the server reports, and the socket that holds the thread is looked up, not pinned.
export const DEFAULT_CODEX_RELEASES = path.join(os.homedir(), ".codex", "packages", "app-server-daemon", "releases");
export const DEFAULT_CODEX_SOCKET_DIR = `/private/tmp/codex-daemon-${process.getuid()}`;
const privateFile = (p, kind) => { try { const st = fs.lstatSync(p); return !st.isSymbolicLink() && st.uid === process.getuid() && (kind === "socket" ? st.isSocket() && (st.mode & 0o077) === 0 : st.isFile() && (st.mode & 0o022) === 0); } catch { return false; } };
export function cliForVersion(version, releases = DEFAULT_CODEX_RELEASES) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) return null;
  let names = []; try { names = fs.readdirSync(releases); } catch { return null; }
  for (const name of names.filter((n) => n.startsWith(`${version}-`)).sort()) { const bin = path.join(releases, name, "bin", "codex"); if (privateFile(bin, "file")) return bin; }
  return null;
}
export function codexSockets(dir = DEFAULT_CODEX_SOCKET_DIR) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^[0-9a-f]{64}$/.test(n)).map((n) => path.join(dir, n)).filter((p) => privateFile(p, "socket"));
}

// The product path of the doorbell (M3). A post accepted for a Codex peer gets one durable intent
// and one ring:
//
//   doorbell_intent   written first, once per messageId (appendChecked), with the alias and the
//                     thread the post was delivered to (the post row's recipientThreadId)
//   doorbell_outcome  sent (turn/start or turn/steer accepted) | held (only the CLI queue could be
//                     used: the doorbell waits for the running turn) | unknown (the attempt had no
//                     clear answer) | not_sent (refused before anything went out, with a code)
//   doorbell_retry    one retry of an intent left open by a restart; never a second one
//   doorbell_alerted  one alarm per message: not_sent (with its code) or unknown for more than
//                     30 minutes; never resent automatically (see sweep)
//
// The thread is never looked up anywhere else: it is the thread the post was delivered to, and it
// must still be the thread the alias names in the peer directory. If the alias moved (register
// --replace) after the post, the doorbell is refused (`wake_target_mismatch`) instead of ringing a
// thread that does not hold the message. The host (app-server socket, CLI, release) comes from the
// daemon settings; nothing in a per-alias target file.
export const UNKNOWN_ALERT_AFTER_MS = 30 * 60 * 1000;
const code = (error) => (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "WAKE_FAILED");

export class DoorbellService {
  // Claude recipients (M3, second half): `claudePeers()` is the target table (alias -> sessionId) and
  // `sendClaude({ alias, messageId, threadId, line })` writes one fixed line into that session through
  // the native injection path (PeerCore.send with a privileged wire body).
  constructor({ store, root, settings, codexPeers, claudePeers = () => ({}), sendClaude = null, alerts = null, wake = null, enqueue = enqueueCodex, cliVersion = readCliVersion, now = () => Date.now() }) {
    this.store = store; this.settings = settings; this.codexPeers = codexPeers; this.claudePeers = claudePeers; this.sendClaude = sendClaude; this.alerts = alerts; this.now = now; this.enqueue = enqueue; this.cliVersion = cliVersion;
    this.running = new Map();
    // No shared "current target": every ring passes its own immutable target (review [상]).
    const releases = settings.codexReleasesDir?.value ?? DEFAULT_CODEX_RELEASES;
    this.wake = wake ?? new CodexWake({ root, authorize: (alias, messageId, attemptKey) => this.authorize(alias, messageId, attemptKey === undefined ? null : { attemptKey }), cliFor: (version) => cliForVersion(version, releases), sockets: () => codexSockets(settings.codexSocketDir?.value ?? DEFAULT_CODEX_SOCKET_DIR) });
  }
  configured() { return Boolean(this.settings.codexCli?.value && this.settings.codexAppServerSocket?.value); }
  post(messageId) { return this.store.events.find((e) => e.type === "peer_post" && sameUuid(e.messageId, messageId)) ?? null; }
  intent(messageId) { return this.store.events.find((e) => e.type === "doorbell_intent" && sameUuid(e.messageId, messageId)) ?? null; }
  outcome(messageId) { return this.store.events.find((e) => e.type === "doorbell_outcome" && sameUuid(e.messageId, messageId)) ?? null; }
  processed(messageId) { return this.store.events.some((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, messageId)); }

  // Host settings + the thread of this one post.
  targetFor(post, attempt = this.attemptOf(post)) {
    return { transport: "existing-app-server", cliPath: this.settings.codexCli.value, socketPath: this.settings.codexAppServerSocket.value, threadId: attempt.binding, ...(this.settings.codexVersion?.value ? { codexVersion: this.settings.codexVersion.value } : {}) };
  }

  // Only a message in the daemon inbox, delivered to this alias and session/thread, not yet
  // processed, and whose alias still names that session/thread.
  // `attempt` (M5): the generation an attempt started in. An attempt whose message has since been
  // relinked is stale — it is refused here, so an old attempt never rings the new session or the
  // old one under the new generation's name.
  authorize(alias, messageId, attempt = null) {
    const post = this.post(messageId);
    if (!post) return "WAKE_UNKNOWN_MESSAGE";
    const codex = post.recipientKind === "codex";
    if (attempt?.attemptKey && attempt.attemptKey !== this.attemptKeyOf(post)) return "WAKE_GENERATION_STALE";
    if (attempt?.generation !== undefined && attempt.generation !== this.generationOf(post)) return "WAKE_GENERATION_STALE";
    const bound = attempt?.binding ?? this.bindingOf(post);
    if (post.recipient !== alias || !["codex", "claude"].includes(post.recipientKind) || typeof bound !== "string") return "WAKE_NOT_RECIPIENT";
    if (this.processed(messageId)) return "WAKE_ALREADY_PROCESSED";
    const current = codex ? this.codexPeers()?.[alias]?.threadId : this.claudePeers()?.[alias]?.sessionId;
    if (!current || !sameUuid(current, bound)) return "WAKE_TARGET_MISMATCH";
    return true;
  }
  // The session a post is bound to now: the accepted row's, or the Owner's latest relink
  // (peer_post_relinked) — a relinked message is rung, authorized and woken at its new session.
  // Relinks are read once per ledger length (the ledger only grows), so asking per post stays O(1).
  #relinks() {
    const length = this.store.events.length;
    if (this.relinkCache?.length !== length) {
      const map = new Map();
      for (const e of this.store.events) if (e.type === "peer_post_relinked" && typeof e.messageId === "string") map.set(e.messageId.toLowerCase(), e);
      this.relinkCache = { length, map };
    }
    return this.relinkCache.map;
  }
  // Which relink generation a post is in: 0 as accepted, else the seq of the Owner's latest relink.
  // Each generation is a separate delivery attempt with its own transport ids, so a success at the
  // previous session never stands for the session the message was moved to.
  // An attempt's identity, fixed when it starts and used for its target, its transport ids and its
  // outcome row: {generation, binding, attemptKey, claudeId}.
  attemptOf(post) { return Object.freeze({ generation: this.generationOf(post), binding: this.bindingOf(post), attemptKey: this.attemptKeyOf(post), claudeId: this.claudeTransportIdOf(post) }); }
  generationOf(post) { return this.#relinks().get(String(post.messageId).toLowerCase())?.seq ?? 0; }
  attemptKeyOf(post) { const g = this.generationOf(post); return g ? uuidv5(`doorbell:${post.messageId.toLowerCase()}:relink:${g}`) : post.messageId; }
  claudeTransportIdOf(post) { const g = this.generationOf(post); return g ? uuidv5(`doorbell:${post.messageId.toLowerCase()}:relink:${g}`) : uuidv5(`doorbell:${post.messageId}`); }
  bindingOf(post) {
    const codex = post.recipientKind === "codex";
    const relink = this.#relinks().get(String(post.messageId).toLowerCase());
    const original = codex ? post.recipientThreadId : post.recipientSessionId;
    return relink ? ((codex ? relink.recipientThreadId : relink.recipientSessionId) ?? original) : original;
  }

  // Called for every appended row; acts on accepted posts for Codex peers.
  async onAppend(row) {
    // A queued doorbell cannot be withdrawn. When the message is processed before the queue
    // delivers it, the late doorbell is recorded as stale (once) — the receiver sees
    // already_processed on `inbox --message-id` and skips it. Nothing is sent or cancelled.
    if (row?.type === "peer_post_processed") {
      const out = this.outcome(row.messageId);
      if (out?.state === "held" && !this.store.events.some((e) => e.type === "doorbell_stale" && sameUuid(e.messageId, row.messageId))) await this.store.append("doorbell_stale", { messageId: row.messageId, recipient: out.recipient, via: out.via ?? null, outcomeSeq: out.seq });
      return;
    }
    if (row?.type !== "peer_post" || !["codex", "claude"].includes(row.recipientKind)) return;
    await this.ring(row.messageId, { first: true });
  }

  async ring(messageId, { first = false, retry = false, generation = null } = {}) {
    const known = this.post(messageId);
    const expectedGeneration = generation ?? (known ? this.generationOf(known) : 0);
    const runKey = `${messageId}:${expectedGeneration}`;
    if (this.running.has(runKey)) return this.running.get(runKey);
    const job = (async () => {
      const post = this.post(messageId);
      if (!post || !["codex", "claude"].includes(post.recipientKind)) return { state: "not_applicable" };
      if (first) {
        try { await this.store.appendChecked("doorbell_intent", { messageId: post.messageId, recipient: post.recipient, recipientKind: post.recipientKind, threadId: this.bindingOf(post) }, (events) => (events.some((e) => e.type === "doorbell_intent" && sameUuid(e.messageId, messageId)) ? Object.assign(new Error("dup"), { code: "DUP" }) : null)); }
        catch (error) { if (error.code !== "DUP") throw error; return { state: "duplicate_intent" }; }
      }
      if (retry) await this.store.append("doorbell_retry", { messageId: post.messageId });
      const attempt = this.attemptOf(post);
      if (attempt.generation !== expectedGeneration) return { state: "stale_generation" };
      const record = (state, extra = {}) => this.#record(post, state, extra, attempt);
      const verdict = this.authorize(post.recipient, post.messageId, attempt);
      if (verdict !== true) return record("not_sent", { errorCode: verdict, ...(verdict === "WAKE_TARGET_MISMATCH" ? { reason: "wake_target_mismatch", boundThreadId: (post.recipientKind === "codex" ? this.codexPeers()?.[post.recipient]?.threadId : this.claudePeers()?.[post.recipient]?.sessionId) ?? null } : {}) });
      if (post.recipientKind === "claude") return this.#ringClaude(post, attempt);
      if (!this.configured()) return record("not_sent", { errorCode: "DOORBELL_NOT_CONFIGURED" });
      try {
        const result = await this.wake.wake({ codexAlias: post.recipient, messageId: post.messageId, target: this.targetFor(post, attempt), attemptKey: attempt.attemptKey });
        const state = result.mode === "held_behind_running_turn" ? "held" : "sent";
        return record(state, { mode: result.mode, ...(result.turnId ? { turnId: result.turnId } : {}), ...(result.replay ? { replay: true } : {}) });
      } catch (error) {
        const c = code(error);
        if (c === "DELIVERY_UNCERTAIN") return record("unknown", { errorCode: c });
        if (c === "TARGET_UNAVAILABLE") return this.#queueFallback(post, attempt);
        return record("not_sent", { errorCode: c });
      }
    })();
    this.running.set(runKey, job);
    try { return await job; } finally { this.running.delete(runKey); }
  }

  // Claude: one fixed line through the native session socket (the path peer_send uses), under an id
  // derived from the post id so a retry after a restart is a replay, never a second write. The
  // socket write is `sent`; that the session read it is proven only by its own inbox-ack.
  async #ringClaude(post, attempt) {
    const record = (state, extra = {}) => this.#record(post, state, extra, attempt);
    if (typeof this.sendClaude !== "function") return record("not_sent", { errorCode: "DOORBELL_NOT_CONFIGURED" });
    try {
      // A doorbell already reserved under this derived id (by this build or an earlier one, before a
      // restart) is replayed byte for byte: the wording whose request hash the reservation holds is
      // looked up among every wording ever sent. A reservation matching none is not re-sent with
      // something else — it is recorded unknown for a hand.
      const derived = attempt.claudeId;
      let prior = null; try { prior = typeof this.store.request === "function" ? this.store.request(derived) : null; } catch {}
      let line = claudeDoorbell(post.messageId);
      if (prior) {
        const hashOf = (body) => sha256(canonicalSend({ alias: post.recipient, messageId: derived, threadId: post.messageId, kind: "doorbell", body }));
        line = claudeDoorbellVersions(post.messageId).find((candidate) => hashOf(candidate) === prior.requestHash) ?? null;
        if (line === null) return record("unknown", { errorCode: "DOORBELL_ENVELOPE_UNKNOWN" });
      }
      // The attempt's session goes with it: the sender refuses if the alias names another session by
      // the time it writes (the daemon adapter checks before core.send resolves the target).
      const verdict = this.authorize(post.recipient, post.messageId, attempt);
      if (verdict !== true) return record("not_sent", { errorCode: verdict });
      const result = await this.sendClaude({ alias: post.recipient, messageId: derived, threadId: post.messageId, line, expectSessionId: attempt.binding });
      // A replay sends nothing; it reports what the first attempt reached. Only evidence of a
      // completed write counts as sent — a reservation alone (a crash before the write) does not.
      if (result?.replay && !WRITTEN_STATES.has(result.status)) return record("unknown", { errorCode: "REPLAY_NOT_WRITTEN", replayStatus: typeof result.status === "string" ? result.status : null });
      return record("sent", { mode: "session_socket", ...(result?.replay ? { replay: true } : {}) });
    } catch (error) {
      const c = code(error);
      return record(c === "DELIVERY_UNCERTAIN" || c === "MESSAGE_ID_CONFLICT" ? "unknown" : "not_sent", { errorCode: c });
    }
  }

  // The app-server could not say whether the thread is idle or running: the doorbell goes into the
  // CLI queue, which delivers when any running turn ends — so it is recorded as held, never as sent.
  // The release check still applies: without a server to ask, the CLI must match the pinned release.
  async #queueFallback(post, attempt) {
    const record = (state, extra = {}) => this.#record(post, state, extra, attempt);
    const pin = this.settings.codexVersion?.value;
    if (!pin) return record("not_sent", { errorCode: "VERSION_UNKNOWN", via: "queue" });
    let version = null; try { version = await this.cliVersion(this.settings.codexCli.value); } catch {}
    if (version !== pin) return record("not_sent", { errorCode: "VERSION_MISMATCH", via: "queue" });
    // The queue is still this attempt's: refused if the message was relinked meanwhile.
    const verdict = this.authorize(post.recipient, post.messageId, attempt);
    if (verdict !== true) return record("not_sent", { errorCode: verdict, via: "queue" });
    try { await this.enqueue({ cliPath: this.settings.codexCli.value, threadId: attempt.binding, cwd: "/" }, doorbell(post.messageId)); }
    catch (error) { return record(code(error) === "INVALID_QUEUE_CALL" ? "not_sent" : "unknown", { errorCode: code(error), via: "queue" }); }
    return record("held", { mode: "held_behind_running_turn", via: "queue" });
  }

  // The outcome names the attempt it belongs to: its binding, and its relink generation when not 0
  // (generation-0 rows keep their old shape). Readers judge the current generation by these rows.
  async #record(post, state, extra = {}, attempt = this.attemptOf(post)) {
    const row = await this.store.append("doorbell_outcome", { messageId: post.messageId, recipient: post.recipient, recipientKind: post.recipientKind, threadId: attempt.binding, state, ...(attempt.generation ? { relinkSeq: attempt.generation } : {}), ...extra });
    return { state, seq: row.seq, ...extra };
  }

  // The sweep (on start and every 5 minutes). For every unprocessed post to a Codex peer:
  //   (a) no intent (the intent write failed after the post was durable): write it and ring once;
  //   (b) an intent and no outcome, and no ring running here: retry once (same id; the wake
  //       reservation never sends twice); if that retry already happened, record unknown;
  //   (c) outcome not_sent, or unknown for more than 30 minutes: one alarm with the reason code.
  //       Never retried automatically: the cause (settings, release, host) is fixed by hand.
  async sweep() {
    const report = { intentsCreated: 0, retried: 0, exhausted: 0, alerted: 0 };
    for (const post of this.store.events.filter((e) => e.type === "peer_post" && ["codex", "claude"].includes(e.recipientKind))) {
      if (this.processed(post.messageId) || [...this.running.keys()].some((k) => k.startsWith(`${post.messageId}:`))) continue;
      const intent = this.intent(post.messageId); const outcome = this.outcome(post.messageId);
      if (!intent) { report.intentsCreated += 1; await this.ring(post.messageId, { first: true }); continue; }
      if (!outcome) {
        if (this.store.events.some((e) => e.type === "doorbell_retry" && sameUuid(e.messageId, post.messageId))) { report.exhausted += 1; await this.#record(post, "unknown", { errorCode: "RETRY_EXHAUSTED" }); continue; }
        report.retried += 1; await this.ring(post.messageId, { retry: true }); continue;
      }
      if (outcome.state !== "not_sent" && outcome.state !== "unknown") continue;
      if (outcome.state === "unknown" && this.now() - Date.parse(outcome.at) < UNKNOWN_ALERT_AFTER_MS) continue;
      if (this.store.events.some((e) => e.type === "doorbell_alerted" && sameUuid(e.messageId, post.messageId))) continue;
      await this.store.append("doorbell_alerted", { messageId: post.messageId, recipient: post.recipient, state: outcome.state, errorCode: outcome.errorCode ?? "UNKNOWN" });
      try { await this.alerts?.raise({ kind: outcome.state === "unknown" ? "doorbell_unknown" : "doorbell_not_sent", key: `doorbell:${post.messageId}`, code: outcome.errorCode ?? "UNKNOWN" }); } catch {}
      report.alerted += 1;
    }
    return report;
  }
  // M5 F2: ring again when the recipient comes back and a write to it would land (the daemon asks
  // PeerCore.reachable first), at most MAX_RERINGS times per message. A doorbell refused before it went out
  // (not_sent) left the message waiting for a session that was not there; the session that later
  // proves it is there — by running any authenticated command, or (Claude) by reappearing in the
  // session registry — gets that doorbell one more time. Only not_sent, never sent/held/unknown (those
  // may already have reached it); only while unprocessed and still bound to the session that is back;
  // each attempt recorded as `doorbell_rering`. The body is never sent again.
  // Eligible only if every doorbell outcome recorded for the message was not_sent (never sent, held
  // or unknown — any of those may already have reached it), the first one not for a quiet reason,
  // re-rung fewer than MAX_RERINGS times, unprocessed, and bound to the session that is back.
  static QUIET = new Set(["DOORBELL_NOT_CONFIGURED", "WAKE_ALREADY_PROCESSED", "WAKE_TARGET_MISMATCH"]);
  static MAX_RERINGS = 2;
  // One pass over the ledger for the questions below (status and the triggers ask them per post).
  againIndex(events = this.store.events) {
    const outcomes = new Map(); const closed = new Set(); const reRings = new Map();
    for (const e of events) {
      const id = typeof e.messageId === "string" ? e.messageId.toLowerCase() : null; if (!id) continue;
      if (e.type === "doorbell_outcome") { const list = outcomes.get(id) ?? []; list.push(e); outcomes.set(id, list); }
      else if (e.type === "peer_post_processed") closed.add(id);
      else if (e.type === "doorbell_rering") reRings.set(id, (reRings.get(id) ?? 0) + 1);
    }
    return { outcomes, closed, reRings };
  }
  // Eligible only if every doorbell outcome recorded for the message was not_sent (never sent, held
  // or unknown — any of those may already have reached it), the first one not for a quiet reason,
  // never re-rung, unprocessed, and still bound to the session its alias names now (a message for a
  // previous session is held for the Owner, never rung at the new one). status and both triggers ask
  // this one function, so what status promises is what a return will do.
  eligibleAgain(post, index = this.againIndex()) {
    const id = post.messageId.toLowerCase();
    if (this.generationOf(post) !== 0) return false;   // a relinked message is rung by ringRelinked
    const outcomes = index.outcomes.get(id) ?? [];
    // At most MAX_RERINGS re-rings per message. The triggers ring only when a write would land now
    // (the daemon asks PeerCore.reachable first), so a second one is for a return that a first one,
    // spent before that check existed or lost to a race, did not reach.
    if ((index.reRings.get(id) ?? 0) >= DoorbellService.MAX_RERINGS) return false;
    if (!outcomes.length || outcomes.some((e) => e.state !== "not_sent") || DoorbellService.QUIET.has(outcomes[0].errorCode) || index.closed.has(id) || [...this.running.keys()].some((k) => k.startsWith(`${post.messageId}:`))) return false;
    const current = post.recipientKind === "codex" ? this.codexPeers()?.[post.recipient]?.threadId : post.recipientKind === "claude" ? this.claudePeers()?.[post.recipient]?.sessionId : null;
    return typeof current === "string" && sameUuid(current, this.bindingOf(post) ?? "");
  }
  pendingNotSent(alias, binding = null) {
    const index = this.againIndex();
    return this.store.events.filter((post) => post.type === "peer_post" && post.recipient === alias && ["codex", "claude"].includes(post.recipientKind)
      && (binding === null || sameUuid(this.bindingOf(post) ?? "", binding)) && this.eligibleAgain(post, index));
  }
  async ringAgain(alias, { binding = null, trigger }) {
    const rung = [];
    for (const post of this.pendingNotSent(alias, binding)) {
      // The claim re-checks eligibility against the ledger as it is at the append, so a doorbell or
      // processing that landed meanwhile wins. `doorbell_rering` records the attempt, not success:
      // its outcome row follows, and status reads that.
      try { await this.store.appendChecked("doorbell_rering", { messageId: post.messageId, recipient: alias, trigger }, (events) => (this.eligibleAgain(post, this.againIndex(events)) ? null : Object.assign(new Error("not eligible"), { code: "DUP" }))); }
      catch (error) { if (error.code === "DUP") continue; throw error; }
      rung.push(await this.ring(post.messageId, {}));
    }
    return rung;
  }
  // Claude recipients come back by reappearing in the registry; `liveness(sessionId)` answers that.
  async ringReturnedClaude(liveness) {
    const aliases = new Set(this.store.events.filter((e) => e.type === "doorbell_outcome" && e.state === "not_sent" && e.recipientKind === "claude").map((e) => e.recipient));
    const rung = [];
    for (const alias of aliases) {
      const sessionId = this.claudePeers()?.[alias]?.sessionId;
      if (sessionId && this.pendingNotSent(alias, sessionId).length && (await liveness(sessionId)) === "running") rung.push(...await this.ringAgain(alias, { binding: sessionId, trigger: "registry" }));
    }
    return rung;
  }
  // M5: the Owner moved a held message to the alias's current session — ring it there now, once
  // (`doorbell_relink_ring` is the record), so the session that now holds it knows. Never the body.
  async ringRelinked(messageId) {
    const post = this.post(messageId); if (!post || this.processed(messageId)) return null;
    // Once per relink generation: A -> B and then B -> C are two moves and each is rung; the same
    // move is never rung twice, across concurrent calls and restarts (the claim is a ledger row).
    const generation = this.generationOf(post); if (!generation) return null;
    try { await this.store.appendChecked("doorbell_relink_ring", { messageId: post.messageId, recipient: post.recipient, threadId: this.bindingOf(post), relinkSeq: generation }, (events) => (events.some((e) => (e.type === "peer_post_processed" && sameUuid(e.messageId, messageId)) || (e.type === "doorbell_relink_ring" && sameUuid(e.messageId, messageId) && e.relinkSeq === generation)) ? Object.assign(new Error("claimed"), { code: "DUP" }) : null)); }
    catch (error) { if (error.code === "DUP") return null; throw error; }
    return this.ring(post.messageId, { generation });
  }
  resumeOpenIntents() { return this.sweep(); }
  sweepUnknown() { return this.sweep().then((r) => r.alerted); }
}
