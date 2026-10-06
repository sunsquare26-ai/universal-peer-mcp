// M4 onboarding end to end: session doubles register themselves through the CLI, a real daemon from
// this tree proves them (kernel pid + registry row / kernel exec environment + rollout file).
import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import { lane } from "./harness.mjs";

const lanes = [];
afterEach(async () => { for (const L of lanes.splice(0)) await L.stop(); });
async function open() { const L = await lane(); lanes.push(L); await L.owner(["peers"]); return L; }

test("a Claude double and a Codex double register themselves; peers lists them; tables hold only known fields", async () => {
  const L = await open();
  const a = await L.claude(); const x = await L.codex();
  const ra = await a.run(["register", "--alias", "test-claude-1"]);
  expect(ra.code).toBe(0);
  expect(ra.json).toMatchObject({ state: "registered", alias: "test-claude-1", kind: "claude", sessionId: a.sessionId, permissionMode: "bypass" });
  const rx = await x.run(["register", "--alias", "test-codex-1"]);
  expect(rx.json).toMatchObject({ state: "registered", alias: "test-codex-1", kind: "codex", threadId: x.threadId });
  expect((await a.run(["whoami"])).json).toEqual({ authenticated: true, alias: "test-claude-1", kind: "claude" });
  expect((await x.run(["whoami"])).json).toEqual({ authenticated: true, alias: "test-codex-1", kind: "codex" });
  const listed = (await L.owner(["peers"])).json.peers;
  expect(listed.map((p) => [p.alias, p.kind])).toEqual([["test-claude-1", "claude"], ["test-codex-1", "codex"]]);
  const targets = JSON.parse(await fsp.readFile(L.paths.targets, "utf8"));
  expect(Object.keys(targets["test-claude-1"]).sort()).toEqual(["cwd", "permissionMode", "sessionId"]);
  expect((await fsp.stat(L.paths.targets)).mode & 0o777).toBe(0o600);
  // Registering again is a no-op; the Owner's terminal is not a session and cannot register.
  expect((await a.run(["register", "--alias", "test-claude-1"])).json.state).toBe("unchanged");
  const owner = await L.owner(["register", "--alias", "owner-term"]);
  expect(owner.code).toBe(1); expect(owner.error).toMatchObject({ code: "SESSION_UNPROVEN" });
  // Remove: another alias only through the operator path; a session may remove its own alias.
  expect((await L.detached(["unregister", "--alias", "test-codex-1"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "no_tty" });
  expect((await a.run(["unregister", "--alias", "test-codex-1"])).error).toMatchObject({ code: "OPERATOR_REQUIRED", reason: "inside_session" });
  expect((await x.run(["unregister", "--alias", "test-codex-1"])).json).toEqual({ removed: true, alias: "test-codex-1", kind: "codex" });
  expect((await x.run(["whoami"])).json).toMatchObject({ authenticated: false, kind: "codex", reason: "session_not_allowlisted" });
  // M5: an alias that is gone is said at once.
  expect((await x.run(["unregister", "--alias", "test-codex-1"])).error).toMatchObject({ code: "UNKNOWN_ALIAS" });
  const types = (await L.events()).map((e) => e.type);
  expect(types.filter((t) => t === "peer_registered")).toHaveLength(2);
  expect(types).toContain("peer_unregistered"); expect(types).toContain("peer_register_refused");
}, 60_000);

test("one alias names one session and one session holds one alias; --replace moves either on purpose", async () => {
  const L = await open();
  const a = await L.claude(); const b = await L.claude(); const x = await L.codex();
  await a.run(["register", "--alias", "test-a"]);
  expect((await b.run(["register", "--alias", "test-a"])).error).toMatchObject({ code: "ALIAS_TAKEN" });
  expect((await x.run(["register", "--alias", "test-a"])).error).toMatchObject({ code: "ALIAS_TAKEN" });
  expect((await a.run(["register", "--alias", "test-a2"])).error).toMatchObject({ code: "SESSION_ALREADY_REGISTERED" });
  // Replace across kinds: the alias now names the Codex thread, and is in exactly one table.
  expect((await x.run(["register", "--alias", "test-a", "--replace"])).json).toMatchObject({ state: "registered", kind: "codex", replaced: [{ alias: "test-a", kind: "claude" }] });
  const targets = JSON.parse(await fsp.readFile(L.paths.targets, "utf8"));
  expect(targets["test-a"]).toBeUndefined();
  expect((await a.run(["whoami"])).json.authenticated).toBe(false);
  // Move a session to a new alias: the old alias goes away.
  expect((await x.run(["register", "--alias", "test-x", "--replace"])).json.replaced).toEqual([{ alias: "test-a", kind: "codex" }]);
  expect((await L.owner(["peers"])).json.peers.map((p) => p.alias)).toEqual(["test-x"]);
  expect((await b.run(["register", "--alias", "Bad_Name"])).error).toMatchObject({ code: "INVALID_ALIAS" });
});

test("named refusals: Codex thread without a rollout file, Claude session without a provable permission mode", async () => {
  const L = await open();
  const ghost = await L.codex({ rollout: false });
  expect((await ghost.run(["register", "--alias", "test-ghost"])).error).toMatchObject({ code: "SESSION_UNPROVEN" });
  const plain = await L.claude({ mode: null });
  const r = await plain.run(["register", "--alias", "test-plain"]);
  expect(r.error).toMatchObject({ code: "SESSION_UNPROVEN" }); expect(r.error.message).toContain("--permission-mode");
  const reasons = (await L.events()).filter((e) => e.type === "peer_register_refused").map((e) => e.reason);
  expect(reasons).toEqual(["codex_thread_unregistered", "permission_mode_unproven"]);
});

// Nested sessions: the nearer host is the caller. Codex started inside a Claude session's tree is the
// Codex thread; Claude started from a Codex shell (inheriting CODEX_THREAD_ID) is the Claude session.
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { uuidv7 } from "./harness.mjs";

async function chain(L, argv) {
  const child = spawn(argv[0], argv.slice(1), { env: L.env, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); await new Promise((r) => child.on("close", r));
  return JSON.parse(out);
}
test("nested sessions: the nearer host names the caller, in both nestings", async () => {
  const L = await open();
  const fake = path.join(import.meta.dir, "fake-session.mjs"); const cli = path.resolve(import.meta.dir, "../../src/cli.mjs");
  const codexBin = path.join(L.base, "bin", "codex");
  const T1 = uuidv7(); const T2 = uuidv7();
  await L.codex({ threadId: T1 }); await L.codex({ threadId: T2 });   // rollout files for both threads
  const claudeArgs = (id) => [process.execPath, fake, "claude-oneshot", L.sessions, id, L.work, "--permission-mode", "bypassPermissions", "--"];
  // Codex inside Claude: claude → codex host → command
  const inner = await chain(L, [...claudeArgs(crypto.randomUUID()), codexBin, fake, "codex-oneshot", T1, "--", process.execPath, cli, "whoami"]);
  expect(inner).toMatchObject({ authenticated: false, kind: "codex", reason: "session_not_allowlisted" });
  // Claude inside Codex: codex host → claude (inherits CODEX_THREAD_ID) → command
  const outer = await chain(L, [codexBin, fake, "codex-oneshot", T2, "--", ...claudeArgs(crypto.randomUUID()), process.execPath, cli, "whoami"]);
  expect(outer).toMatchObject({ authenticated: false, kind: "claude", reason: "session_not_allowlisted" });
});
