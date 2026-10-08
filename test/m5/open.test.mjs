import { describe, expect, test } from "bun:test";
import { buildOpenCommand } from "../../src/core/open.mjs";

const base = { root: "/state", binDir: "/opt/upm/bin", claudeBin: "/abs/claude", codexBin: "/abs/codex", environment: { PATH: "/usr/bin" } };
const claude = (permissionMode) => ({ kind: "claude", sessionId: "10000000-0000-4000-8000-0000000000aa", cwd: "/work", permissionMode });

describe("open builds the one command that keeps a session a peer", () => {
  test("claude: absolute argv[0], explicit resume id and the recorded mode", () => {
    const plan = buildOpenCommand({ ...base, alias: "a-claude", peer: claude("bypass") });
    expect(plan.argv).toEqual(["/abs/claude", "--resume", "10000000-0000-4000-8000-0000000000aa", "--permission-mode", "bypassPermissions"]);
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
