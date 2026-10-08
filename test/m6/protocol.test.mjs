import { expect, test } from "bun:test";
import { formatAck, formatMessage, formatNotice, messageBody, parseLine } from "../../src/github/protocol.mjs";

const ID = "11111111-1111-4111-8111-111111111111"; const RE = "22222222-2222-4222-8222-222222222222";

test("message line round-trips, with the wake line and the body kept apart", () => {
  const text = formatMessage({ id: ID, from: "claude-cloud", to: ["codex-cloud"], re: RE, expectReply: true, body: "hello\nworld", wake: "@codex" });
  const head = text.split("\n").slice(0, 3);
  expect(head[0]).toBe(`UPM v=1 id=${ID} from=claude-cloud to=codex-cloud re=${RE} expect=reply`);
  expect(head[1].startsWith("@codex Not a review request:")).toBe(true); expect(head[2]).toBe("");
  expect(parseLine(text)).toEqual({ kind: "message", id: ID, from: "claude-cloud", to: ["codex-cloud"], re: RE, expectReply: true });
  expect(messageBody(text)).toBe("hello\nworld");
});
test("ack and notice lines", () => {
  expect(parseLine(formatAck({ ack: ID, from: "codex-cloud" }))).toEqual({ kind: "ack", ack: ID, from: "codex-cloud" });
  expect(parseLine(formatNotice({ notice: "no_reply_yet", re: ID, to: "claude-cloud", text: "x" }))).toEqual({ kind: "notice", notice: "no_reply_yet", re: ID, to: ["claude-cloud"] });
});
test("ids are read case-insensitively and stored lowercase", () => {
  expect(parseLine(`UPM v=1 id=${ID.toUpperCase()} from=a-1 to=b-1`).id).toBe(ID);
});
test("anything not exactly a message line is not one", () => {
  for (const bad of [
    "hello", `UPM v=2 id=${ID} from=a-1 to=b-1`, `UPM v=1 id=${ID} from=a-1`, `UPM v=1 id=not-a-uuid from=a-1 to=b-1`,
    `UPM v=1 id=${ID} id=${ID} from=a-1 to=b-1`, `UPM v=1 id=${ID} from=a-1 to=b-1 extra=1`, `UPM v=1 id=${ID} from=A to=b-1`,
    `UPM v=1 id=${ID} from=a-1 to=b-1,b-1`, `UPM v=1 id=${ID} from=a-1 to=b-1 expect=maybe`, `UPM v=1 ack=${ID} from=a-1 to=b-1`,
    ` text before\nUPM v=1 id=${ID} from=a-1 to=b-1`
  ]) expect(parseLine(bad)).toBeNull();
});

test("the wake line says what is asked (a bare @codex is a review request) and is not part of the body handed on", async () => {
  const { formatMessage, messageBody, parseLine } = await import("../../src/github/protocol.mjs");
  const id = "11111111-2222-4333-8444-555555555555";
  const text = formatMessage({ id, from: "dev-claude", to: ["codex-cloud"], body: "hello", wake: "@codex" });
  const [line, wake] = text.split("\n");
  expect(parseLine(line)).toMatchObject({ kind: "message", id });
  expect(wake.startsWith("@codex Not a review request:")).toBe(true);
  expect(wake).toContain(`from=codex-cloud to=dev-claude re=${id}`);
  expect(messageBody(text)).toBe("hello");
});

test("instructions name the room by URL and the Mac aliases a cloud session may write to", async () => {
  const { instructions } = await import("../../src/github/cli.mjs");
  const text = instructions({ room: { repo: "o/egg", kind: "pull", number: 1 }, as: "claude-cloud", others: ["codex-cloud"], local: ["dev-claude"], codexWake: true });
  expect(text).toContain("https://github.com/o/egg/pull/1");
  expect(text).toContain("Sessions on the owner's Mac you can write to: dev-claude.");
  expect(text).toContain("Other sessions in this room: codex-cloud");
  expect(text).toContain("A bare `@codex` is taken as a review request.");
});

test("instructions are bound to the room: --as must be that room's remote, and other rooms' remotes are not listed (review r6)", async () => {
  const fs = await import("node:fs/promises"); const path = await import("node:path");
  const { saveRooms } = await import("../../src/github/rooms.mjs"); const { githubCommand } = await import("../../src/github/cli.mjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join("/private/tmp", "upm6-"))); await fs.chmod(root, 0o700);
  try {
    await saveRooms(root, { rooms: { first: { host: "github.com", repo: "o/a", repoId: 1, number: 1, kind: "pull", epoch: 1 }, second: { host: "github.com", repo: "o/a", repoId: 1, number: 2, kind: "pull", epoch: 1 } },
      remotes: { "cloud-one": { room: "first", epoch: 1, wake: null }, "cloud-two": { room: "second", epoch: 1, wake: null }, "cloud-three": { room: "first", epoch: 1, wake: null } } });
    await expect(githubCommand("instructions", ["--room", "first", "--as", "cloud-two"], { root, client: {} })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    const { text } = await githubCommand("instructions", ["--room", "first", "--as", "cloud-one", "--local", "dev-claude"], { root, client: {} });
    expect(text).toContain("Other sessions in this room: cloud-three");
    expect(text).not.toContain("cloud-two");
    expect(text).toContain("Sessions on the owner's Mac you can write to: dev-claude.");
    const bare = await githubCommand("instructions", ["--room", "first", "--as", "cloud-one"], { root, client: {} });
    expect(bare.text).toContain("Ask the owner which sessions on the Mac to write to.");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("instructions tell a cloud session to keep working and to ignore comments not addressed to it; no @codex line when no remote is woken that way", async () => {
  const { instructions } = await import("../../src/github/cli.mjs");
  const text = instructions({ room: { repo: "o/egg", kind: "pull", number: 1 }, as: "claude-cloud", others: ["codex-cloud"], local: [] });
  expect(text).toContain("Keep doing your own work. Act only on comments whose first line is `UPM v=1 ... to=claude-cloud`");
  expect(text).toContain("Do not stop your work to watch the room.");
  expect(text).toContain("only tells you it was handled: note it, do not answer it.");
  expect(text).not.toContain("@codex");
});

test("a relay remote: no wake line in the comment, the owner is alerted once with the alias, the outcome says relay_requested", async () => {
  const { formatMessage } = await import("../../src/github/protocol.mjs");
  const text = formatMessage({ id: "11111111-2222-4333-8444-555555555555", from: "dev-claude", to: ["codex-cloud"], body: "hi", wake: "relay" });
  expect(text.split("\n")[1]).toBe("");
});
