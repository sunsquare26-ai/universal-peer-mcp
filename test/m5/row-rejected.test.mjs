// M5: a registry row that is there and refused as a file is reported as such, never as "nothing is
// running" — and it is still never trusted. Measured 2026-11-08 (seq 99197-99201, 99208, 99777): a
// session in use for twelve days was reported off for seven hours, its own `whoami` said "not a
// session", and the owner relayed a message by hand and reopened the session twice.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveSuccessor, sessionLiveness, sessionPresence } from "../../src/adapters/claude-native-v1/registry.mjs";
import { processStart, readProcessArgv } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";
import { createSenderResolver } from "../../src/core/sender-auth.mjs";
import { targetDiagnostic } from "../../src/core/target-diagnostics.mjs";
import { renderOverview, renderRestore } from "../../src/core/overview.mjs";

const roots = []; const spawned = []; const closers = [];
afterEach(async () => {
  for (const c of spawned.splice(0)) c.kill();
  for (const close of closers.splice(0)) await close();
  for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true });
});
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002";
const P = ["--permission-mode", "bypassPermissions"];

async function bench() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "upm-rowrej-"))); roots.push(root); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.chmod(sessionsDir, 0o700);
  return { root, sessionsDir };
}
async function hold(args) {
  const child = Bun.spawn({ cmd: [process.execPath, "-e", "setTimeout(() => {}, 600000)", ...args], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  spawned.push(child);
  for (let i = 0; i < 400; i += 1) {
    try { const argv = readProcessArgv(child.pid); if (args.every((v, k) => argv[argv.length - args.length + k] === v)) { await Bun.sleep(30); return { pid: child.pid, procStart: processStart(child.pid) }; } } catch {}
    await Bun.sleep(10);
  }
  throw new Error("fixture never showed its argv");
}
const rowOf = (s, pid, procStart, sessionId) => ({ pid, sessionId, cwd: s.root, procStart, version: "2.1.311", peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"], messagingSocketPath: path.join(s.root, `${pid}.sock`), name: "fixture-session", status: "idle" });
async function writeRow(s, pid, text, mode = 0o644) { const f = path.join(s.sessionsDir, `${pid}.json`); await fsp.writeFile(f, text); await fsp.chmod(f, mode); return f; }
async function publish(s, { pid, procStart }, sessionId) {
  const row = rowOf(s, pid, procStart, sessionId);
  const server = net.createServer(() => {}); await new Promise((r, j) => { server.once("error", j); server.listen(row.messagingSocketPath, r); });
  closers.push(() => new Promise((r) => server.close(r))); await fsp.chmod(row.messagingSocketPath, 0o600);
  await writeRow(s, pid, JSON.stringify(row));
  const keyFile = path.join(s.sessionsDir, `${pid}.${crypto.createHash("sha256").update(path.resolve(row.messagingSocketPath)).digest("hex")}.key`);
  await fsp.writeFile(keyFile, JSON.stringify({ procStart, peerToken: "f".repeat(32) })); await fsp.chmod(keyFile, 0o600);
}
const expectedFor = (s, sessionId) => ({ sessionId, cwd: s.root, permissionMode: "bypass", expectedDisplayName: null });

test("a live session's row with trailing bytes: not running, and the refused row is named", async () => {
  const s = await bench(); const me = { pid: process.pid, procStart: processStart(process.pid) };
  await writeRow(s, me.pid, `${JSON.stringify(rowOf(s, me.pid, me.procStart, A))}ee"}`);
  expect(await sessionLiveness(A, { sessionsDir: s.sessionsDir })).toBe("not_running");
  expect(await sessionPresence(A, { sessionsDir: s.sessionsDir })).toEqual({ state: "not_running", rejectedRow: { pid: me.pid, problem: "row_unparsable", sessionId: A } });
  // another session's id is not this one's broken row
  expect((await sessionPresence(B, { sessionsDir: s.sessionsDir })).rejectedRow).toBeNull();
  // repaired, it is running again and nothing is reported
  await writeRow(s, me.pid, JSON.stringify(rowOf(s, me.pid, me.procStart, A)));
  expect(await sessionPresence(A, { sessionsDir: s.sessionsDir })).toEqual({ state: "running", rejectedRow: null });
});

test("a row others can write is still refused, and now says why", async () => {
  const s = await bench(); const me = { pid: process.pid, procStart: processStart(process.pid) };
  await writeRow(s, me.pid, JSON.stringify(rowOf(s, me.pid, me.procStart, A)), 0o666);
  expect(await sessionPresence(A, { sessionsDir: s.sessionsDir })).toEqual({ state: "not_running", rejectedRow: { pid: me.pid, problem: "row_writable_by_others", sessionId: A } });
});

test("a broken row whose process has ended is an ended session, not a refused row", async () => {
  const s = await bench();
  const gone = Bun.spawn({ cmd: [process.execPath, "-e", "0"], stdout: "ignore", stderr: "ignore" }); await gone.exited;
  await writeRow(s, gone.pid, `${JSON.stringify(rowOf(s, gone.pid, "Thu Jan  1 00:00:00 1970", A))}xx`);
  expect(await sessionPresence(A, { sessionsDir: s.sessionsDir })).toEqual({ state: "not_running", rejectedRow: null });
});

test("succession: the held id's own row refused -> session_row_rejected, with the pid and the problem", async () => {
  const s = await bench(); const p = await hold(["--resume", B, ...P]);
  await writeRow(s, p.pid, `${JSON.stringify(rowOf(s, p.pid, p.procStart, A))}\u0000`);
  let error = null; try { await resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir }); } catch (e) { error = e; }
  expect(error).toMatchObject({ diagnostic: "session_row_rejected", expectedSessionId: A, candidateCount: 0, rejectedRows: [{ pid: p.pid, problem: "row_unparsable" }] });
  expect(error.message).toContain("universal-peer-mcp open");
  expect(targetDiagnostic("session_row_rejected")).toBe("session_row_rejected");
});

test("succession: a proven successor still wins over somebody else's broken row", async () => {
  const s = await bench(); const succ = await hold(["--resume", A, ...P]); await publish(s, succ, B);
  const other = await hold(["--other"]);
  await writeRow(s, other.pid, "{not json");
  const found = await resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir });
  expect(found.target.sessionId).toBe(B);
});

