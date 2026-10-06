import { describe, expect, test } from "bun:test";
import { receiptId, receiptsDue, REPLY_GRACE_MS, RECEIPT_SOURCE, ReceiptService } from "../../src/core/receipts.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const SENDER = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-10-05T12:00:00Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const post = (extra = {}) => ({ seq: 10, type: "peer_post", at: at(0), messageId: ID, recipient: "codex-dev", recipientKind: "codex", senderAlias: "app-claude", senderSessionId: SENDER, source: "control", ...extra });
const outcome = (state, extra = {}) => ({ seq: 11, type: "doorbell_outcome", at: at(1000), messageId: ID, state, ...extra });
const processed = (ms = 2000) => ({ seq: 12, type: "peer_post_processed", at: at(ms), messageId: ID });
const reply = { seq: 13, type: "peer_post", at: at(3000), messageId: "33333333-3333-4333-8333-333333333333", replyTo: ID };
const states = (events, now = T0 + 5000) => receiptsDue(events[0], events, now).map((r) => r.state);

describe("receipts tell the sender when its message is stuck", () => {
  test("doorbell not sent and still unprocessed → not_delivered to the sending session, with the code", () => {
    const [r] = receiptsDue(post(), [post(), outcome("not_sent", { errorCode: "TARGET_UNAVAILABLE" })], T0);
    expect(r).toMatchObject({ state: "not_delivered", code: "TARGET_UNAVAILABLE", binding: { recipientKind: "claude", recipientSessionId: SENDER } });
    expect(r.messageId).toBe(receiptId("not_delivered", ID));
  });
  test("held → queued_busy; sent → nothing; quiet codes → nothing", () => {
    expect(states([post(), outcome("held")])).toEqual(["queued_busy"]);
    expect(states([post(), outcome("sent")])).toEqual([]);
    expect(states([post(), outcome("not_sent", { errorCode: "DOORBELL_NOT_CONFIGURED" })])).toEqual([]);
  });
  test("a message already processed or answered is not reported as stuck (review P2)", () => {
    expect(states([post(), processed(500), outcome("not_sent", { errorCode: "TARGET_UNAVAILABLE" })])).toEqual([]);
    expect(states([post(), reply, outcome("held")])).toEqual([]);
  });
  test("only the first outcome speaks", () => {
    expect(states([post(), outcome("sent"), outcome("not_sent", { seq: 19 })])).toEqual([]);
  });
  test("no_reply_yet is opt-in and waits out the grace (review P1)", () => {
    expect(states([post(), outcome("sent"), processed()], T0 + REPLY_GRACE_MS * 2)).toEqual([]);
    const asked = post({ expectReply: true });
    expect(states([asked, outcome("sent"), processed()], T0 + 2000 + REPLY_GRACE_MS - 1)).toEqual([]);
    expect(states([asked, outcome("sent"), processed()], T0 + 2000 + REPLY_GRACE_MS)).toEqual(["no_reply_yet"]);
    expect(states([asked, outcome("sent"), processed(), reply], T0 + REPLY_GRACE_MS * 2)).toEqual([]);
  });
  test("codex senders are answered on their thread; receipts and unauthenticated senders get none", () => {
    const codex = post({ senderKind: "codex", senderSessionId: undefined, senderThreadId: "01a10000-8d9b-7ba0-8228-4bef09bbe67e" });
    expect(receiptsDue(codex, [codex, outcome("held")])[0].binding).toEqual({ recipientKind: "codex", recipientThreadId: "01a10000-8d9b-7ba0-8228-4bef09bbe67e" });
    expect(states([post({ source: RECEIPT_SOURCE }), outcome("held")])).toEqual([]);
    expect(states([post({ senderAlias: undefined }), outcome("held")])).toEqual([]);
  });
});

function fakeStore(initial) {
  const events = [...initial]; let seq = Math.max(0, ...events.map((e) => e.seq));
  const push = (type, row) => { const r = { seq: ++seq, at: new Date().toISOString(), type, ...row }; events.push(r); return r; };
  return { events, paths: { root: "/nowhere" }, append: async (t, r) => push(t, r), appendChecked: async (t, r, check) => { const e = check(events); if (e) throw e; return push(t, r); } };
}
const spool = { write: async (body) => ({ bodyFile: "inbound/x.txt", bodyBytes: Buffer.byteLength(body), bodySha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") }) };

describe("ReceiptService", () => {
  test("history before receipts_enabled is never re-notified", async () => {
    const store = fakeStore([post({ seq: 1 }), outcome("not_sent", { seq: 2, errorCode: "TARGET_UNAVAILABLE" })]);
    const svc = new ReceiptService({ store, spool });
    await svc.enable(); await svc.enable();
    expect(store.events.filter((e) => e.type === "receipts_enabled")).toHaveLength(1);
    expect(await svc.sweep()).toEqual([]);
  });
  test("fast path once; a restart's sweep neither repeats it nor misses one the hook never wrote (review P1)", async () => {
    const store = fakeStore([]);
    const svc = new ReceiptService({ store, spool }); await svc.enable();
    const p = post({ seq: 50 }); store.events.push(p);
    const o = outcome("not_sent", { seq: 51, errorCode: "VERSION_MISMATCH" }); store.events.push(o);
    expect((await svc.onAppend(o)).map((r) => r.state)).toEqual(["accepted"]);
    expect(await svc.sweep()).toEqual([]);
    const p2 = post({ seq: 60, messageId: "44444444-4444-4444-8444-444444444444" }); store.events.push(p2);
    store.events.push(outcome("held", { seq: 61, messageId: p2.messageId }));   // hook never ran: daemon died here
    const recovered = await new ReceiptService({ store, spool }).sweep();
    expect(recovered.map((r) => r.state)).toEqual(["accepted"]);
    const receipts = store.events.filter((e) => e.type === "peer_post" && e.source === RECEIPT_SOURCE);
    expect(receipts.map((r) => r.receiptState).sort()).toEqual(["not_delivered", "queued_busy"]);
    expect(receipts[0]).toMatchObject({ recipient: "app-claude", recipientKind: "claude", recipientSessionId: SENDER, senderAlias: "universal-peer" });
  });
});

test("only a --reply-to answer counts; later unrelated or other-question posts do not hide anything (review of 3af38da)", () => {
  const asked = post({ expectReply: true });
  const other = { seq: 20, type: "peer_post", at: at(3000), messageId: "55555555-5555-4555-8555-555555555555", recipient: "app-claude", senderAlias: "codex-dev", replyTo: "66666666-6666-4666-8666-666666666666" };
  const due = receiptsDue(asked, [asked, outcome("sent"), processed(), other], T0 + REPLY_GRACE_MS * 2);
  expect(due.map((r) => [r.state, r.code])).toEqual([["no_reply_yet", "LATER_POST_WITHOUT_REPLY_TO"]]);
  expect(states([post(), outcome("not_sent", { errorCode: "TARGET_UNAVAILABLE" }), other], T0)).toEqual(["not_delivered"]);
  expect(receiptsDue(asked, [asked, outcome("sent"), processed()], T0 + REPLY_GRACE_MS * 2)[0].code).toBeNull();
});
