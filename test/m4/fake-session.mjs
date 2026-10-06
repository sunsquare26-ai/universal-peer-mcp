// A test double of one peer session. Never a real Claude or Codex session.
//
//   bun fake-session.mjs claude <sessionsDir> <sessionId> <cwd> [--permission-mode bypassPermissions] [--resume <id>]
//     writes a Claude Code-shaped registry row for its own pid (+ private socket and key, so the
//     succession proof can verify it), then runs commands.
//   <dir>/codex fake-session.mjs codex <threadId>
//     started through a link named `codex`; runs each command with CODEX_THREAD_ID=<threadId>, the
//     way a Codex host starts a thread's shell command.
//
// Commands arrive as JSON lines on stdin: {"id":n,"argv":[...]} → runs `bun src/cli.mjs ...argv`
// as a child and answers {"id":n,"code":c,"stdout":"...","stderr":"..."} on stdout. {"id":n,"exit":true} ends it.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { processStart } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const [kind, ...rest] = process.argv.slice(2);
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/cli.mjs");
const bun = process.env.UPM4_BUN || process.execPath;
let env = { ...process.env };
let server = null; let files = [];

const base = kind.replace(/-oneshot$/, "");
if (base === "claude") {
  const [sessionsDir, sessionId, cwd] = rest;
  // A real Claude started from a Codex shell inherits CODEX_THREAD_ID; the one-shot keeps it.
  if (kind === "claude") delete env.CODEX_THREAD_ID;
  const sockDir = fs.mkdtempSync("/private/tmp/upm4s-"); fs.chmodSync(sockDir, 0o700);
  const socketPath = path.join(sockDir, "s.sock");
  // M3: record what arrives on the session socket (the Claude doorbell is one fixed line).
  server = net.createServer((s) => { s.on("data", (d) => { try { fs.appendFileSync(path.join(sockDir, "frames"), d); } catch {} }); s.on("error", () => {}); s.setTimeout(1500, () => s.destroy()); }); await new Promise((r) => server.listen(socketPath, r)); fs.chmodSync(socketPath, 0o600);
  const procStart = processStart(process.pid);
  const row = { pid: process.pid, sessionId, cwd, startedAt: Date.now(), procStart, version: "test", peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"], kind: "interactive", entrypoint: "cli", messagingSocketPath: socketPath, name: `double-${sessionId.slice(0, 8)}`, status: "idle" };
  const rowFile = path.join(sessionsDir, `${process.pid}.json`);
  const keyFile = path.join(sessionsDir, `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  fs.writeFileSync(keyFile, JSON.stringify({ procStart, peerToken: crypto.randomBytes(16).toString("hex") }), { mode: 0o600 });
  fs.writeFileSync(rowFile, JSON.stringify(row), { mode: 0o600 });
  files = [rowFile, keyFile, sockDir];
  // A /clear inside this same process: new session id, same pid and start time.
  process.on("SIGUSR2", () => { try { const next = JSON.parse(fs.readFileSync(rowFile, "utf8")); next.sessionId = fs.readFileSync(`${rowFile}.next`, "utf8").trim(); fs.writeFileSync(rowFile, JSON.stringify(next), { mode: 0o600 }); process.stdout.write(`${JSON.stringify({ cleared: next.sessionId })}\n`); } catch {} });
} else if (base === "codex") {
  env.CODEX_THREAD_ID = rest[0];
} else { process.stderr.write("kind must be claude or codex\n"); process.exit(2); }

const running = new Set();
// One-shot mode for nesting: `<kind>-oneshot <args> -- <next command...>` sets up like <kind>, then
// runs the next command with this environment, relays its stdout and exits with its code.
const dash = process.argv.indexOf("--");
function cleanup() { for (const c of running) { try { c.kill("SIGKILL"); } catch {} } for (const f of files) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} } }
process.on("exit", cleanup);
if (kind.endsWith("-oneshot")) {
  const next = process.argv.slice(dash + 1);
  const child = spawn(next[0], next.slice(1), { env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("close", (code) => { server?.close(); cleanup(); process.exit(code ?? 1); });
} else {
  process.stdout.write(`${JSON.stringify({ ready: process.pid })}\n`);

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const cmd = JSON.parse(line);
  if (cmd.exit) { server?.close(); cleanup(); process.exit(0); }
  // A Codex host runs many threads in one process: a command may name its own thread.
  const child = spawn(bun, [cli, ...cmd.argv], { env: cmd.thread ? { ...env, CODEX_THREAD_ID: cmd.thread } : env, stdio: ["ignore", "pipe", "pipe"] });
  running.add(child); child.on("exit", () => running.delete(child));
  let out = ""; let err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => process.stdout.write(`${JSON.stringify({ id: cmd.id, code, stdout: out, stderr: err })}\n`));
}
  // stdin closed: the test process is gone; do not outlive it.
  server?.close(); cleanup(); process.exit(0);
}
