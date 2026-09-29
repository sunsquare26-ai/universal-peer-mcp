// M3 end to end through the product entry point: a registered Claude double runs `post`, the daemon
// from this tree accepts it for a registered Codex double, writes the intent, rings a stub
// app-server (ws on a unix socket, the real transport), and the Codex double reads with `inbox` and
// acknowledges with `inbox-ack`. Then: restart with an open intent, and --replace. Private state,
// private sessions dir and CODEX_HOME (M4 harness); never the live daemon or live sessions.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { lane, stopDaemon, writeBody } from "../m4/harness.mjs";
import { writeCli } from "../m0/codex-fixture.mjs";

const lanes = []; const stubs = [];
afterEach(async () => { for (const s of stubs.splice(0)) s.kill("SIGTERM"); for (const L of lanes.splice(0)) await L.stop(); });

async function stub(L, threadId, state = "idle") {
  const sock = path.join(L.base, "as.sock"); const log = path.join(L.base, "turns.jsonl");
  const child = spawn("node", [path.join(import.meta.dir, "stub-app-server.cjs"), sock, threadId, state, log], { cwd: path.resolve(import.meta.dir, "../.."), stdio: ["ignore", "pipe", "inherit"] });
  stubs.push(child);
  await new Promise((ok, no) => { child.stdout.once("data", ok); child.once("exit", () => no(new Error("stub exited"))); });
  return { sock, turns: async () => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}
async function configure(L, sock) {
  const cli = await writeCli(L.base, { version: "0.159.0" });
  await fs.writeFile(path.join(L.root, "config.json"), JSON.stringify({ codexCli: cli, codexAppServerSocket: sock, codexVersion: "0.159.0" }), { mode: 0o600 });
}
const waitRow = async (L, pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const hit = (await L.events()).find(pred); if (hit) return hit; await Bun.sleep(50); } return null; };

test("post -> intent -> ring (stub app-server) -> inbox -> inbox-ack, through the product path", async () => {
  const L = await lane(); lanes.push(L);
  const x = await L.codex(); const s = await stub(L, x.threadId); await configure(L, s.sock);
  const a = await L.claude();
  expect((await a.run(["register", "--alias", "test-claude-1"])).code).toBe(0);
  expect((await x.run(["register", "--alias", "test-codex-1"])).code).toBe(0);
  const sent = await a.run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "리뷰 부탁")]);
  const id = sent.json.results[0].messageId;
  const outcome = await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === id);
  expect(outcome).toMatchObject({ state: "sent", mode: "started", recipient: "test-codex-1", threadId: x.threadId });
  const turns = await s.turns();
  expect(turns).toEqual([{ method: "turn/start", threadId: x.threadId, text: `PEER_DOORBELL v=1 message_id=${id}`, expectedTurnId: null }]);
  const box = await x.run(["inbox"]);
  expect(box.json.events.map((e) => e.messageId)).toEqual([id]);
  expect((await x.run(["inbox-ack", "--message-id", id])).json).toMatchObject({ processed: true, already: false });
  const types = (await L.events()).filter((r) => r.messageId === id).map((r) => r.type);
  expect(types.indexOf("peer_post")).toBeLessThan(types.indexOf("doorbell_intent"));
  expect(types.indexOf("doorbell_intent")).toBeLessThan(types.indexOf("doorbell_outcome"));
  expect(types).toContain("peer_post_processed");
});

test("restart in the middle: an intent left open by a crash is rung once when the daemon comes back", async () => {
  const L = await lane(); lanes.push(L);
  const x = await L.codex(); const s = await stub(L, x.threadId); await configure(L, s.sock);
  const a = await L.claude();
  await a.run(["register", "--alias", "test-claude-1"]); await x.run(["register", "--alias", "test-codex-1"]);
  const first = (await a.run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "one")])).json.results[0].messageId;
  expect(await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === first)).toMatchObject({ state: "sent" });
  // The crash: the daemon stopped after writing a post and its intent, before ringing. The two rows
  // are appended with the next seq numbers while it is down, exactly as it would have left them.
  await stopDaemon(L.root);
  const rows = (await fs.readFile(L.paths.events, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const second = "7f6a1c2e-3b4d-5e6f-8a9b-0c1d2e3f4a5b"; let seq = rows.at(-1).seq; const at = new Date().toISOString();
  const add = [{ seq: ++seq, type: "peer_post", at, messageId: second, recipient: "test-codex-1", recipientKind: "codex", recipientThreadId: x.threadId, header: { verb: "PEER_POST", v: "1", messageId: second }, source: "control" },
               { seq: ++seq, type: "doorbell_intent", at, messageId: second, recipient: "test-codex-1", threadId: x.threadId }];
  await fs.appendFile(L.paths.events, add.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await L.owner(["peers"]);                                    // the next call starts the daemon again
  expect(await waitRow(L, (r) => r.type === "doorbell_retry" && r.messageId === second)).not.toBeNull();
  expect(await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === second)).toMatchObject({ state: "sent" });
  const turns = await s.turns();
  expect(turns.filter((t) => t.text.endsWith(second))).toHaveLength(1);
  expect(turns.filter((t) => t.text.endsWith(first))).toHaveLength(1);   // the finished one is not rung again
  // A second restart changes nothing.
  await stopDaemon(L.root); await L.owner(["peers"]); await Bun.sleep(500);
  expect((await s.turns()).length).toBe(turns.length);
  expect((await L.events()).filter((r) => r.type === "doorbell_retry")).toHaveLength(1);
});