test("succession with nothing broken is unchanged: rebind_no_proof", async () => {
  const s = await bench();
  await expect(resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir })).rejects.toMatchObject({ diagnostic: "rebind_no_proof", liveCandidates: [] });
});

// Sender side: the walk is exactly as before (a refused row is skipped), only the answer names it.
const STARTS = { 500: "Mon Sep 28 03:18:28 2026", 700: "Tue Sep 29 09:00:00 2026", 900: "Tue Sep 29 10:00:00 2026" };
const PARENT = { 900: 700, 700: 500, 500: 1 };
async function senderStand(files) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "upm-rowrej-s-"))); roots.push(root);
  const dir = path.join(root, "sessions"); await fsp.mkdir(dir, { mode: 0o700 });
  for (const [pid, text, mode] of files) { const f = path.join(dir, `${pid}.json`); await fsp.writeFile(f, text); await fsp.chmod(f, mode ?? 0o644); }
  return createSenderResolver({ sessionsDir: dir, allowlist: () => ({ "main-claude": { sessionId: A } }), startReader: (pid) => STARTS[pid], parentReader: (pid) => PARENT[pid] ?? 1, selfPid: 999 });
}

test("sender: the caller's session row is unparsable -> no_session_row with the refused row", async () => {
  const resolve = await senderStand([[700, `${JSON.stringify({ pid: 700, sessionId: A, procStart: STARTS[700] })}}`]]);
  expect(await resolve({ pid: 900, procStart: STARTS[900] }, { walk: true })).toEqual({ authenticated: false, reason: "no_session_row", refusedRow: { pid: 700, depth: 1, problem: "row_unparsable" } });
});

test("sender: a refused row is skipped, never trusted; the walk reaches the parent as before", async () => {
  const resolve = await senderStand([[700, JSON.stringify({ pid: 700, sessionId: B, procStart: STARTS[700] }), 0o666], [500, JSON.stringify({ pid: 500, sessionId: A, procStart: STARTS[500] })]]);
  expect(await resolve({ pid: 900, procStart: STARTS[900] }, { walk: true })).toMatchObject({ authenticated: true, alias: "main-claude", pid: 500, depth: 2 });
});

test("sender: no row anywhere is still plain no_session_row", async () => {
  const resolve = await senderStand([]);
  expect(await resolve({ pid: 900, procStart: STARTS[900] }, { walk: true })).toEqual({ authenticated: false, reason: "no_session_row" });
});

test("status: a refused row reads as misopened with the one line that fixes it", () => {
  const view = { daemon: null, unregistered: [], peers: [{ alias: "c-1", kind: "claude", present: "misopened", presentReason: "session_row_rejected:row_unparsable", lastSeenAt: new Date().toISOString(), unprocessed: 1, oldestUnprocessedAt: null, undelivered: 1, uncertain: 0, autoRetry: 1, held: 0, heldIds: [] }] };
  const text = renderOverview(view);
  expect(text).toContain("잘못 열림");
  expect(text).toContain("session_row_rejected:row_unparsable");
  expect(text).toContain("/exit 한 뒤 한 줄: universal-peer-mcp open c-1");
  expect(text).not.toContain("꺼져 있음");
  expect(renderRestore(view)).toContain("지금 열린 탭은 /exit 먼저");
});

test("review r1 P2: other broken rows do not use up the bound before the row asked about", async () => {
  const s = await bench(); const me = { pid: process.pid, procStart: processStart(process.pid) };
  for (let i = 0; i < 12; i += 1) await writeRow(s, 100 + i, `${JSON.stringify(rowOf(s, 100 + i, me.procStart, B))}!`, 0o666);
  await writeRow(s, me.pid, `${JSON.stringify(rowOf(s, me.pid, me.procStart, A))}!`);
  // every pid reads as this account's, so the other twelve would all have been collectable
  expect((await sessionPresence(A, { sessionsDir: s.sessionsDir, processUidReader: () => process.getuid() })).rejectedRow).toEqual({ pid: me.pid, problem: "row_unparsable", sessionId: A });
});

test("review r1 P1: a refused row over 64 KiB is not read for its claim", async () => {
  const s = await bench(); const me = { pid: process.pid, procStart: processStart(process.pid) };
  await writeRow(s, me.pid, `${" ".repeat(70000)}${JSON.stringify(rowOf(s, me.pid, me.procStart, A))}!`);
  expect(await sessionPresence(A, { sessionsDir: s.sessionsDir })).toEqual({ state: "not_running", rejectedRow: null });
});
