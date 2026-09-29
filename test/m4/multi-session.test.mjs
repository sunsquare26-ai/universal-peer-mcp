// M4 done criteria on a real daemon from this tree with 2 Claude + 2 Codex session doubles:
// concurrent cross-sends → 0 misdeliveries, 0 duplicate processings, per-pair order kept.
import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import { lane, writeBody } from "./harness.mjs";

const lanes = [];
afterEach(async () => { for (const L of lanes.splice(0)) await L.stop(); });

async function fourSessions() {
  const L = await lane(); lanes.push(L); await L.owner(["peers"]);
  const peers = { "test-claude-1": await L.claude(), "test-claude-2": await L.claude(), "test-codex-1": await L.codex(), "test-codex-2": await L.codex() };
  await Promise.all(Object.entries(peers).map(([alias, s]) => s.run(["register", "--alias", alias]).then((r) => expect(r.json?.state).toBe("registered"))));
  return { L, peers };
}

// A control client that could not reach the daemon did nothing; the ack is idempotent, so it is
// retried once and counted, never hidden.
let clientRetries = 0;
async function ack(session, messageId) {
  let r = await session.run(["inbox-ack", "--message-id", messageId]);
  if (r.code !== 0 && r.error?.code !== "NOT_RECIPIENT") { clientRetries += 1; r = await session.run(["inbox-ack", "--message-id", messageId]); }
  return r;
}

test("2x2 concurrent cross-send: every message reaches exactly its recipient, is processed once, in per-pair order", async () => {
  const { L, peers } = await fourSessions();
  const names = Object.keys(peers); const ROUNDS = 4;
  // Each session, concurrently with the others, sends ROUNDS messages to each other session one by
  // one (pair order), plus one group send to all three others.
  const sent = [];
  await Promise.all(names.map(async (from) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const to of names.filter((n) => n !== from)) {
        const tag = `M4TAG from=${from} to=${to} n=${round}`;
        const r = await peers[from].run(["post", "--to", to, "--body-file", await writeBody(L, tag)]);
        expect(r.code).toBe(0); expect(r.json.from).toBe(from);
        sent.push({ from, to, n: round, messageId: r.json.results[0].messageId });
      }
    }
    const others = names.filter((n) => n !== from);
    const g = await peers[from].run(["post", "--to", others.join(","), "--body-file", await writeBody(L, `M4TAG from=${from} to=* n=group`)]);
    expect(g.json.results.map((x) => x.state)).toEqual(["accepted", "accepted", "accepted"]);
    for (const x of g.json.results) sent.push({ from, to: x.recipient, n: "group", messageId: x.messageId });
  }));
  expect(sent).toHaveLength(names.length * (names.length - 1) * (ROUNDS + 1));   // 60

  // Every session reads its own inbox, concurrently, and processes each message twice over
  // (two concurrent acks, as a retry or a second reader of the same session would).
  let misdelivered = 0; let processedFirst = 0; let processedAgain = 0; const orderBroken = [];
  await Promise.all(names.map(async (me) => {
    const box = await peers[me].run(["inbox"]);
    expect(box.json.alias).toBe(me);
    const rows = box.json.events;
    for (const row of rows) { const m = /^M4TAG from=(\S+) to=(\S+) n=(\S+)$/.exec(row.body); if (!m || (m[2] !== me && m[2] !== "*") || row.recipient !== me) misdelivered += 1; }
    for (const from of names.filter((n) => n !== me)) {
      const seq = rows.filter((r) => r.body.startsWith(`M4TAG from=${from} to=${me} `)).map((r) => Number(/n=(\d+)/.exec(r.body)[1]));
      if (JSON.stringify(seq) !== JSON.stringify([...Array(ROUNDS).keys()])) orderBroken.push(`${from}->${me}:${seq}`);
    }
    expect(rows).toHaveLength((names.length - 1) * (ROUNDS + 1));   // 15 each
    // Per message, two acks at the same moment; messages one after another per session (4 sessions
    // in parallel), so the shared Mini is not asked for 120 processes at once.
    const acks = [];
    for (const row of rows) acks.push(...await Promise.all([ack(peers[me], row.messageId), ack(peers[me], row.messageId)]));
    for (const a of acks) { expect(a.code).toBe(0); if (a.json.already) processedAgain += 1; else processedFirst += 1; }
    expect((await peers[me].run(["inbox"])).json.events).toEqual([]);
  }));
  expect(misdelivered).toBe(0);
  expect(orderBroken).toEqual([]);
  expect(processedFirst).toBe(60); expect(processedAgain).toBe(60);
  const events = await L.events();
  const processed = events.filter((e) => e.type === "peer_post_processed");
  expect(processed).toHaveLength(60);
  expect(new Set(processed.map((e) => e.messageId)).size).toBe(60);
  // Each processing was done by the addressed session and no other.
  const posts = new Map(events.filter((e) => e.type === "peer_post").map((e) => [e.messageId, e]));
  expect(processed.filter((e) => posts.get(e.messageId).recipient !== e.readerAlias)).toEqual([]);
  expect(new Set(sent.map((s) => s.messageId)).size).toBe(60);
  console.log(`M4 2x2: sent=${sent.length} delivered=${[...posts.values()].length} misdelivered=${misdelivered} processed=${processed.length} duplicateProcessing=0 repeatAcksAnsweredAlready=${processedAgain} clientRetries=${clientRetries}`);
}, 180_000);

