import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import {
  hydrateInboundBodies,
  INLINE_BODY_MAX_BYTES,
  INLINE_RESPONSE_CEILING_BYTES,
  INLINE_TOTAL_MAX_BYTES
} from "../src/core/inbound-hydrate.mjs";
import { InboundSpool } from "../src/core/inbound-spool.mjs";
import { frameObserver, PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { redactPublic } from "../src/mcp/redact.mjs";
import { projectSchema, validateSchema } from "../src/mcp/schema-validator.mjs";
import { publicResultSchema, toolDefinitions } from "../src/mcp/tools.mjs";

const REPLY_TO = "14e6f292-e7c0-450b-8181-86c256803ec6";
const THREAD = "9f9f218b-7474-40df-a166-e37d9bcf1a84";
const PEER = { pid: 47687, procStart: "Fri Sep 11 01:14:58 2026" };

// A body this daemon really spooled on 2026-09-11, verbatim. The first two lines are from
// inbound/2026-09-11T100745159Z-90bd48068137b753.txt — the one frame that day that correlated, at
// seq 2474 with `evidence: "inband_header"` — and the third is the path-bearing line from
// inbound/2026-09-11T072100124Z-fdeb411d8c9512dc.txt with the home directory renamed. It is the
// shape the receiver has to be able to read, and it is what pins the cost of the redaction the
// public surface applies to every string it publishes.
const REAL_BODY = [
  "PEER_REPLY re=34acbf18-1860-49b5-b4c3-d3c940fc32e9 verdict=pass",
  "",
  "**이 메시지가 제 형식 수정의 시험입니다. 첫 줄에 토큰만 두고 본문을 둘째 줄부터 씁니다.**",
  `**감수 완료. 파일 \`/Users/x/workspace/var/work/claude/CLAUDE-REVIEW.md\` sha256 \`${"8".repeat(64)}\` 34,637 bytes.**`
].join("\n");

describe("the spooled body is carried in the answer", () => {
  let root; let paths; let store; let core; let onFrame;

  const envelope = (body) => ({ type: "user", from: "uds:/tmp/cc-socks/3390.sock", message: { role: "user", content: body } });
  const rows = (type) => store.events.filter((event) => event.type === type);
  const hydrate = (events, options = {}) => hydrateInboundBodies(events, { root, ...options });

  beforeEach(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "upm-inline-")));
    await fsp.chmod(root, 0o700);
    paths = statePaths(root);
    store = new EventStore(paths); await store.init();
    core = new PeerCore({
      targets: { "main-claude": { sessionId: THREAD, cwd: root, permissionMode: "bypass" } },
      store, address: "uds:/tmp/cc-socks/3390.sock", inboundSpool: new InboundSpool(paths)
    });
    onFrame = frameObserver({ core, store });
    await store.reserveRequest({
      messageId: REPLY_TO, transportMessageId: REPLY_TO, threadId: THREAD, replyTo: null,
      kind: "hello", alias: "main-claude", requestHash: "0".repeat(64), subscriptionId: crypto.randomUUID(),
      targetAlias: "main-claude", targetSessionId: THREAD, targetCwd: root,
      targetSocketPath: "/tmp/cc-socks/47687.sock", targetPid: PEER.pid, targetProcStart: PEER.procStart,
      targetProcStartRendering: "utc0-c-squeezed", targetPermissionMode: "bypass", targetPermissionVerifiedBy: "kern_procargs2"
    });
  });

  afterEach(async () => { await store.close(); await fsp.rm(root, { recursive: true, force: true }); });

  test("a correlated reply answers with the text, not only the file name", async () => {
    // Tokens only on the first line and the body from the second, which is the form that produced
    // the one correlated frame in the ledger (seq 2474, `evidence: "inband_header"`).
    const body = `PEER_REPLY re=14e6f292 verdict=pass\n본문이 둘째 줄에 있습니다\n셋째 줄`;
    await onFrame(envelope(body), PEER, {});
    const [row] = rows("peer_reply");
    const [hydrated] = await hydrate([row]);
    expect(hydrated.body).toBe(body);
    expect(hydrated.bodyInlineBytes).toBe(Buffer.byteLength(body));
    expect(hydrated.bodyInlineTruncated).toBeUndefined();
    expect(hydrated.bodyInlineOmitted).toBeUndefined();
    // The durable record is still the record.
    expect(hydrated.bodyFile).toBe(row.bodyFile);
    expect(hydrated.bodySha256).toBe(crypto.createHash("sha256").update(body).digest("hex"));
    expect(crypto.createHash("sha256").update(hydrated.body).digest("hex")).toBe(row.bodySha256);
  });

  test("a frame that correlated nothing answers with its text too", async () => {
    await onFrame(envelope("표식이 없는 본문입니다"), PEER, { connectionId: 1, frameOrdinal: 2 });
    const [hydrated] = await hydrate(rows("peer_frame_uncorrelated"));
    expect(hydrated.reason).toBe("no_reply_marker");
    expect(hydrated.body).toBe("표식이 없는 본문입니다");
  });

  test("the row the ledger holds is not changed by being read", async () => {
    await onFrame(envelope("본문"), PEER, {});
    const [row] = rows("peer_frame_uncorrelated");
    const before = JSON.stringify(row);
    const [hydrated] = await hydrate([row]);
    expect(hydrated.body).toBe("본문");
    expect(JSON.stringify(row)).toBe(before);
    expect(store.events.at(-1).body).toBeUndefined();
    // And the file on disk is still the whole of it, unchanged by the read.
    expect(await fsp.readFile(path.join(root, row.bodyFile), "utf8")).toBe("본문");
  });

  test("a body over the per-body cap is cut on a character boundary and says so", async () => {
    const long = "가".repeat(INLINE_BODY_MAX_BYTES); // 3 bytes each, so the cap lands mid-character
    await onFrame(envelope(long), PEER, {});
    const [hydrated] = await hydrate(rows("peer_frame_uncorrelated"));
    expect(hydrated.bodyInlineTruncated).toBe(true);
    expect(hydrated.bodyInlineBytes).toBeLessThanOrEqual(INLINE_BODY_MAX_BYTES);
    expect(Buffer.byteLength(hydrated.body)).toBe(hydrated.bodyInlineBytes);
    expect(hydrated.body).toBe(long.slice(0, hydrated.body.length));
    expect(hydrated.body.endsWith("�")).toBe(false);
    // The whole of it is still reachable, and the row still says how big the whole of it is.
    expect(hydrated.bodyBytes).toBe(Buffer.byteLength(long));
    expect(await fsp.readFile(path.join(root, hydrated.bodyFile), "utf8")).toBe(long);
  });

  test("the newest rows get the response budget and the rest say why they have none", async () => {
    const spool = new InboundSpool(paths);
    const events = [];
    for (let index = 1; index <= 4; index += 1) {
      const written = await spool.write("x".repeat(1000));
      events.push({ seq: index, type: "peer_frame_uncorrelated", at: new Date().toISOString(), reason: "no_reply_marker", ...written });
    }
    const hydrated = await hydrate(events, { total: 1500 });
    expect(hydrated[3].body).toHaveLength(1000);
    expect(hydrated[3].bodyInlineTruncated).toBeUndefined();
    expect(hydrated[2].body).toHaveLength(500);
    expect(hydrated[2].bodyInlineTruncated).toBe(true);
    expect(hydrated[1].body).toBeUndefined();
    expect(hydrated[1].bodyInlineOmitted).toBe("response_budget");
    expect(hydrated[0].bodyInlineOmitted).toBe("response_budget");
    for (const row of hydrated) expect(row.bodyFile).toStartWith("inbound/");
  });

  test("a response already at the ceiling inlines nothing rather than failing", async () => {
    await onFrame(envelope("본문"), PEER, {});
    const [hydrated] = await hydrate(rows("peer_frame_uncorrelated"), { ceiling: 1 });
    expect(hydrated.body).toBeUndefined();
    expect(hydrated.bodyInlineOmitted).toBe("response_budget");
    expect(hydrated.bodyFile).toStartWith("inbound/");
  });

  test("a file that is gone is named as unreadable, not as an empty body", async () => {
    await onFrame(envelope("본문"), PEER, {});
    const [row] = rows("peer_frame_uncorrelated");
    await fsp.rm(path.join(root, row.bodyFile));
    const [hydrated] = await hydrate([row]);
    expect(hydrated.body).toBeUndefined();
    expect(hydrated.bodyInlineOmitted).toBe("unreadable");
  });

  test("a spool name swapped for a symbolic link is not followed", async () => {
    await onFrame(envelope("본문"), PEER, {});
    const [row] = rows("peer_frame_uncorrelated");
    const file = path.join(root, row.bodyFile);
    const secret = path.join(root, "targets.json");
    await fsp.writeFile(secret, "{\"main-claude\":{}}", { mode: 0o600 });
    await fsp.rm(file); await fsp.symlink(secret, file);
    const [hydrated] = await hydrate([row]);
    expect(hydrated.body).toBeUndefined();
    expect(hydrated.bodyInlineOmitted).toBe("unreadable");
  });

  test("a recorded name that is not a spool file is read as a name and reaches nothing", async () => {
    await fsp.writeFile(path.join(root, "targets.json"), "{\"main-claude\":{}}", { mode: 0o600 });
    const names = ["inbound/../targets.json", "inbound/a/b.txt", "../targets.json", "/etc/passwd", "inbound/.txt", "targets.json"];
    const events = names.map((bodyFile, index) => ({ seq: index + 1, type: "peer_frame_uncorrelated", at: new Date().toISOString(), bodyFile }));
    const hydrated = await hydrate(events);
    for (const row of hydrated) {
      expect(row.body).toBeUndefined();
      expect(row.bodyInlineOmitted).toBeUndefined();
      expect(row.bodyFile).toBe(events[hydrated.indexOf(row)].bodyFile);
    }
  });

  test("rows with no body at all come back as they were", async () => {
    const events = store.events.slice();
    const hydrated = await hydrate(events);
    expect(hydrated).toBe(events);
  });
});

