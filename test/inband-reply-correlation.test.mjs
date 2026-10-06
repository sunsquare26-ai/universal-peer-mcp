import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { InboundSpool, MAX_INBOUND_BODY_BYTES } from "../src/core/inbound-spool.mjs";
import { frameObserver, PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";
import { parseMarker, parseReplyHeader } from "../src/adapters/claude-native-v1/protocol.mjs";
import { redactPublic } from "../src/mcp/redact.mjs";
import { projectSchema, validateSchema } from "../src/mcp/schema-validator.mjs";
import { publicResultSchema, toolDefinitions } from "../src/mcp/tools.mjs";

const REPLY_TO = "14e6f292-e7c0-450b-8181-86c256803ec6";
const THREAD = "9f9f218b-7474-40df-a166-e37d9bcf1a84";
const PEER = { pid: 47687, procStart: "Fri Sep 11 01:14:58 2026" };

// The three first lines a Claude Code session actually wrote on 2026-09-11, verbatim from its own
// transcript. These are the regression: each was dropped under `no_reply_marker`.
const REAL_LINES = [
  `PEER_REPLY thread=9f9f218b replyTo=${REPLY_TO} roundtrip=OK`,
  `PEER_REPLY thread=9f9f218b re=${REPLY_TO} verdict=delivery-OK-correlation-impossible`,
  "PEER_ACK thread=9f9f218b review=in-progress board=queued"
];

describe("parseMarker is unchanged", () => {
  const strict = `PEER_REPLY v=1 message_id=${crypto.randomUUID()} thread_id=${THREAD} reply_to=${REPLY_TO} verdict=pass`;

  test("the strict marker still parses and carries no style", () => {
    const marker = parseMarker(strict);
    expect(marker).not.toBeNull();
    expect(marker.type).toBe("reply");
    expect(marker.verdict).toBe("pass");
    expect(marker.style).toBeUndefined();
  });

  test("a strict reply with a verdict off the closed list is still refused", () => {
    expect(parseMarker(strict.replace("verdict=pass", "verdict=owner-approved"))).toBeNull();
  });

  test("the strict reader still refuses every line the session really sent", () => {
    for (const line of REAL_LINES) expect(parseMarker(line)).toBeNull();
  });
});

describe("parseReplyHeader", () => {
  test("accepts a valid reference; an explicitly malformed verdict refuses correlation", () => {
    const first = parseReplyHeader(REAL_LINES[0]);
    expect(first).toMatchObject({ style: "inband_header", type: "reply", replyTo: "14e6f292e7c0450b818186c256803ec6", threadId: "9f9f218b", verdict: null });
    const second = parseReplyHeader(REAL_LINES[1]);
    expect(second).toBeNull();
  });

  test("leaves the real line that named no reference uncorrelated", () => {
    expect(parseReplyHeader(REAL_LINES[2])).toBeNull();
  });

  test("reads every spelling of the reference key and ignores the rest", () => {
    for (const key of ["re", "replyTo", "reply_to", "REPLY-TO"]) {
      expect(parseReplyHeader(`PEER_REPLY ${key}=${REPLY_TO} kind=diagnosis board=queued`).replyTo)
        .toBe("14e6f292e7c0450b818186c256803ec6");
    }
  });

  test("takes a bare eight-hex reference and a dashless uuid alike", () => {
    expect(parseReplyHeader("PEER_ACK re=14e6f292").replyTo).toBe("14e6f292");
    expect(parseReplyHeader(`PEER_ACK re=${REPLY_TO.replaceAll("-", "")}`).replyTo).toBe("14e6f292e7c0450b818186c256803ec6");
  });

  test("refuses a reference that is not hex, a short one, a duplicate, and v other than 1", () => {
    expect(parseReplyHeader("PEER_REPLY re=peer_frame_uncorrelated kind=diagnosis")).toBeNull();
    expect(parseReplyHeader("PEER_REPLY re=14e6f29")).toBeNull();
    expect(parseReplyHeader(`PEER_REPLY re=${REPLY_TO} re=${THREAD}`)).toBeNull();
    expect(parseReplyHeader(`PEER_REPLY v=2 re=${REPLY_TO}`)).toBeNull();
  });

  test("reads pass and fail and refuses an explicitly malformed verdict", () => {
    expect(parseReplyHeader(`PEER_REPLY re=${REPLY_TO} verdict=FAIL`).verdict).toBe("fail");
    expect(parseReplyHeader(`PEER_REPLY re=${REPLY_TO} verdict=criteria-met-with-H3`)).toBeNull();
  });

  test("reads only the first line and ignores the body under it", () => {
    expect(parseReplyHeader(`PEER_ACK re=${REPLY_TO}\nre=deadbeefdeadbeef\n본문입니다`).replyTo)
      .toBe("14e6f292e7c0450b818186c256803ec6");
  });

  test("refuses a line with no tokens and one with too many", () => {
    expect(parseReplyHeader("PEER_REPLY")).toBeNull();
    expect(parseReplyHeader(`PEER_REPLY re=${REPLY_TO} ${Array.from({ length: 13 }, (_, i) => `k${i}=v`).join(" ")}`)).toBeNull();
  });
});

describe("the inbound spool and the frame path", () => {
  let root; let paths; let store; let core; let onFrame;

  const envelope = (body) => ({
    type: "user", from: "uds:/tmp/cc-socks/3390.sock",
    message: { role: "user", content: body }
  });

  beforeEach(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "upm-test-")));
    await fsp.chmod(root, 0o700);
    paths = statePaths(root);
    store = new EventStore(paths); await store.init();
    core = new PeerCore({
      targets: { "main-claude": { sessionId: THREAD, cwd: root, permissionMode: "bypass" } },
      store, address: "uds:/tmp/cc-socks/3390.sock", inboundSpool: new InboundSpool(paths)
    });
    onFrame = frameObserver({ core, store });
    // One real request to correlate against, written the way `send` writes it.
    await store.reserveRequest({
      messageId: REPLY_TO, transportMessageId: REPLY_TO, threadId: THREAD, replyTo: null,
      kind: "hello", alias: "main-claude", requestHash: "0".repeat(64), subscriptionId: crypto.randomUUID(),
      targetAlias: "main-claude", targetSessionId: THREAD, targetCwd: root,
      targetSocketPath: "/tmp/cc-socks/47687.sock", targetPid: PEER.pid, targetProcStart: PEER.procStart,
      targetProcStartRendering: "utc0-c-squeezed", targetPermissionMode: "bypass", targetPermissionVerifiedBy: "kern_procargs2"
    });
  });

  afterEach(async () => { await store.close(); await fsp.rm(root, { recursive: true, force: true }); });

  const rows = (type) => store.events.filter((event) => event.type === type);

  test("a frame with no marker at all keeps its body and says why it matched nothing", async () => {
    await onFrame(envelope("본문만 있고 표식이 없습니다"), PEER, { connectionId: 1, frameOrdinal: 2 });
    const [row] = rows("peer_frame_uncorrelated");
    expect(row.reason).toBe("no_reply_marker");
    expect(row.bodyFile).toStartWith("inbound/");
    expect(await fsp.readFile(path.join(root, row.bodyFile), "utf8")).toBe("본문만 있고 표식이 없습니다");
    expect(row.bodySha256).toBe(crypto.createHash("sha256").update("본문만 있고 표식이 없습니다").digest("hex"));
    expect(row.bodyBytes).toBe(Buffer.byteLength("본문만 있고 표식이 없습니다"));
  });

  test("the real line that correlated nothing before now writes peer_reply", async () => {
    const body = `${REAL_LINES[0]}\n본문 전체가 여기에 있습니다`;
    expect(await onFrame(envelope(body), PEER, { connectionId: 1, frameOrdinal: 2 })).toBeUndefined();
    expect(rows("peer_frame_uncorrelated")).toHaveLength(0);
    const [row] = rows("peer_reply");
    expect(row.messageId).toBe(REPLY_TO);
    expect(row.threadId).toBe(THREAD);
    expect(row.evidence).toBe("inband_header");
    expect(row.responseMessageId).toBeUndefined();
    expect(await fsp.readFile(path.join(root, row.bodyFile), "utf8")).toBe(body);
  });

  test("an eight-hex reference resolves against the ledger's own row", async () => {
    await onFrame(envelope(`PEER_ACK re=14e6f292 kind=roundtrip\n본문`), PEER, {});
    expect(rows("peer_ack")[0].messageId).toBe(REPLY_TO);
  });

  test("a thread that does not match the bound request is refused and the body still kept", async () => {
    await onFrame(envelope(`PEER_REPLY re=${REPLY_TO} thread=deadbeef\n본문`), PEER, {});
    const [row] = rows("peer_frame_uncorrelated");
    expect(row.reason).toBe("reply_thread_mismatch");
    expect(row.bodyFile).toStartWith("inbound/");
  });

  test("an ambiguous reference is refused rather than resolved", async () => {
    const sibling = `${REPLY_TO.slice(0, 8)}-0000-4000-8000-000000000000`;
    await store.reserveRequest({ messageId: sibling, transportMessageId: sibling, threadId: THREAD, replyTo: null, kind: "hello", alias: "main-claude", requestHash: "1".repeat(64), subscriptionId: crypto.randomUUID(), targetAlias: "main-claude", targetPid: PEER.pid, targetProcStart: PEER.procStart, targetProcStartRendering: "utc0-c-squeezed" });
    await onFrame(envelope("PEER_ACK re=14e6f292\n본문"), PEER, {});
    expect(rows("peer_frame_uncorrelated")[0].reason).toBe("ambiguous_reply_reference");
  });

  test("a strict marker still correlates and is still recorded as application_ack", async () => {
    const own = crypto.randomUUID();
    await onFrame(envelope(`PEER_REPLY v=1 message_id=${own} thread_id=${THREAD} reply_to=${REPLY_TO} verdict=pass\n본문`), PEER, {});
    const [row] = rows("peer_reply");
    expect(row.evidence).toBe("application_ack");
    expect(row.responseMessageId).toBe(own);
    expect(row.verdict).toBe("pass");
  });

  test("a reference naming no request of ours stays uncorrelated", async () => {
    await onFrame(envelope("PEER_ACK re=ffffffffffffffff\n본문"), PEER, {});
    expect(rows("peer_frame_uncorrelated")[0].reason).toBe("unknown_reply_target");
  });

  test("a body over the cap is cut on a character boundary and says so", async () => {
    const spool = new InboundSpool(paths);
    const written = await spool.write("가".repeat(MAX_INBOUND_BODY_BYTES));
    expect(written.bodyTruncated).toBe(true);
    expect(written.bodyBytes).toBeLessThanOrEqual(MAX_INBOUND_BODY_BYTES);
    const bytes = await fsp.readFile(path.join(root, written.bodyFile));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBeString();
    expect(written.bodySha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  });

  test("the spool file is private and the row never carries an absolute path", async () => {
    await onFrame(envelope("본문"), PEER, {});
    const [row] = rows("peer_frame_uncorrelated");
    expect(row.bodyFile.startsWith("/")).toBe(false);
    expect((await fsp.lstat(path.join(root, row.bodyFile))).mode & 0o077).toBe(0);
  });
});

