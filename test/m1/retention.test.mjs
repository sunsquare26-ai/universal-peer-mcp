import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { AlertSink } from "../../src/core/alerts.mjs";
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { hydrateInboundBodies } from "../../src/core/inbound-hydrate.mjs";
import { disposeInboundBody, expireInboundBodies, expiredBodyFiles } from "../../src/core/retention.mjs";
import { maintenanceConfig } from "../../src/core/maintenance.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { openStore, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) { await fsp.chmod(statePaths(r).events, 0o600).catch(() => {}); await fsp.rm(r, { recursive: true, force: true }); } });
const DAY = 86_400_000; const LATER = () => Date.now() + 31 * DAY;

// type "peer_reply" with a messageId that has a reply = concluded; "peer_frame_uncorrelated" = not.
async function stand() {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  const spool = new InboundSpool(statePaths(root));
  const alerts = new AlertSink({ file: path.join(root, "alerts.jsonl") });
  const add = async (type, body, extra = {}) => store.append(type, { ...extra, ...(await spool.write(body)) });
  const alertLines = async () => (await fsp.readFile(path.join(root, "alerts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { root, store, alerts, add, alertLines, file: (row) => path.join(root, row.bodyFile) };
}

test("the ledger row keeps no free text of the body, only the allowlisted header", async () => {
  const s = await stand();
  const a = await s.add("peer_frame_uncorrelated", "김서연 직원 OTP 481927\n둘째 줄", { reason: "no_reply_marker" });
  const b = await s.add("peer_frame_uncorrelated", "PEER_ACK re=14e6f292 note=김서연\n본문", { reason: "no_reply_marker" });
  expect(a.header).toBeUndefined(); expect(b.header).toEqual({ verb: "PEER_ACK", replyTo: "14e6f292" });
  const ledger = await fsp.readFile(statePaths(s.root).events, "utf8");
  for (const leak of ["김서연", "481927", "둘째 줄", "본문"]) expect(ledger).not.toContain(leak);
});

test("expiry is off by default (M1 install)", () => {
  expect(maintenanceConfig({}).retentionDays).toBe(0);
  expect(maintenanceConfig({ UNIVERSAL_PEER_BODY_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
});

test("an unprocessed body past 30 days is kept, recorded once and alarmed once", async () => {
  const s = await stand();
  const row = await s.add("peer_frame_uncorrelated", "UP_REVERSE_PROBE 55238af8", { reason: "no_reply_marker" });
  for (let i = 0; i < 3; i += 1) {
    const r = await expireInboundBodies({ root: s.root, store: s.store, alerts: s.alerts, now: LATER(), days: 30 });
    expect(r).toMatchObject({ expired: 0, unprocessed: 1, newlyExceeded: i === 0 ? 1 : 0 });
  }
  await fsp.access(s.file(row));
  expect(s.store.events.filter((e) => e.type === "inbound_body_retention_exceeded")).toHaveLength(1);
  expect((await s.alertLines()).map((a) => [a.kind, a.key, a.code])).toEqual([["retention_unprocessed", `retention_unprocessed:seq-${row.seq}`, `seq-${row.seq}`]]);
});

test("a sent message whose reply never came is unprocessed too; one with a reply is concluded", async () => {
  const s = await stand();
  const open = crypto.randomUUID(); const done = crypto.randomUUID();
  const ack = await s.add("peer_ack", "PEER_ACK re=00000000", { messageId: open });
  const reply = await s.add("peer_reply", `PEER_REPLY v=1 message_id=${crypto.randomUUID()} reply_to=${done} verdict=pass`, { messageId: done, verdict: "pass" });
  // The ACK body belongs to a message with an ACK: concluded by the rule (ACK, REPLY or processed).
  const r = await expireInboundBodies({ root: s.root, store: s.store, alerts: s.alerts, now: LATER(), days: 30 });
  expect(r).toMatchObject({ expired: 2, unprocessed: 0 });
  await expect(fsp.access(s.file(ack))).rejects.toThrow(); await expect(fsp.access(s.file(reply))).rejects.toThrow();
  const expired = s.store.events.filter((e) => e.type === "inbound_body_expired");
  expect(expired.map((e) => e.reason)).toEqual(["retention", "retention"]);
  const [hydrated] = await hydrateInboundBodies([reply], { root: s.root, expired: expiredBodyFiles(s.store.events) });
  expect(hydrated.bodyInlineOmitted).toBe("expired");
});

test("a body marked processed becomes eligible; discard deletes now, both recorded", async () => {
  const s = await stand();
  const a = await s.add("peer_frame_uncorrelated", "one", { reason: "no_reply_marker" });
  const b = await s.add("peer_frame_uncorrelated", "two", { reason: "no_reply_marker" });
  expect(await disposeInboundBody({ root: s.root, store: s.store, sourceSeq: a.seq, disposition: "processed" })).toEqual({ disposition: "processed", state: "recorded" });
  expect((await expireInboundBodies({ root: s.root, store: s.store, now: Date.now() + DAY, days: 30 })).expired).toBe(0);
  expect((await expireInboundBodies({ root: s.root, store: s.store, now: LATER(), days: 30 })).expired).toBe(1);
  await expect(fsp.access(s.file(a))).rejects.toThrow();
  expect(await disposeInboundBody({ root: s.root, store: s.store, sourceSeq: b.seq, disposition: "discard" })).toEqual({ disposition: "discard", state: "expired" });
  await expect(fsp.access(s.file(b))).rejects.toThrow();
  const types = s.store.events.map((e) => e.type);
  expect(types.indexOf("inbound_body_disposition")).toBeLessThan(types.lastIndexOf("inbound_body_expired"));
  await expect(disposeInboundBody({ root: s.root, store: s.store, sourceSeq: b.seq, disposition: "delete-all" })).rejects.toMatchObject({ code: "INVALID_CONTROL_ARGUMENTS" });
  const notABody = s.store.events.find((e) => e.type === "inbound_body_disposition").seq;
  await expect(disposeInboundBody({ root: s.root, store: s.store, sourceSeq: notABody, disposition: "discard" })).rejects.toMatchObject({ code: "BODY_UNKNOWN" });
  expect(await disposeInboundBody({ root: s.root, store: s.store, sourceSeq: a.seq, disposition: "discard" })).toEqual({ disposition: "discard", state: "already_expired" });
});

test("hundreds of unprocessed bodies: every one recorded, alarms capped per run plus one summary", async () => {
  const s = await stand();
  for (let i = 0; i < 12; i += 1) await s.add("peer_frame_uncorrelated", `b${i}`, { reason: "no_reply_marker" });
  const r = await expireInboundBodies({ root: s.root, store: s.store, alerts: s.alerts, now: LATER(), days: 30 });
  expect(r.newlyExceeded).toBe(12);
  const alerts = await s.alertLines();
  expect(alerts).toHaveLength(6);
  expect(alerts.at(-1)).toMatchObject({ kind: "retention_unprocessed", code: "7" });
});

test("a concluded body whose file does not match its digest is kept and reported once", async () => {
  const s = await stand(); const id = crypto.randomUUID();
  const row = await s.add("peer_reply", "PEER_REPLY re=00000000", { messageId: id });
  await fsp.writeFile(s.file(row), "replaced", { mode: 0o600 });
  for (let i = 0; i < 2; i += 1) expect((await expireInboundBodies({ root: s.root, store: s.store, now: LATER(), days: 30 })).skipped).toBe(1);
  await fsp.access(s.file(row));
  expect(s.store.events.filter((e) => e.type === "inbound_body_expire_skipped")).toHaveLength(1);
});

test("nothing is deleted when the ledger will not record it", async () => {
  const s = await stand(); const id = crypto.randomUUID();
  const row = await s.add("peer_reply", "PEER_REPLY re=00000000", { messageId: id });
  await fsp.chmod(statePaths(s.root).events, 0o400);
  expect((await expireInboundBodies({ root: s.root, store: s.store, now: LATER(), days: 30 })).stoppedBy).toBe("ledger_append_failed");
  await fsp.access(s.file(row));
});

test("a row with no digest never leads to a deletion", async () => {
  const s = await stand(); const id = crypto.randomUUID();
  const row = await s.add("peer_reply", "x", { messageId: id });
  delete s.store.events.find((e) => e.seq === row.seq).bodySha256;
  expect((await expireInboundBodies({ root: s.root, store: s.store, now: LATER(), days: 30 })).expired).toBe(0);
  await fsp.access(s.file(row));
});
