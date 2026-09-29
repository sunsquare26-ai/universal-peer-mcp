// M0 reproduction of 2026-09-29 §1-1 against the code that is running (see running-sut.mjs).
//
//   d7e3473e (seq 4688 send, seq 4691 reply 8.3 s later): the reply's first line was prose, the
//     strict PEER_ACK was on line 2 and reused the request id as its own message_id.
//     -> peer_frame_uncorrelated(no_reply_marker). Body kept. Sender never saw an ACK.
//   13457e71 (seq 4692 send, seq 4695 ack 7.5 s later): strict PEER_ACK on line 1, fresh uuid.
//     -> peer_ack(application_ack).
//
// The design keeps the strict half (no free-text auto-binding, 100% kept). What it changes (M2) is
// that the unpaired row must say who wrote it, and a self-referencing response id is not an ACK.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { RUNNING_AVAILABLE, THREAD, PEER, loadRunning, fixture, frame } from "./running-sut.mjs";

const strictAck = (messageId, replyTo) => `PEER_ACK v=1 message_id=${messageId} thread_id=${THREAD} reply_to=${replyTo}`;

describe.skipIf(!RUNNING_AVAILABLE)("running SUT: reply framing", () => {
  let sut; let f;
  beforeAll(async () => { sut = await loadRunning(); });
  beforeEach(async () => { f = await fixture(sut); });
  afterEach(async () => { await f.close(); });

  test("reproduce d7e3473e: prose first, ACK on line 2 -> uncorrelated, body kept, nothing bound", async () => {
    const body = `수신했습니다. 아래가 확인 줄입니다.\n${strictAck(f.requestId, f.requestId)}`;
    await f.onFrame(frame(body), PEER, { connectionId: 1, frameOrdinal: 2 });
    expect(f.rows("peer_ack")).toHaveLength(0);
    const [row] = f.rows("peer_frame_uncorrelated");
    expect(row.reason).toBe("no_reply_marker");
    expect(await fsp.readFile(path.join(f.root, row.bodyFile), "utf8")).toBe(body);
    expect(row.bodySha256).toBe(crypto.createHash("sha256").update(body).digest("hex"));
  });

  test("control 13457e71: strict ACK on line 1 with a fresh id -> peer_ack", async () => {
    const own = crypto.randomUUID();
    await f.onFrame(frame(`${strictAck(own, f.requestId)}\n확인`), PEER, {});
    const [row] = f.rows("peer_ack");
    expect(row.messageId).toBe(f.requestId);
    expect(row.responseMessageId).toBe(own);
    expect(row.evidence).toBe("application_ack");
  });

  test.failing("M2: an unpaired row records the writer's pid and process start", async () => {
    await f.onFrame(frame("UP_REVERSE_PROBE 55238af8"), PEER, { connectionId: 1, frameOrdinal: 2 });
    const [row] = f.rows("peer_frame_uncorrelated");
    expect(row.peerPid).toBe(PEER.pid);
    expect(row.peerProcStart).toBe(PEER.procStart);
  });

  test.failing("M2: an ACK whose own message_id is the request id is not an ACK", async () => {
    await f.onFrame(frame(strictAck(f.requestId, f.requestId)), PEER, {});
    expect(f.rows("peer_ack")).toHaveLength(0);
  });

  test.failing("M2: a refused reply (writer identity mismatch) still leaves a body hash to link later", async () => {
    const other = { pid: PEER.pid + 1, procStart: PEER.procStart };
    await f.onFrame(frame(`${strictAck(crypto.randomUUID(), f.requestId)}\n본문`), other, {}).catch(() => {});
    const [row] = f.rows("peer_frame_refused");
    expect(row.reason).toBe("inbound_identity_mismatch");
    expect(row.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
