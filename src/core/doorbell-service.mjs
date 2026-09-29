import { CodexWake, cliVersion as readCliVersion, enqueueCodex } from "../extensions/codex-queue/index.mjs";
import { doorbell } from "./doorbell.mjs";
import { sameUuid } from "./limits.mjs";

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
  constructor({ store, root, settings, codexPeers, alerts = null, wake = null, enqueue = enqueueCodex, cliVersion = readCliVersion, now = () => Date.now() }) {
    this.store = store; this.settings = settings; this.codexPeers = codexPeers; this.alerts = alerts; this.now = now; this.enqueue = enqueue; this.cliVersion = cliVersion;
    this.running = new Map();
    // No shared "current target": every ring passes its own immutable target (review [상]).
    this.wake = wake ?? new CodexWake({ root, authorize: (alias, messageId) => this.authorize(alias, messageId) });
  }
  configured() { return Boolean(this.settings.codexCli?.value && this.settings.codexAppServerSocket?.value); }
  post(messageId) { return this.store.events.find((e) => e.type === "peer_post" && sameUuid(e.messageId, messageId)) ?? null; }
  intent(messageId) { return this.store.events.find((e) => e.type === "doorbell_intent" && sameUuid(e.messageId, messageId)) ?? null; }
  outcome(messageId) { return this.store.events.find((e) => e.type === "doorbell_outcome" && sameUuid(e.messageId, messageId)) ?? null; }
  processed(messageId) { return this.store.events.some((e) => e.type === "peer_post_processed" && sameUuid(e.messageId, messageId)); }

  // Host settings + the thread of this one post.
  targetFor(post) {
    return { transport: "existing-app-server", cliPath: this.settings.codexCli.value, socketPath: this.settings.codexAppServerSocket.value, threadId: post.recipientThreadId, ...(this.settings.codexVersion?.value ? { codexVersion: this.settings.codexVersion.value } : {}) };
  }

  // Only a message in the daemon inbox, delivered to this alias and thread, not yet processed, and
  // whose alias still names that thread.
  authorize(alias, messageId) {
    const post = this.post(messageId);
    if (!post) return "WAKE_UNKNOWN_MESSAGE";
    if (post.recipient !== alias || post.recipientKind !== "codex" || typeof post.recipientThreadId !== "string") return "WAKE_NOT_RECIPIENT";
    if (this.processed(messageId)) return "WAKE_ALREADY_PROCESSED";
    const bound = this.codexPeers()?.[alias]?.threadId;
    if (!bound || !sameUuid(bound, post.recipientThreadId)) return "WAKE_TARGET_MISMATCH";
    return true;
  }

  // Called for every appended row; acts on accepted posts for Codex peers.
  async onAppend(row) {
    if (row?.type !== "peer_post" || row.recipientKind !== "codex") return;
    await this.ring(row.messageId, { first: true });
  }

  async ring(messageId, { first = false, retry = false } = {}) {
    if (this.running.has(messageId)) return this.running.get(messageId);
    const job = (async () => {
      const post = this.post(messageId);
      if (!post || post.recipientKind !== "codex") return { state: "not_applicable" };
      if (first) {
        try { await this.store.appendChecked("doorbell_intent", { messageId: post.messageId, recipient: post.recipient, threadId: post.recipientThreadId }, (events) => (events.some((e) => e.type === "doorbell_intent" && sameUuid(e.messageId, messageId)) ? Object.assign(new Error("dup"), { code: "DUP" }) : null)); }
        catch (error) { if (error.code !== "DUP") throw error; return { state: "duplicate_intent" }; }
      }
      if (retry) await this.store.append("doorbell_retry", { messageId: post.messageId });
      const verdict = this.authorize(post.recipient, post.messageId);
      if (verdict !== true) return this.#record(post, "not_sent", { errorCode: verdict, ...(verdict === "WAKE_TARGET_MISMATCH" ? { reason: "wake_target_mismatch", boundThreadId: this.codexPeers()?.[post.recipient]?.threadId ?? null } : {}) });
      if (!this.configured()) return this.#record(post, "not_sent", { errorCode: "DOORBELL_NOT_CONFIGURED" });
      try {
        const result = await this.wake.wake({ codexAlias: post.recipient, messageId: post.messageId, target: this.targetFor(post) });
        const state = result.mode === "held_behind_running_turn" ? "held" : "sent";
        return this.#record(post, state, { mode: result.mode, ...(result.turnId ? { turnId: result.turnId } : {}), ...(result.replay ? { replay: true } : {}) });
      } catch (error) {
        const c = code(error);
        if (c === "DELIVERY_UNCERTAIN") return this.#record(post, "unknown", { errorCode: c });
        if (c === "TARGET_UNAVAILABLE") return this.#queueFallback(post);
        return this.#record(post, "not_sent", { errorCode: c });
      }
    })();
    this.running.set(messageId, job);
    try { return await job; } finally { this.running.delete(messageId); }
  }

  // The app-server could not say whether the thread is idle or running: the doorbell goes into the
  // CLI queue, which delivers when any running turn ends — so it is recorded as held, never as sent.
  // The release check still applies: without a server to ask, the CLI must match the pinned release.
  async #queueFallback(post) {
    const pin = this.settings.codexVersion?.value;
    if (!pin) return this.#record(post, "not_sent", { errorCode: "VERSION_UNKNOWN", via: "queue" });
    let version = null; try { version = await this.cliVersion(this.settings.codexCli.value); } catch {}
    if (version !== pin) return this.#record(post, "not_sent", { errorCode: "VERSION_MISMATCH", via: "queue" });
    try { await this.enqueue({ cliPath: this.settings.codexCli.value, threadId: post.recipientThreadId, cwd: "/" }, doorbell(post.messageId)); }
    catch (error) { return this.#record(post, code(error) === "INVALID_QUEUE_CALL" ? "not_sent" : "unknown", { errorCode: code(error), via: "queue" }); }
    return this.#record(post, "held", { mode: "held_behind_running_turn", via: "queue" });
  }

  async #record(post, state, extra = {}) {
    const row = await this.store.append("doorbell_outcome", { messageId: post.messageId, recipient: post.recipient, threadId: post.recipientThreadId, state, ...extra });
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
    for (const post of this.store.events.filter((e) => e.type === "peer_post" && e.recipientKind === "codex")) {
      if (this.processed(post.messageId) || this.running.has(post.messageId)) continue;
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
  resumeOpenIntents() { return this.sweep(); }
  sweepUnknown() { return this.sweep().then((r) => r.alerted); }
}
