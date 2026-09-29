// M0 reproduction of the manual triple-send (design review [상]3): one request went out as
// `codex queue` (23:27:41.828Z), SendMessage (23:27:45.065Z, ledger seq 4525, 591 bytes) and an
// inbox-file section, with three different bodies and no shared UUID. A later notice also
// mis-copied a request number (337336325 for 33733632).
//
// M2 contract: the tool mints the id, every path's first line carries it
// (`PEER_POST v=1 message_id=<uuid>`), and the receiver processes one id once.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNNING_AVAILABLE, PEER, loadRunning, fixture, frame } from "./running-sut.mjs";
import { CodexWake } from "../../src/extensions/codex-queue/index.mjs";
import { checkQueueArgv } from "./contract.mjs";

describe.skipIf(!RUNNING_AVAILABLE)("running SUT: an independent Claude -> daemon message", () => {
  let sut; let f;
  beforeAll(async () => { sut = await loadRunning(); });
  beforeEach(async () => { f = await fixture(sut); });
  afterEach(async () => { await f.close(); });

  test("seq 4708 / 4517 after M2: a free-text message still has no id, but now names its writer", async () => {
    await f.onFrame(frame("직원 화면 M1 감수 부탁드립니다"), PEER, {});
    const [row] = f.rows("peer_frame_uncorrelated");
    expect(row.reason).toBe("no_reply_marker");
    expect(row.messageId).toBeUndefined();
    expect(row).toMatchObject({ peerPid: PEER.pid, senderAlias: "friday-main" });
  });

  test("M2 (passing since M2): a PEER_POST first line is recorded under its own message id", async () => {
    const id = crypto.randomUUID();
    await f.onFrame(frame(`PEER_POST v=1 message_id=${id}\n직원 화면 M1 감수`), PEER, {});
    expect(f.rows("peer_frame_uncorrelated").filter((r) => r.reason === "no_reply_marker")).toHaveLength(0);
    expect(f.rows().some((r) => r.messageId === id)).toBe(true);
  });

  test("M2 (passing since M2): the same PEER_POST arriving twice (primary + fallback copy) is processed once", async () => {
    const id = crypto.randomUUID(); const body = `PEER_POST v=1 message_id=${id}\n직원 화면 M1 감수`;
    await f.onFrame(frame(body), PEER, {}); await f.onFrame(frame(body), PEER, {});
    const accepted = f.rows().filter((r) => r.messageId === id && !/duplicate/.test(r.type) && !r.duplicate);
    expect(accepted).toHaveLength(1);
  });
});

test("M2/M3 (passing since M2): the queue doorbell and the daemon record name the same tool-made id", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "upm-m0-triple-")));
  try {
    const cli = path.join(root, "codex-fixture");
    await fs.writeFile(cli, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root, "argv.json"))},JSON.stringify(process.argv.slice(2)));console.log('Queued message x for thread '+process.argv[4]+'.');`, { mode: 0o700 });
    const threadId = "01a0d249-5457-7f82-8602-b992529eac16";
    await fs.writeFile(path.join(root, "codex-targets.json"), JSON.stringify({ "codex-main": { transport: "cli-queue", cliPath: cli, threadId, cwd: root } }), { mode: 0o600 });
    const id = crypto.randomUUID();
    await new CodexWake({ root }).wake({ codexAlias: "codex-main", messageId: id, body: "직원 화면 M1 감수" });
    expect(checkQueueArgv(JSON.parse(await fs.readFile(path.join(root, "argv.json"), "utf8"))).messageId).toBe(id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
