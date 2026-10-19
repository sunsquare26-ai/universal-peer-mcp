import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildOpenCommand, ensureCodexAppServer, runOpen, socketAnswers } from "../../src/core/open.mjs";

const base = { root: "/state", binDir: "/opt/upm/bin", claudeBin: "/abs/claude", codexBin: "/abs/codex", environment: { PATH: "/usr/bin" } };
const claude = (permissionMode) => ({ kind: "claude", sessionId: "10000000-3312-4e8d-8e25-18f525d75bb2", cwd: "/work", permissionMode });

describe("open builds the one command that keeps a session a peer", () => {
  test("claude: absolute argv[0], explicit resume id and the recorded mode", () => {
    const plan = buildOpenCommand({ ...base, alias: "a-claude", peer: claude("bypass") });
    expect(plan.argv).toEqual(["/abs/claude", "--resume", "10000000-3312-4e8d-8e25-18f525d75bb2", "--permission-mode", "bypassPermissions"]);
    expect(plan.cwd).toBe("/work");
    expect(plan.env).toEqual({ UNIVERSAL_PEER_MCP_STATE_DIR: "/state", PATH: "/opt/upm/bin:/usr/bin" });
  });
  test("a prompting alias reopens prompting, and may pick another prompting flag", () => {
    expect(buildOpenCommand({ ...base, alias: "p", peer: claude("prompting") }).argv.at(-1)).toBe("default");
    expect(buildOpenCommand({ ...base, alias: "p", peer: claude("prompting"), permissionFlag: "auto" }).argv.at(-1)).toBe("auto");
  });
  test("open never crosses between prompting and bypass", () => {
    expect(() => buildOpenCommand({ ...base, alias: "p", peer: claude("prompting"), permissionFlag: "bypassPermissions" })).toThrow(expect.objectContaining({ code: "OPEN_PERMISSION_CHANGE" }));
    expect(() => buildOpenCommand({ ...base, alias: "b", peer: claude("bypass"), permissionFlag: "auto" })).toThrow(expect.objectContaining({ code: "OPEN_PERMISSION_CHANGE" }));
  });
  test("codex: shared app-server so the doorbell can ring it, explicit thread", () => {
    const plan = buildOpenCommand({ ...base, alias: "c", peer: { kind: "codex", threadId: "01a10000-8d9b-7ba0-8228-4bef09bbe67e" }, cwd: "/work" });
    expect(plan.argv).toEqual(["/abs/codex", "--remote", "unix://", "--no-alt-screen", "-C", "/work", "resume", "01a10000-8d9b-7ba0-8228-4bef09bbe67e"]);
  });
  test("missing pieces are named, never guessed", () => {
    expect(() => buildOpenCommand({ ...base, claudeBin: null, alias: "a", peer: claude("bypass") })).toThrow(expect.objectContaining({ code: "OPEN_CLAUDE_NOT_FOUND" }));
    expect(() => buildOpenCommand({ ...base, alias: "c", peer: { kind: "codex", threadId: "01a10000-8d9b-7ba0-8228-4bef09bbe67e" }, cwd: null })).toThrow(expect.objectContaining({ code: "OPEN_CWD_UNKNOWN" }));
  });
  test("no bin dir, PATH untouched", () => {
    expect(buildOpenCommand({ ...base, binDir: null, alias: "a", peer: claude("bypass") }).env.PATH).toBe("/usr/bin");
  });
});

// 2026-10-18: after a reboot `open codex-dev` died on "failed to connect to remote app server …
// app-server-control.sock: No such file", and the owner had to ask for the command again.
describe("open starts the Codex app server it resumes on, when nothing answers there", () => {
  const codexPeer = { kind: "codex", threadId: "01a10000-8d9b-7ba0-8228-4bef09bbe67e" };
  const plan = () => buildOpenCommand({ ...base, alias: "c", peer: codexPeer, cwd: "/work", codexHome: "/home/.codex" });
  const quiet = { log: () => {}, stepMs: 1 };
  test("the codex plan names the socket and codex's own local start", () => {
    expect(plan().appServer).toEqual({ socket: "/home/.codex/app-server-control/app-server-control.sock", start: ["/abs/codex", "app-server", "daemon", "start"] });
    expect(buildOpenCommand({ ...base, alias: "a", peer: claude("bypass") }).appServer).toBeUndefined();
  });
  test("an app server that answers is left alone", async () => {
    const spawned = [];
    expect(await ensureCodexAppServer(plan().appServer, { ...quiet, answers: async () => true, spawn: (argv) => { spawned.push(argv); return { exited: Promise.resolve(0) }; } })).toBeNull();
    expect(spawned).toEqual([]);
  });
  test("one that does not is started once, then waited for", async () => {
    const spawned = []; let up = false;
    const result = await ensureCodexAppServer(plan().appServer, { ...quiet, answers: async () => up, spawn: (argv) => { spawned.push(argv); up = true; return { exited: Promise.resolve(0) }; } });
    expect(result).toBeNull();
    expect(spawned).toEqual([["/abs/codex", "app-server", "daemon", "start"]]);
  });
  test("one that never comes up is reported and codex is not launched", async () => {
    const launched = [];
    const spawn = (argv) => { launched.push(argv); return { exited: Promise.resolve(argv[1] === "app-server" ? 1 : 0) }; };
    const code = await runOpen(plan(), { spawn, ensureAppServer: (appServer, options) => ensureCodexAppServer(appServer, { ...options, ...quiet, waitMs: 5, answers: async () => false }) });
    expect(code).toBe(1);
    expect(launched).toEqual([["/abs/codex", "app-server", "daemon", "start"]]);
  });
  test("a start that never exits is bounded by the same deadline, and an answer before it exits is enough", async () => {
    const never = () => ({ exited: new Promise(() => {}) });
    const began = Date.now();
    const result = await ensureCodexAppServer(plan().appServer, { ...quiet, waitMs: 50, answers: async () => false, spawn: never });
    expect(result).toContain("still running"); expect(Date.now() - began).toBeLessThan(2000);
    let calls = 0;
    expect(await ensureCodexAppServer(plan().appServer, { ...quiet, answers: async () => (calls += 1) > 2, spawn: never })).toBeNull();
  });
  test("a real start that outlives the deadline does not keep the process alive", async () => {
    const script = `const { ensureCodexAppServer } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/core/open.mjs"))});
      const r = await ensureCodexAppServer({ socket: "/nonexistent/upm.sock", start: ["/bin/sleep", "5"] }, { waitMs: 30, stepMs: 5, log: () => {} }); console.log(r);`;
    const began = Date.now();
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
    await child.exited;
    expect(await new Response(child.stdout).text()).toContain("still running");
    expect(Date.now() - began).toBeLessThan(4000);
  });
  test("socketAnswers: a dangling link is not an app server, a listening socket is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upm-open-"));
    try {
      const link = path.join(dir, "gone.sock"); fs.symlinkSync(path.join(dir, "missing"), link);
      expect(await socketAnswers(link)).toBe(false);
      const live = path.join(dir, "live.sock"); const server = net.createServer((s) => s.end());
      await new Promise((resolve) => server.listen(live, resolve));
      try { expect(await socketAnswers(live)).toBe(true); } finally { server.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
