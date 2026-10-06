import { acceptPost, uuidv5 } from "./posts.mjs";
import { sameUuid } from "./limits.mjs";

// Receipts (M5 F0): the sender is told when its message is stuck, so neither side sits waiting.
//
// The owner's first complaint about this product was not lost bytes — the ledger shows 96% of
// doorbells read within a minute — it was two sessions both idle, each waiting on the other. The
// stalls had one shape: something went wrong on the receiving side and the sending side was never
// told. So the sender gets one short notice, in its own inbox, rung by the ordinary doorbell, when:
//
//   not_delivered  the automatic doorbell could not be sent (doorbell_outcome not_sent) and the
//                  message is still unprocessed. Whether the recipient saw it some other way is not
//                  known, and the text says exactly that.
//   queued_busy    the doorbell went into the recipient's queue instead of starting a turn
//                  (doorbell_outcome held), and the message is still unprocessed.
//   no_reply_yet   the sender asked for an answer (`post --expect-reply`), the recipient marked the
//                  message processed, and REPLY_GRACE_MS later there is still no `--reply-to` answer.
//                  Opt-in on purpose: the ledger (2026-10-05, 617 processed new posts) shows a quarter
//                  processed without an answer, many of them by design, and 19 answered after the ack.
//
// A receipt is a post like any other: same inbox, same ack, same doorbell, bound to the sending
// session. Its id is derived from (state, original id): acceptPost refuses a second post with that
// id, so a retry, a restart or the sweep can never send it twice. It carries metadata only — never a
// word of the original body — and it never resends anything. Receipts never produce receipts.
//
// Durability: the fast path runs from the append hook; `sweep()` runs at start and every minute and
// re-derives every receipt that is due from the ledger alone, so a daemon that died between the
// cause row and the receipt row still sends it. Only posts after the `receipts_enabled` row (written
// once, by the first daemon with this feature) are considered — history is never re-notified.
export const RECEIPT_SENDER = "universal-peer";
export const RECEIPT_SOURCE = "receipt";
export const REPLY_GRACE_MS = 10 * 60 * 1000;
const QUIET_CODES = new Set(["DOORBELL_NOT_CONFIGURED", "WAKE_ALREADY_PROCESSED", "WAKE_GENERATION_STALE"]);

const TEXT = {
  not_delivered: (post, code) => `[universal-peer 알림] 보낸 메시지 ${post.messageId} (받는 사람 ${post.recipient})의 자동 도착 알림을 보내지 못했습니다 (${code ?? "UNKNOWN"}). 상대가 이 메시지를 봤는지는 확인되지 않았고, 아직 처리 표시도 없습니다. 상대 세션이 꺼졌거나 연결이 끊겼을 수 있습니다. 답을 기다리며 멈춰 있지 말고, 하던 일을 계속하거나 사용자에게 알리세요. 같은 내용을 자동으로 다시 보내지는 마세요. 이 알림에는 답장하지 말고 읽은 뒤 inbox-ack 만 하세요.`,
  queued_busy: (post) => `[universal-peer 알림] 보낸 메시지 ${post.messageId} (받는 사람 ${post.recipient})의 도착 알림이 바로 전달되지 못하고 상대의 대기열에 들어갔습니다. 상대가 진행 중인 작업을 마친 뒤에 볼 가능성이 큽니다. 기다리는 동안 다른 일을 계속해도 됩니다. 이 알림에는 답장하지 말고 읽은 뒤 inbox-ack 만 하세요.`,
  no_reply_yet: (post, code) => `[universal-peer 알림] 답을 요청한 메시지 ${post.messageId} (받는 사람 ${post.recipient})를 상대가 처리 완료로 표시한 지 ${Math.round(REPLY_GRACE_MS / 60000)}분이 지났지만 이 메시지에 대한 --reply-to 답장은 없습니다.${code === "LATER_POST_WITHOUT_REPLY_TO" ? " 상대는 그 뒤 당신에게 다른 메시지를 보냈으니, 그 안에 답이 있는지 먼저 확인하세요." : ""} 답을 기다리며 멈춰 있지 말고, 다음 단계로 진행하거나 필요하면 새 메시지로 다시 물어보세요. 이 알림에는 답장하지 말고 읽은 뒤 inbox-ack 만 하세요.`
};

export function receiptId(state, messageId) { return uuidv5(`receipt:${state}:${messageId.toLowerCase()}`); }

function senderBinding(post) {
  if (post.senderKind === "codex") return typeof post.senderThreadId === "string" ? { recipientKind: "codex", recipientThreadId: post.senderThreadId } : null;
  return typeof post.senderSessionId === "string" ? { recipientKind: "claude", recipientSessionId: post.senderSessionId } : null;
}