test("--replace: the body and the doorbell follow the same binding; the old thread's message is not rung", async () => {
  const L = await lane(); lanes.push(L);
  const x1 = await L.codex(); const s = await stub(L, x1.threadId); await configure(L, s.sock);
  const a = await L.claude();
  await a.run(["register", "--alias", "test-claude-1"]); await x1.run(["register", "--alias", "test-codex-1"]);
  // The stub only answers for x1's thread; post to it while it is bound.
  const early = (await a.run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "early")])).json.results[0].messageId;
  expect(await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === early)).toMatchObject({ state: "sent", threadId: x1.threadId });
  const x2 = await L.codex();
  expect((await x2.run(["register", "--alias", "test-codex-1", "--replace"])).json).toMatchObject({ threadId: x2.threadId });
  const late = (await a.run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "late")])).json.results[0].messageId;
  const out = await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === late);
  expect(out.threadId).toBe(x2.threadId);                       // the doorbell is aimed at the thread the body went to
  expect((await s.turns()).every((t) => t.threadId === x1.threadId)).toBe(true);   // never at x1 for the new message
  expect((await s.turns()).filter((t) => t.text.endsWith(late))).toHaveLength(0);
});

test("Codex post -> Claude doorbell (fixed line on the session socket) -> Claude inbox -> post --reply-to -> Codex doorbell -> Codex inbox", async () => {
  const L = await lane(); lanes.push(L);
  const x = await L.codex(); const s = await stub(L, x.threadId); await configure(L, s.sock);
  const a = await L.claude();
  await a.run(["register", "--alias", "test-claude-1"]); await x.run(["register", "--alias", "test-codex-1"]);
  const sent = await x.run(["post", "--to", "test-claude-1", "--body-file", await writeBody(L, "Codex가 묻습니다")]);
  expect(sent.code).toBe(0);
  const id = sent.json.results[0].messageId;
  expect(await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === id)).toMatchObject({ state: "sent", mode: "session_socket", recipientKind: "claude" });
  const row = JSON.parse(await fs.readFile(path.join(L.sessions, `${a.pid}.json`), "utf8"));
  const frames = await fs.readFile(path.join(path.dirname(row.messagingSocketPath), "frames"), "utf8");
  expect(frames).toContain(`PEER_DOORBELL v=1 message_id=${id}`);
  expect(frames).not.toContain("Codex가 묻습니다");                       // no body on the doorbell path
  const box = await a.run(["inbox"]);
  expect(box.json.events.map((e) => e.messageId)).toEqual([id]);
  const reply = await a.run(["post", "--reply-to", id, "--body-file", await writeBody(L, "Claude가 답합니다")]);
  expect(reply.code).toBe(0);
  const replyId = reply.json.results[0].messageId;
  expect((await a.run(["inbox-ack", "--message-id", id])).json).toMatchObject({ processed: true });
  expect(await waitRow(L, (r) => r.type === "doorbell_outcome" && r.messageId === replyId)).toMatchObject({ state: "sent", recipientKind: "codex", threadId: x.threadId });
  expect((await s.turns()).map((t) => t.text)).toContain(`PEER_DOORBELL v=1 message_id=${replyId}`);
  const cbox = await x.run(["inbox"]);
  expect(cbox.json.events.map((e) => e.messageId)).toEqual([replyId]);
  expect((await x.run(["inbox-ack", "--message-id", replyId])).json).toMatchObject({ processed: true });
});