describe("the body reaches a caller through the published contract", () => {
  const tools = toolDefinitions(["main-claude"]);
  const tool = (name) => tools.find((item) => item.name === name);
  const publish = (name, raw) => {
    const schema = publicResultSchema(tool(name));
    const value = redactPublic(projectSchema(schema, raw));
    const checked = validateSchema(schema, value);
    expect(checked.errors).toEqual([]);
    expect(checked.valid).toBe(true);
    return value;
  };
  const row = (extra) => ({
    seq: 2476, type: "peer_reply", at: "2026-09-11T10:07:45.159Z", messageId: REPLY_TO, threadId: THREAD,
    evidence: "inband_header", bodyFile: "inbound/2026-09-11T100745159Z-90bd48068137b753.txt",
    bodyBytes: 4047, bodySha256: "a".repeat(64), ...extra
  });

  test("peer_list_events publishes the text and the four new fields survive projection", () => {
    const published = publish("peer_list_events", {
      cursor: 2476,
      events: [row({ body: "본문입니다\n두 번째 줄", bodyInlineBytes: 29, peerPid: 47687 })]
    });
    expect(published.events[0].body).toBe("본문입니다\n두 번째 줄");
    expect(published.events[0].bodyInlineBytes).toBe(29);
    // A sibling the schema does not declare is still projected off, which is what this proves the
    // four new fields are not.
    expect(published.events[0].peerPid).toBeUndefined();
  });

  test("a truncated body and an omitted body both say so where the caller can see it", () => {
    const cut = publish("peer_list_events", { cursor: 1, events: [row({ body: "앞부분만", bodyInlineBytes: 12, bodyInlineTruncated: true })] }).events[0];
    expect(cut.bodyInlineTruncated).toBe(true);
    expect(cut.bodyFile).toBe("inbound/2026-09-11T100745159Z-90bd48068137b753.txt");
    expect(cut.bodyBytes).toBe(4047);
    const omitted = publish("peer_list_events", { cursor: 1, events: [row({ bodyInlineOmitted: "response_budget" })] }).events[0];
    expect(omitted.bodyInlineOmitted).toBe("response_budget");
    expect(omitted.body).toBeUndefined();
    expect(omitted.bodyFile).toBe("inbound/2026-09-11T100745159Z-90bd48068137b753.txt");
  });

  test("peer_wait publishes it under event and under events, and a peer_send replay does too", () => {
    const waited = publish("peer_wait", { event: row({ body: "본문" }), events: [row({ body: "본문" })], evidence: "inband_header" });
    expect(waited.event.body).toBe("본문");
    expect(waited.events[0].body).toBe("본문");
    const replay = publish("peer_send", { replay: true, messageId: REPLY_TO, requestHash: "b".repeat(64), status: "replied", events: [row({ body: "본문" })] });
    expect(replay.events[0].body).toBe("본문");
  });

  test("a real spooled body survives, and the absolute path inside it is redacted as every published path is", () => {
    const published = publish("peer_list_events", { cursor: 1, events: [row({ body: REAL_BODY, bodyInlineBytes: Buffer.byteLength(REAL_BODY) })] }).events[0];
    expect(published.body).toStartWith("PEER_REPLY re=34acbf18-1860-49b5-b4c3-d3c940fc32e9 verdict=pass\n");
    expect(published.body).toContain("첫 줄에 토큰만 두고 본문을 둘째 줄부터 씁니다");
    expect(published.body).toContain("8".repeat(64));
    expect(published.body).toContain("34,637 bytes");
    // Measured cost, stated rather than hidden: the public surface rewrites absolute paths, so the
    // inline copy is readable and is not byte-exact. `bodyFile` is what holds the bytes.
    expect(published.body).not.toContain("/Users/x/workspace");
    expect(published.body).toContain("[path]");
    expect(published.bodyFile).toBe("inbound/2026-09-11T100745159Z-90bd48068137b753.txt");
  });

  test("a redaction that makes the text longer does not fail the tool result", () => {
    const body = "sk-abcdefgh";
    expect(Buffer.byteLength(redactPublic(body))).toBeGreaterThan(Buffer.byteLength(body));
    const published = publish("peer_list_events", { cursor: 1, events: [row({ body, bodyInlineBytes: 11 })] }).events[0];
    expect(published.body).toBe("[credential]");
    expect(published.bodyInlineBytes).toBe(11);
  });

  test("the bounds are the numbers the module states", () => {
    expect(INLINE_BODY_MAX_BYTES).toBe(8 * 1024);
    expect(INLINE_TOTAL_MAX_BYTES).toBe(64 * 1024);
    expect(INLINE_RESPONSE_CEILING_BYTES).toBe(896 * 1024);
    // The guard is under the refusal it exists for (src/core/control.mjs).
    expect(INLINE_RESPONSE_CEILING_BYTES + INLINE_TOTAL_MAX_BYTES).toBeLessThan(1024 * 1024);
  });
});