test("a session cannot read or ack another session's inbox, and an unknown recipient refuses the whole send", async () => {
  const { L, peers } = await fourSessions();
  const r = await peers["test-claude-1"].run(["post", "--to", "test-codex-1", "--body-file", await writeBody(L, "for codex-1 only")]);
  const id = r.json.results[0].messageId;
  expect((await peers["test-codex-2"].run(["inbox", "--recipient", "test-codex-1"])).error).toMatchObject({ code: "RECIPIENT_MISMATCH" });
  expect((await peers["test-codex-2"].run(["inbox-ack", "--message-id", id])).error).toMatchObject({ code: "NOT_RECIPIENT" });
  expect((await peers["test-claude-2"].run(["inbox"])).json.events).toEqual([]);
  expect((await L.owner(["inbox", "--recipient", "test-codex-1"])).error).toMatchObject({ code: "SENDER_UNAUTHENTICATED" });
  const bad = await peers["test-codex-1"].run(["post", "--to", "test-claude-1,nobody-here", "--body-file", await writeBody(L, "x")]);
  expect(bad.error).toMatchObject({ code: "UNKNOWN_RECIPIENT" });
  expect((await peers["test-claude-1"].run(["inbox"])).json.events).toEqual([]);   // nothing half-sent
  const box = (await peers["test-codex-1"].run(["inbox"])).json.events;
  expect(box.map((e) => [e.messageId, e.senderAlias, e.recipientKind])).toEqual([[id, "test-claude-1", "codex"]]);
});

test("a group resent with the same group id is a duplicate per recipient, never a second message", async () => {
  const { L, peers } = await fourSessions();
  const body = await writeBody(L, "group body");
  const first = await peers["test-codex-2"].run(["post", "--to", "test-claude-1,test-claude-2,test-codex-1", "--body-file", body]);
  const again = await peers["test-codex-2"].run(["post", "--to", "test-claude-1,test-claude-2,test-codex-1", "--body-file", body, "--group-id", first.json.groupId]);
  expect(again.json.results.map((x) => x.state)).toEqual(["duplicate", "duplicate", "duplicate"]);
  expect(again.json.results.map((x) => x.messageId)).toEqual(first.json.results.map((x) => x.messageId));
  for (const me of ["test-claude-1", "test-claude-2", "test-codex-1"]) expect((await peers[me].run(["inbox"])).json.events).toHaveLength(1);
  // One ACK does not stand for the group: two recipients still hold theirs.
  await peers["test-claude-1"].run(["inbox-ack", "--message-id", first.json.results[0].messageId]);
  expect((await peers["test-claude-2"].run(["inbox"])).json.events).toHaveLength(1);
  expect((await peers["test-codex-1"].run(["inbox"])).json.events).toHaveLength(1);
});

test("two names for one session (a hand-edited table) get one message, not two", async () => {
  const { L, peers } = await fourSessions();
  const table = JSON.parse(await fsp.readFile(L.paths.targets, "utf8"));
  table["test-claude-1-alt"] = { ...table["test-claude-1"] };
  await fsp.writeFile(L.paths.targets, JSON.stringify(table), { mode: 0o600 });
  const r = await peers["test-codex-1"].run(["post", "--to", "test-claude-1,test-claude-1-alt", "--body-file", await writeBody(L, "once")]);
  expect(r.json.results.map((x) => x.state)).toEqual(["accepted", "same_session"]);
  expect(r.json.results[1].deliveredAs).toBe("test-claude-1");
  expect((await L.events()).filter((e) => e.type === "peer_post")).toHaveLength(1);
});
