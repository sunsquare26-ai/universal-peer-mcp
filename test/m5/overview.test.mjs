import { expect, test } from "bun:test";
import { overview, renderOverview } from "../../src/core/overview.mjs";

const NOW = Date.parse("2026-10-05T14:00:00Z");
const at = (min) => new Date(NOW - min * 60000).toISOString();
const A = "aaaaaaaa-1111-4111-8111-111111111111"; const B = "bbbbbbbb-1111-4111-8111-111111111111";
const peers = [{ alias: "c-1", kind: "claude", sessionId: "11111111-1111-4111-8111-111111111111" }, { alias: "x-1", kind: "codex", threadId: "01a10000-8d9b-7ba0-8228-4bef09bbe67e" }];
const events = [
  { seq: 1, type: "peer_post", at: at(30), messageId: A, recipient: "c-1", senderAlias: "x-1" },
  { seq: 2, type: "doorbell_outcome", at: at(30), messageId: A, state: "not_sent" },
  { seq: 3, type: "peer_post", at: at(10), messageId: B, recipient: "x-1", senderAlias: "c-1" },
  { seq: 4, type: "peer_post_processed", at: at(5), messageId: B, readerAlias: "x-1" },
  { seq: 5, type: "peer_post", at: at(1), messageId: "cccccccc-1111-4111-8111-111111111111", recipient: "x-1", senderAlias: "universal-peer", source: "receipt" },
  { seq: 6, type: "peer_post", at: at(60), messageId: "dddddddd-1111-4111-8111-111111111111", recipient: "gone-1", senderAlias: "c-1" }
];

test("observed facts only: presence, last activity, unprocessed, undelivered, held, unregistered", () => {
  const v = overview({ events, peers, presence: new Map([["c-1", "not_running"]]), eligible: () => true, now: NOW, held: new Map([["c-1", 2]]) });
  expect(v.peers).toEqual([
    { alias: "c-1", kind: "claude", session: "11111111", present: "not_running", lastSeenAt: at(10), unprocessed: 1, oldestUnprocessedAt: at(30), undelivered: 1, uncertain: 0, autoRetry: 1, held: 2, heldIds: [] },
    { alias: "x-1", kind: "codex", session: "01a10000", present: "unknown", lastSeenAt: at(5), unprocessed: 1, oldestUnprocessedAt: at(1), undelivered: 0, uncertain: 0, autoRetry: 0, held: 0, heldIds: [] }
  ]);
  expect(v.unregistered).toEqual([{ alias: "gone-1", unprocessed: 1, oldestUnprocessedAt: at(60), ids: ["dddddddd-1111-4111-8111-111111111111"] }]);
});
test("the latest outcome decides: a re-ring that failed again still shows as not delivered (review P1)", () => {
  const more = [...events, { seq: 7, type: "doorbell_rering", at: at(2), messageId: A }, { seq: 8, type: "doorbell_outcome", at: at(2), messageId: A, state: "unknown" }];
  const v = overview({ events: more, peers, now: NOW });
  expect(v.peers[0]).toMatchObject({ undelivered: 0, uncertain: 1, autoRetry: 0 });
  const text = renderOverview(v, NOW);
  expect(text).toContain("전달 불확실 1건");
  expect(text).toContain("universal-peer-mcp open c-1");
});
test("not eligible for the automatic ring is said plainly, not promised (review P2)", () => {
  const text = renderOverview(overview({ events, peers, eligible: () => false, now: NOW }), NOW);
  expect(text).toContain("자동 재알림 대상이 아닌 미전달 1건");
  expect(text).not.toContain("자동으로 한 번 더");
  expect(text).toContain("gone-1(등록 없음)");
});

test("a session opened the wrong way is named, with the one command that fixes it", () => {
  const v = overview({ events, peers, presence: new Map([["c-1", "misopened"]]), presenceReason: new Map([["c-1", "argv_executable_mismatch"]]), now: NOW });
  expect(v.peers[0]).toMatchObject({ present: "misopened", presentReason: "argv_executable_mismatch" });
  const text = renderOverview(v, NOW);
  expect(text).toContain("잘못 열림");
  expect(text).toContain("universal-peer-mcp open c-1");
});
