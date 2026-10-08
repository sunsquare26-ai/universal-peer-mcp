// M6 end to end through the daemon: a local session posts to a remote alias of a linked room, the
// remote answers in the room, the daemon's poll brings the answer to the session that asked.
import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { lane, stopDaemon, writeBody } from "../m4/harness.mjs";
import { formatMessage, parseLine } from "../../src/github/protocol.mjs";

const lanes = [];
afterEach(async () => { for (const L of lanes.splice(0)) await L.stop(); });

test("local -> remote comment, remote answer -> the asking session's inbox, ack -> the room", async () => {
  const L = await lane(); lanes.push(L);
  const gh = path.join(L.base, "gh"); const db = path.join(L.base, "gh.json");
  await fs.writeFile(gh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dir, "fake-gh.mjs"))} "$@"\n`, { mode: 0o700 });
  Object.assign(L.env, { UNIVERSAL_PEER_GH_PATH: gh, FAKE_GH_DB: db });
  await L.owner(["peers"]);
  const c1 = await L.claude(); expect((await c1.run(["register", "--alias", "dev-claude"])).json.state).toBe("registered");
  expect((await L.owner(["github", "link", "--room", "egg", "--repo", "o/egg", "--number", "5"])).json).toMatchObject({ linked: "egg", repoId: 4242, kind: "pull", epoch: 1 });
  expect((await L.owner(["github", "remote", "--room", "egg", "--alias", "codex-cloud", "--wake", "@codex"])).json).toMatchObject({ remote: "codex-cloud", epoch: 1, wake: "@codex" });
  expect((await L.owner(["github", "remote", "--room", "egg", "--alias", "dev-claude"])).error).toMatchObject({ code: "ALIAS_TAKEN" });
  const sent = await c1.run(["post", "--to", "codex-cloud", "--expect-reply", "--body-file", await writeBody(L, "please review")]);
  const q = sent.json.results[0].messageId;
  await Bun.sleep(300);
  const room = JSON.parse(await fs.readFile(db, "utf8"));
  expect(parseLine(room.comments[0].body)).toMatchObject({ kind: "message", id: q, from: "dev-claude", to: ["codex-cloud"], expectReply: true });
  expect(room.comments[0].body).toContain("\n@codex Not a review request:");
  const rid = crypto.randomUUID();
  room.comments.push({ id: room.next++, user: { login: "codex-bot", type: "Bot" }, created_at: new Date().toISOString(), body: formatMessage({ id: rid, from: "codex-cloud", to: ["dev-claude"], re: q, body: "looks good" }) });
  await fs.writeFile(db, JSON.stringify(room));
  expect((await L.owner(["github", "poll"])).json.egg).toMatchObject({ delivered: 1 });
  const box = (await c1.run(["inbox"])).json.events;
  expect(box.map((e) => [e.body, e.replyTo, e.senderAlias])).toEqual([["looks good", q, "codex-cloud"]]);
  await c1.run(["inbox-ack", "--message-id", box[0].messageId]);
  await Bun.sleep(300);
  const after = JSON.parse(await fs.readFile(db, "utf8"));
  expect(parseLine(after.comments.at(-1).body)).toEqual({ kind: "ack", ack: rid, from: "dev-claude" });
  const view = (await L.owner(["status", "--json"])).json;
  expect(view.peers.find((p) => p.alias === "codex-cloud")).toMatchObject({ kind: "github" });
  expect(view.unregistered).toEqual([]);   // a message to a remote is not "for an alias nobody holds"
}, 60_000);