describe("the new fields reach a caller", () => {
  const tool = toolDefinitions(["main-claude"]).find((item) => item.name === "peer_list_events");
  const publish = (events) => {
    const value = redactPublic(projectSchema(publicResultSchema(tool), { cursor: 1, events }));
    expect(validateSchema(publicResultSchema(tool), value).valid).toBe(true);
    return value.events[0];
  };

  test("reason and the body reference survive projection, redaction and validation", () => {
    const published = publish([{
      seq: 1, type: "peer_frame_uncorrelated", at: "2026-09-11T05:58:03.627Z",
      reason: "no_reply_marker", bodyFile: "inbound/20260911T055803627Z-1f0cab.txt",
      bodyBytes: 1840, bodySha256: "a".repeat(64), connectionId: 203, frameOrdinal: 2
    }]);
    expect(published.reason).toBe("no_reply_marker");
    expect(published.bodyFile).toBe("inbound/20260911T055803627Z-1f0cab.txt");
    expect(published.bodyBytes).toBe(1840);
    // Undeclared fields are projected off, which is what kept `reason` invisible until now.
    expect(published.connectionId).toBeUndefined();
  });

  test("an absolute path in the same field would not have survived", () => {
    expect(redactPublic({ bodyFile: "/Users/x/var/peer-mcp/codex-u1/inbound/a.txt" }).bodyFile).toBe("[path]");
  });

  test("inband_header is publishable as evidence and target_resolve_failed as a named reason", () => {
    expect(publish([{ seq: 1, type: "peer_reply", at: "2026-09-11T05:58:03.627Z", evidence: "inband_header" }]).evidence).toBe("inband_header");
    expect(publish([{ seq: 1, type: "target_resolve_failed", at: "2026-09-11T05:58:03.627Z", alias: "main-claude", reason: "no_live_session_for_session_id" }]).reason).toBe("no_live_session_for_session_id");
  });
});
