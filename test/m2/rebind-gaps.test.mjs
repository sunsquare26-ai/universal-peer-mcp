// M2 rebind gaps. Real processes hold the argv (the resolver reads it from the kernel); the session
// registry is a private temp directory.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveSuccessor } from "../../src/adapters/claude-native-v1/registry.mjs";
import { processStart, readProcessArgv } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const roots = []; const spawned = []; const closers = [];
afterEach(async () => {
  for (const c of spawned.splice(0)) c.kill();
  for (const close of closers.splice(0)) await close();
  for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true });
});
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", C = "cccccccc-0000-4000-8000-000000000003";

async function hold(args) {
  const child = Bun.spawn({ cmd: [process.execPath, "-e", "setTimeout(() => {}, 600000)", ...args], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  spawned.push(child);
  for (let i = 0; i < 400; i += 1) {
    try { const argv = readProcessArgv(child.pid); if (args.every((v, k) => argv[argv.length - args.length + k] === v)) { await Bun.sleep(30); return { pid: child.pid, procStart: processStart(child.pid) }; } } catch {}
    await Bun.sleep(10);
  }
  throw new Error("fixture never showed its argv");
}
async function bench() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "peer-m2-rebind-"))); roots.push(root); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.chmod(sessionsDir, 0o700);
  return { root, sessionsDir };
}
async function publish({ root, sessionsDir }, { pid, procStart }, sessionId, name = "fixture-session") {
  const socketPath = path.join(root, `${pid}.sock`);
  const server = net.createServer(() => {}); await new Promise((r, j) => { server.once("error", j); server.listen(socketPath, r); });
  closers.push(() => new Promise((r) => server.close(r))); await fsp.chmod(socketPath, 0o600);
  const row = { pid, sessionId, cwd: root, procStart, version: "2.1.260", peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"], messagingSocketPath: socketPath, name, status: "idle" };
  const rowFile = path.join(sessionsDir, `${pid}.json`); await fsp.writeFile(rowFile, JSON.stringify(row)); await fsp.chmod(rowFile, 0o644);
  const keyFile = path.join(sessionsDir, `${pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await fsp.writeFile(keyFile, JSON.stringify({ procStart, peerToken: "f".repeat(32) })); await fsp.chmod(keyFile, 0o600);
}
const expectedFor = (stand, sessionId) => ({ sessionId, cwd: stand.root, permissionMode: "bypass", expectedDisplayName: null });
const P = ["--permission-mode", "bypassPermissions"];

test("control: a new process started with --resume <held id> is the successor", async () => {
  const s = await bench(); const p = await hold(["--resume", A, ...P]); await publish(s, p, B);
  const found = await resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir });
  expect(found.target.sessionId).toBe(B);
});

test("the daemon's own registry row is never a candidate", async () => {
  const s = await bench(); const p = await hold(["--resume", A, ...P]); await publish(s, p, B, "universal-peer-mcp");
  await expect(resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir })).rejects.toMatchObject({ diagnostic: "rebind_no_proof", liveCandidates: [] });
});

test("a fork of the held id is not its successor", async () => {
  const s = await bench(); const p = await hold(["--resume", A, "--fork-session", ...P]); await publish(s, p, B);
  await expect(resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir })).rejects.toMatchObject({ diagnostic: "rebind_no_proof" });
});

test("--continue is not a receipt", async () => {
  const s = await bench(); const p = await hold(["--continue", ...P]); await publish(s, p, B);
  await expect(resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir })).rejects.toMatchObject({ diagnostic: "rebind_no_proof" });
});

test("the same process under a new id (/clear) is refused by name", async () => {
  const s = await bench(); const p = await hold(["--resume", A, ...P]); await publish(s, p, C);
  await expect(resolveSuccessor(expectedFor(s, A), { sessionsDir: s.sessionsDir, previousGeneration: { pid: p.pid, procStart: p.procStart } })).rejects.toMatchObject({ diagnostic: "rebind_same_process" });
});

test("a chain (table holds B, live session resumes A) is refused as unsupported", async () => {
  const s = await bench(); const p = await hold(["--resume", A, ...P]); await publish(s, p, C);
  await expect(resolveSuccessor(expectedFor(s, B), { sessionsDir: s.sessionsDir, previousSessionIds: [A] })).rejects.toMatchObject({ diagnostic: "rebind_chain_unsupported" });
  await expect(resolveSuccessor(expectedFor(s, B), { sessionsDir: s.sessionsDir })).rejects.toMatchObject({ diagnostic: "rebind_no_proof" });
});