// One pass over the ledger: what the per-post questions below need, keyed by lowercase message id.
export function receiptIndex(events) {
  const processed = new Map(); const answered = new Set(); const firstOutcome = new Map(); const posts = new Set(); const lastBetween = new Map();
  for (const e of events) {
    const id = typeof e.messageId === "string" ? e.messageId.toLowerCase() : null;
    if (e.type === "peer_post_processed" && id && !processed.has(id)) processed.set(id, e);
    else if (e.type === "doorbell_outcome" && id && !firstOutcome.has(id)) firstOutcome.set(id, e);
    else if (e.type === "peer_post") {
      if (id) posts.add(id); if (typeof e.replyTo === "string") answered.add(e.replyTo.toLowerCase());
      if (e.source !== RECEIPT_SOURCE && typeof e.senderAlias === "string" && typeof e.recipient === "string") lastBetween.set(`${e.senderAlias}>${e.recipient}`, e.seq);
    }
  }
  return { processed, answered, firstOutcome, posts, lastBetween };
}

// Pure: every receipt due for one post, given the ledger and the clock. Nothing here depends on
// which row triggered the call, so the hook and the sweep reach the same answer.
export function receiptsDue(post, events, now = Date.now(), index = receiptIndex(events)) {
  if (!post || post.type !== "peer_post" || post.source === RECEIPT_SOURCE || typeof post.senderAlias !== "string") return [];
  const binding = senderBinding(post); if (!binding) return [];
  const id = post.messageId.toLowerCase();
  const processed = index.processed.get(id);
  // Answered means a `--reply-to` answer to this message and nothing else: a later post from the
  // recipient may answer another question or report something unrelated (review of 3af38da), and
  // guessing would hide exactly the stall this exists to show. The later activity is only context
  // in the notice's text. (Measured 2026-10-05: main-claude answered with a new post; the Claude
  // doorbell's guidance now names post --reply-to.)
  const answered = index.answered.has(id);
  const back = index.lastBetween.get(`${post.recipient}>${post.senderAlias}`);
  const laterActivity = typeof back === "number" && back > post.seq;
  const due = [];
  // Only the first outcome speaks for the message; a retry's later row does not notify again.
  const first = index.firstOutcome.get(id);
  if (first && !processed && !answered) {
    if (first.state === "not_sent" && !QUIET_CODES.has(first.errorCode)) due.push({ state: "not_delivered", code: first.errorCode ?? null });
    else if (first.state === "held") due.push({ state: "queued_busy", code: null });
  }
  if (post.expectReply === true && !post.replyTo && processed && !answered && now - Date.parse(processed.at) >= REPLY_GRACE_MS) due.push({ state: "no_reply_yet", code: laterActivity ? "LATER_POST_WITHOUT_REPLY_TO" : null });
  return due.map((r) => ({ ...r, post, binding, messageId: receiptId(r.state, id) })).filter((r) => !index.posts.has(r.messageId));
}

export class ReceiptService {
  constructor({ store, spool, now = () => Date.now() }) { this.store = store; this.spool = spool; this.now = now; this.chain = Promise.resolve(); }
  // Everything runs on one chain, so the hook for one row and the sweep never interleave.
  #serial(task) { const run = this.chain.then(task); this.chain = run.catch(() => {}); return run; }
  cutoff() { return this.store.events.find((e) => e.type === "receipts_enabled")?.seq ?? null; }
  async enable() { return this.#serial(async () => { if (this.cutoff() === null) await this.store.append("receipts_enabled", { states: Object.keys(TEXT), replyGraceMs: REPLY_GRACE_MS }); }); }
  #candidate(post) { const cutoff = this.cutoff(); return cutoff !== null && post.seq > cutoff; }
  async #send(receipts) {
    const sent = [];
    for (const { post, state, code, binding, messageId } of receipts) {
      // Re-judged against the ledger as it is now: an earlier receipt in this batch awaited a write,
      // and the original may have been processed or answered meanwhile.
      if (!receiptsDue(post, this.store.events, this.now()).some((r) => r.messageId === messageId)) continue;
      sent.push(await acceptPost({
        store: this.store, spool: this.spool, messageId, recipient: post.senderAlias, body: TEXT[state](post, code), source: RECEIPT_SOURCE,
        who: { senderAlias: RECEIPT_SENDER, senderKind: "system", ...binding, receiptState: state, receiptFor: post.messageId, ...(code ? { receiptCode: code } : {}) }
      }));
    }
    return sent;
  }
  // Fast path: a doorbell outcome just landed.
  onAppend(row) {
    if (row?.type !== "doorbell_outcome") return null;
    return this.#serial(async () => {
      const post = this.store.events.find((e) => e.type === "peer_post" && sameUuid(e.messageId, row.messageId));
      if (!post || !this.#candidate(post)) return [];
      return this.#send(receiptsDue(post, this.store.events, this.now()).filter((r) => r.state !== "no_reply_yet"));
    });
  }
  // Recovery and the reply deadline: derive every due receipt from the ledger.
  sweep() {
    return this.#serial(async () => {
      const cutoff = this.cutoff(); if (cutoff === null) return [];
      const due = []; const index = receiptIndex(this.store.events); const now = this.now();
      for (const post of this.store.events) if (post.type === "peer_post" && post.seq > cutoff) due.push(...receiptsDue(post, this.store.events, now, index));
      return this.#send(due);
    });
  }
}
