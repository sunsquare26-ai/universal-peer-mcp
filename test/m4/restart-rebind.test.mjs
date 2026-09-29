// M4 restart and rebind per session, on a real daemon with session doubles.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { lane, stopDaemon, writeBody } from "./harness.mjs";

const lanes = [];
afterEach(async () => { for (const L of lanes.splice(0)) await L.stop(); });
async function setup() {
  const L = await lane(); lanes.push(L); await L.owner(["peers"]);
  const c1 = await L.claude(); const c2 = await L.claude(); const x1 = await L.codex();
  for (const [s, a] of [[c1, "test-claude-1"], [c2, "test-claude-2"], [x1, "test-codex-1"]]) expect((await s.run(["register", "--alias", a])).json.state).toBe("registered");
  return { L, c1, c2, x1 };
}
const table = async (L) => JSON.parse(await fsp.readFile(L.paths.targets, "utf8"));

test("a Claude session restarted with --resume <its id> is rebound on its own first call; mail waiting for it is delivered; the other session is untouched", async () => {
  const { L, c1, c2, x1 } = await setup();
  const waiting = await x1.run(["post", "--to", "test-claude-1", "--body-file", await writeBody(L, "while you were away")]);
  const before = await table(L);
  await c1.close();                                            // session ends
  const c1b = await L.claude({ resume: c1.sessionId });        // `claude --resume <id>` → new session id
  expect((await c1b.run(["whoami"])).json).toEqual({ authenticated: true, alias: "test-claude-1", kind: "claude" });
  const after = await table(L);
  expect(after["test-claude-1"].sessionId).toBe(c1b.sessionId);
  expect(after["test-claude-2"]).toEqual(before["test-claude-2"]);
  const box = (await c1b.run(["inbox"])).json.events;
  expect(box.map((e) => e.messageId)).toEqual([waiting.json.results[0].messageId]);
  expect((await c2.run(["whoami"])).json.alias).toBe("test-claude-2");
  const types = (await L.events()).map((e) => e.type);
  expect(types).toContain("target_rebound"); expect(types).toContain("peer_session_rebound");
});

test("unclear inheritance is refused by name: /clear in the same process, --fork-session, chained resume, a new Codex thread", async () => {
  const { L, c1, c2, x1 } = await setup();
  const original = (await table(L))["test-claude-1"].sessionId;
  // /clear (or the picker): same pid and start time, new id. Its argv even carries a resume of the
  // alias's id — the ledger's record of which process holds that id still refuses it.
  const S = crypto.randomUUID();
  const clr = await L.claude({ sessionId: S, resume: S });     // started as `claude --resume S`, keeps S
  await clr.run(["register", "--alias", "test-clear"]);
  await fsp.writeFile(path.join(L.sessions, `${clr.pid}.json.next`), crypto.randomUUID());
  process.kill(clr.pid, "SIGUSR2"); await Bun.sleep(200);
  expect((await clr.run(["whoami"])).json).toMatchObject({ authenticated: false, kind: "claude", reason: "session_not_allowlisted", rebind: "rebind_same_process" });
  // --fork-session is not a succession.
  await c1.close();
  const fork = await L.claude({ resume: original, extra: ["--fork-session"] });
  expect((await fork.run(["whoami"])).json).toMatchObject({ authenticated: false, reason: "session_not_allowlisted", rebind: "rebind_fork_refused" });
  expect((await table(L))["test-claude-1"].sessionId).toBe(original);
  await fork.close();
  // A proper resume rebinds; a later session resuming the *older* id is chained inheritance: refused.
  const next = await L.claude({ resume: original });
  expect((await next.run(["whoami"])).json.alias).toBe("test-claude-1");
  await next.close();
  const chained = await L.claude({ resume: original });
  expect((await chained.run(["whoami"])).json).toMatchObject({ authenticated: false, reason: "session_not_allowlisted", rebind: "rebind_chain_unsupported" });
  expect((await table(L))["test-claude-1"].sessionId).toBe(next.sessionId);
  // A new Codex thread (new chat, fork) is a new thread id: never inherited; the Owner re-registers.
  const x2 = await L.codex();
  expect((await x2.run(["whoami"])).json).toMatchObject({ authenticated: false, kind: "codex", reason: "session_not_allowlisted" });
  const reasons = (await L.events()).filter((e) => e.type === "target_rebind_failed").map((e) => e.reason);
  expect(reasons).toContain("rebind_chain_unsupported");
  expect(reasons).toContain("rebind_same_process");
  expect(reasons).toContain("rebind_fork_refused");
  expect((await c2.run(["whoami"])).json.alias).toBe("test-claude-2");
});

test("Codex: moving an alias to a new thread by hand hands over the undelivered mail; a daemon restart keeps every session's state", async () => {
  const { L, c1, x1 } = await setup();
  const m1 = await c1.run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "one")]);
  const m2 = await c1.run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "two")]);
  await x1.run(["inbox-ack", "--message-id", m1.json.results[0].messageId]);
  const x2 = await L.codex();
  expect((await x2.run(["register", "--alias", "test-codex-1", "--replace"])).json.replaced).toEqual([{ alias: "test-codex-1", kind: "codex" }]);
  expect((await x1.run(["inbox"])).error).toMatchObject({ code: "SENDER_UNAUTHENTICATED" });
  await stopDaemon(L.root);                                        // daemon restart
  const box = (await x2.run(["inbox"])).json.events;              // starts a new daemon on the same state
  expect(box.map((e) => e.messageId)).toEqual([m2.json.results[0].messageId]);
  expect((await x2.run(["inbox-ack", "--message-id", m1.json.results[0].messageId])).json.already).toBe(true);
  expect((await c1.run(["whoami"])).json.alias).toBe("test-claude-1");
});
