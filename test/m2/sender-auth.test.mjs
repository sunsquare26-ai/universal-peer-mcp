import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import { createSenderResolver } from "../../src/core/sender-auth.mjs";
import { tempRoot } from "../m1/helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const MAIN = "11111111-1111-4111-8111-111111111111"; const OTHER = "22222222-2222-4222-8222-222222222222";
const TABLE = { "main-claude": { sessionId: MAIN } };
// pid -> real start; 500 is claude-main, 600 another Claude session, 700 a shell under claude-main,
// 800 the daemon's own registration.
const STARTS = { 500: "Mon Sep 28 03:18:28 2026", 600: "Mon Sep 28 14:19:31 2026", 700: "Tue Sep 29 09:00:00 2026", 800: "Tue Sep 29 09:06:25 2026" };
const PARENT = { 700: 500, 500: 1, 600: 1, 800: 1 };

async function stand(rows) {
  const root = await tempRoot(); roots.push(root);
  const dir = path.join(root, "sessions"); await fsp.mkdir(dir, { mode: 0o700 });
  for (const row of rows) { const f = path.join(dir, `${row.pid}.json`); await fsp.writeFile(f, JSON.stringify(row)); await fsp.chmod(f, row.mode ?? 0o644); }
  return createSenderResolver({ sessionsDir: dir, allowlist: () => TABLE, startReader: (pid) => STARTS[pid], parentReader: (pid) => PARENT[pid] ?? 1, selfPid: 999 });
}
const ROWS = [
  { pid: 500, sessionId: MAIN, procStart: STARTS[500], name: "프라이데이" },
  { pid: 600, sessionId: OTHER, procStart: STARTS[600], name: "other" },
  { pid: 800, sessionId: "33333333-3333-4333-8333-333333333333", procStart: STARTS[800], name: "universal-peer-mcp" }
];

test("the allowlisted session writing directly is authenticated", async () => {
  const resolve = await stand(ROWS);
  expect(await resolve({ pid: 500, procStart: STARTS[500] })).toMatchObject({ authenticated: true, alias: "main-claude", sessionId: MAIN, depth: 0 });
});

test("another live Claude session is not claude-main, whatever it writes", async () => {
  const resolve = await stand(ROWS);
  expect(await resolve({ pid: 600, procStart: STARTS[600] })).toMatchObject({ authenticated: false, reason: "session_not_allowlisted" });
});

test("a recycled pid (kernel start differs from the row) is refused", async () => {
  const resolve = await stand(ROWS);
  expect(await resolve({ pid: 500, procStart: "Wed Oct 01 00:00:00 2026" })).toMatchObject({ authenticated: false, reason: "process_identity_changed" });
  const stale = await stand([{ ...ROWS[0], procStart: "Sun Sep 27 00:00:00 2026" }]);
  expect(await stale({ pid: 500, procStart: STARTS[500] })).toMatchObject({ authenticated: false, reason: "process_identity_changed" });
});

test("the daemon's own registration is never a sender", async () => {
  const resolve = await stand(ROWS);
  expect(await resolve({ pid: 800, procStart: STARTS[800] })).toMatchObject({ authenticated: false, reason: "self_registration" });
});

test("a row others can write is not evidence", async () => {
  const resolve = await stand([{ ...ROWS[0], mode: 0o666 }]);
  expect((await resolve({ pid: 500, procStart: STARTS[500] })).authenticated).toBe(false);
});

test("a control caller is walked up to its session; frames are not walked", async () => {
  const resolve = await stand(ROWS);
  expect(await resolve({ pid: 700, procStart: STARTS[700] }, { walk: true })).toMatchObject({ authenticated: true, alias: "main-claude", depth: 1 });
  expect(await resolve({ pid: 700, procStart: STARTS[700] })).toMatchObject({ authenticated: false, reason: "no_session_row" });
});
