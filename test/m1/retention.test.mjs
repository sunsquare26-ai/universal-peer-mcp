import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { hydrateInboundBodies } from "../../src/core/inbound-hydrate.mjs";
import { expireInboundBodies, expiredBodyFiles } from "../../src/core/retention.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { openStore, tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) { await fsp.chmod(statePaths(r).events, 0o600).catch(() => {}); await fsp.rm(r, { recursive: true, force: true }); } });
const DAY = 86_400_000;

async function withBody(body) {
  const root = await tempRoot(); roots.push(root);
  const store = await openStore(root);
  const spooled = await new InboundSpool(statePaths(root)).write(body);
  const row = await store.append("peer_frame_uncorrelated", { reason: "no_reply_marker", ...spooled });
  return { root, store, row, file: path.join(root, row.bodyFile) };
}

test("spooled rows keep a masked first line", async () => {
  const { row } = await withBody("김민희 010-1234-5678 님 연락처\n둘째 줄");
  expect(row.firstLine).toBe("김민희 [phone] 님 연락처");
});

test("a body younger than the retention is kept", async () => {
  const { root, store, file } = await withBody("hello");
  expect((await expireInboundBodies({ root, store, now: Date.now() + 29 * DAY })).expired).toBe(0);
  await fsp.access(file);
});

test("an old body is recorded, then deleted; hydration says expired, not unreadable", async () => {
  const { root, store, row, file } = await withBody("PEER_POST 010-1234-5678\nsecret body");
  const result = await expireInboundBodies({ root, store, now: Date.now() + 31 * DAY });
  expect(result).toMatchObject({ expired: 1, skipped: 0 });
  await expect(fsp.access(file)).rejects.toThrow();
  const expiredRow = store.events.find((e) => e.type === "inbound_body_expired");
  expect(expiredRow).toMatchObject({ sourceSeq: row.seq, bodyFile: row.bodyFile, bodySha256: row.bodySha256, firstLine: "PEER_POST [phone]" });
  expect(JSON.stringify(store.events)).not.toContain("secret body");
  const [hydrated] = await hydrateInboundBodies([row], { root, expired: expiredBodyFiles(store.events) });
  expect(hydrated.bodyInlineOmitted).toBe("expired");
  const [plain] = await hydrateInboundBodies([row], { root });
  expect(plain.bodyInlineOmitted).toBe("unreadable");
  // Second run: nothing more to do.
  expect((await expireInboundBodies({ root, store, now: Date.now() + 31 * DAY })).expired).toBe(0);
});

test("a file whose digest does not match its row is kept and reported once", async () => {
  const { root, store, file } = await withBody("original");
  await fsp.writeFile(file, "replaced", { mode: 0o600 });
  for (let i = 0; i < 2; i += 1) expect((await expireInboundBodies({ root, store, now: Date.now() + 31 * DAY })).skipped).toBe(1);
  await fsp.access(file);
  expect(store.events.filter((e) => e.type === "inbound_body_expire_skipped")).toHaveLength(1);
});

test("nothing is deleted when the ledger will not record the expiry", async () => {
  const { root, store, file } = await withBody("keep me");
  await fsp.chmod(statePaths(root).events, 0o400);
  const result = await expireInboundBodies({ root, store, now: Date.now() + 31 * DAY });
  expect(result.stoppedBy).toBe("ledger_append_failed");
  await fsp.access(file);
});

test("retention 0 switches deletion off", async () => {
  const { root, store, file } = await withBody("x");
  expect((await expireInboundBodies({ root, store, now: Date.now() + 400 * DAY, days: 0 })).disabled).toBe(true);
  await fsp.access(file);
});

test("a row that names a file but carries no digest never leads to a deletion", async () => {
  const { root, store, row, file } = await withBody("no digest row");
  await store.append("some_extension_row", { bodyFile: row.bodyFile });
  const events = store.events; const source = events.find((e) => e.seq === row.seq); delete source.bodySha256;
  expect((await expireInboundBodies({ root, store, now: Date.now() + 31 * DAY })).expired).toBe(0);
  await fsp.access(file);
});
