// M4 test lane: a daemon from this tree on a private state dir, a private Claude sessions dir and a
// private CODEX_HOME, and session doubles (fake-session.mjs). Never the live daemon or live sessions.
// The operator prompt ends with the phrase on its own line and this marker (src/core/operator.mjs).
const OPERATOR_PROMPT = "\n> ";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statePaths } from "../../src/core/state-paths.mjs";
import { normalizeProcStart, processStart } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fake-session.mjs");

export async function lane() {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join("/private/tmp", "upm4-")));
  await fsp.chmod(base, 0o700);
  const root = path.join(base, "state"); const sessions = path.join(base, "sessions"); const codexHome = path.join(base, "codex"); const bin = path.join(base, "bin"); const work = path.join(base, "work");
  for (const d of [root, sessions, codexHome, bin, work]) await fsp.mkdir(d, { mode: 0o700 });
  await fsp.symlink(process.execPath, path.join(bin, "codex"));
  const env = { ...process.env, UNIVERSAL_PEER_MCP_STATE_DIR: root, UNIVERSAL_PEER_CLAUDE_SESSIONS_DIR: sessions, CODEX_HOME: codexHome, UNIVERSAL_PEER_MAINTENANCE_DELAY_MS: "3600000", UPM4_BUN: process.execPath };
  delete env.CLAUDE_PEER_MCP_STATE_DIR;
  const sessionsList = [];
  const L = {
    base, root, sessions, codexHome, work, env, paths: statePaths(root),
    async claude({ sessionId = crypto.randomUUID(), resume = null, mode = "bypassPermissions", cwd = work, extra = [] } = {}) {
      const argv = [fake, "claude", sessions, sessionId, cwd, ...(mode ? ["--permission-mode", mode] : []), ...(resume ? ["--resume", resume] : []), ...extra];
      const s = await start(process.execPath, argv, env); s.sessionId = sessionId; s.kind = "claude"; sessionsList.push(s); return s;
    },
    async rollout(threadId) { const day = path.join(codexHome, "sessions", "2026", "09", "29"); await fsp.mkdir(day, { recursive: true, mode: 0o700 }); await fsp.writeFile(path.join(day, `rollout-2026-09-29T00-00-00-${threadId}.jsonl`), "", { mode: 0o600 }); },
    async codex({ threadId = uuidv7(), rollout = true } = {}) {
      if (rollout) { const day = path.join(codexHome, "sessions", "2026", "09", "29"); await fsp.mkdir(day, { recursive: true, mode: 0o700 }); await fsp.writeFile(path.join(day, `rollout-2026-09-29T00-00-00-${threadId}.jsonl`), "", { mode: 0o600 }); }
      const s = await start(path.join(bin, "codex"), [fake, "codex", threadId], env); s.threadId = threadId; s.kind = "codex"; sessionsList.push(s); return s;
    },
    // A command run by the test process itself: not inside any session, no terminal.
    async owner(argv) { return runDirect(argv, env); },
    // The operator path: the same command under a pseudo-terminal (script(1)) with a phrase typed at it.
    async operator(argv, phrase) { return runOperator(argv, env, phrase); },
    // A process with no session ancestor: started from a shell that exits at once, so it is reparented
    // to launchd (pid 1) and the chain up to whatever runs the tests (a Claude or Codex session) is cut;
    // CODEX_THREAD_ID is removed from its environment. With a phrase it runs under script(1) (a pty and
    // a controlling terminal) and the phrase is typed; without one it has no terminal at all.
    async detached(argv, phrase = null) { return runDetached(argv, env, phrase); },
    async stop() {
      for (const s of sessionsList.splice(0)) await s.close();
      await stopDaemon(root);
      // A command still in flight when a test failed could have started one more daemon.
      await Bun.sleep(100); await stopDaemon(root);
      await fsp.rm(base, { recursive: true, force: true });
    },
    async events() { try { return (await fsp.readFile(statePaths(root).events, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
  };
  return L;
}

export function uuidv7() {
  const b = crypto.randomBytes(16); const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function start(command, argv, env) {
  const child = spawn(command, argv, { env, stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: child.stdout });
  const waiters = new Map(); let ready; const readyP = new Promise((r) => { ready = r; }); let counter = 0;
  const notes = [];
  rl.on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.ready) return ready(m.ready); if (m.cleared) return notes.push(m); const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } });
  const pid = await Promise.race([readyP, new Promise((_, rej) => setTimeout(() => rej(new Error("session double did not start")), 10_000))]);
  return {
    pid, child, notes,
    run(args, { thread = null } = {}) { const id = ++counter; return new Promise((resolve) => { waiters.set(id, (m) => resolve(parse(m))); child.stdin.write(`${JSON.stringify({ id, argv: args, ...(thread ? { thread } : {}) })}\n`); }); },
    async close() { if (child.exitCode !== null) return; child.stdin.write(`${JSON.stringify({ id: 0, exit: true })}\n`); await Promise.race([new Promise((r) => child.once("exit", r)), Bun.sleep(3000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
  };
}

function parse(m) {
  let json = null; try { json = JSON.parse(m.stdout); } catch {}
  let error = null; try { error = m.stderr ? JSON.parse(m.stderr.trim().split("\n").at(-1)) : null; } catch { error = { raw: m.stderr }; }
  return { code: m.code, json, error };
}

async function runDirect(argv, env) {
  const cli = path.resolve(here, "../../src/cli.mjs");
  const clean = { ...env }; delete clean.CODEX_THREAD_ID;
  const child = spawn(process.execPath, [cli, ...argv], { env: clean, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => child.on("close", r));
  return parse({ code, stdout: out, stderr: err });
}

export async function stopDaemon(root) {
  // daemon.json appears only once the daemon is ready; daemon.lock is its first write. Either names it.
  let row = null;
  for (const file of [statePaths(root).daemon, statePaths(root).daemonLock]) { try { row = JSON.parse(await fsp.readFile(file, "utf8")); break; } catch {} }
  if (!row) return;
  for (let i = 0; i < 200; i += 1) {
    try { process.kill(row.pid, 0); } catch { return; }
    let live = false; try { live = normalizeProcStart(processStart(row.pid)) === normalizeProcStart(row.procStart); } catch { return; }
    if (!live) return; if (i === 0) process.kill(row.pid, "SIGTERM"); await Bun.sleep(25);
  }
}

export async function writeBody(L, text) {
  const file = path.join(L.work, `body-${crypto.randomUUID()}.txt`); await fsp.writeFile(file, text, { mode: 0o600 }); return file;
}

async function runOperator(argv, env, phrase) {
  const cli = path.resolve(here, "../../src/cli.mjs");
  const clean = { ...env }; delete clean.CODEX_THREAD_ID;
  // script(1) refuses a socket (what spawn's "pipe" is, and what a macOS FIFO is) as its stdin, so a
  // real pipe is put in front of it with cat.
  const quoted = [process.execPath, cli, ...argv].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
  const child = spawn("/bin/sh", ["-c", `/bin/cat | /usr/bin/script -q /dev/null ${quoted} | /bin/cat`], { env: clean, stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let typed = false;
  child.stdout.on("data", (d) => { out += d; if (!typed && out.includes(OPERATOR_PROMPT)) { typed = true; setTimeout(() => child.stdin.write(`${phrase}\n`), 50); } });
  const exited = new Promise((r) => child.on("close", r));
  // script ends when the command does; cat in front ends when its input closes.
  const watcher = setInterval(() => { if (/\}\s*$/.test(out.replace(/\r/g, ""))) child.stdin.end(); }, 50);
  const code = await exited; clearInterval(watcher);
  const text = out.replace(/\r/g, "");
  const after = typed ? text.slice(text.indexOf(OPERATOR_PROMPT) + OPERATOR_PROMPT.length) : text;
  const start = after.indexOf("{");
  let json = null; let error = null;
  try { const parsed = JSON.parse(after.slice(start)); if (parsed && parsed.ok === false) error = parsed; else json = parsed; } catch { error = { raw: text.slice(-400) }; }
  return { code, json, error, prompted: typed };
}

async function runDetached(argv, env, phrase) {
  const cli = path.resolve(here, "../../src/cli.mjs");
  const clean = { ...env }; delete clean.CODEX_THREAD_ID;
  const dir = await fsp.realpath(await fsp.mkdtemp("/private/tmp/upm4d-"));
  const fifo = path.join(dir, "in"); const out = path.join(dir, "out"); const rc = path.join(dir, "rc");
  const q = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
  const command = [process.execPath, cli, ...argv].map(q).join(" ");
  let body;
  if (phrase === null) body = `${command} < /dev/null > ${q(out)} 2>&1`;
  else { execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]); body = `/bin/cat ${q(fifo)} | /usr/bin/script -q /dev/null ${command} > ${q(out)} 2>&1`; }
  const launcher = spawn("/bin/sh", ["-c", `( ${body}; echo $? > ${q(rc)} ) < /dev/null > /dev/null 2>&1 & exit 0`], { env: clean, stdio: "ignore" });
  await new Promise((r) => launcher.on("close", r));
  const read = async (f) => { try { return await fsp.readFile(f, "utf8"); } catch { return null; } };
  let writer = null; let typed = false;
  if (phrase !== null) writer = await fsp.open(fifo, "w");
  for (let i = 0; i < 600; i += 1) {
    if (writer && !typed && ((await read(out)) ?? "").includes(OPERATOR_PROMPT)) { typed = true; await writer.write(`${phrase}\n`); await writer.close().catch(() => {}); writer = null; }
    if ((await read(rc)) !== null) break;
    await Bun.sleep(25);
  }
  if (writer) await writer.close().catch(() => {});
  const text = ((await read(out)) ?? "").replace(/\r/g, "");
  const code = Number(((await read(rc)) ?? "").trim());
  await fsp.rm(dir, { recursive: true, force: true });
  const after = typed ? text.slice(text.indexOf(OPERATOR_PROMPT) + OPERATOR_PROMPT.length) : text;
  let json = null; let error = null;
  try { const parsed = JSON.parse(after.slice(after.indexOf("{"))); if (parsed && parsed.ok === false) error = parsed; else json = parsed; } catch { error = { raw: text.slice(-400) }; }
  return { code, json, error, prompted: typed };
}
