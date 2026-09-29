// Real production shutdown function with isolated resources and a deliberately wedged ledger.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { EventStore } from "../../src/core/events.mjs";
import { ensurePrivateDirectory, statePaths } from "../../src/core/state-paths.mjs";
import { shutdownResources } from "../../src/core/shutdown.mjs";
import { receiverSocketPath, startReceiver } from "../../src/adapters/claude-native-v1/receiver.mjs";
import { processStart } from "../../src/adapters/claude-native-v1/darwin-procargs.mjs";

const SHUTDOWN_WAIT_MILLIS = Number(process.env.TEST_SHUTDOWN_WAIT_MILLIS ?? 8000);
const receiverBounds = {};
if (process.env.TEST_DRAIN_MILLIS) receiverBounds.drainMillis = Number(process.env.TEST_DRAIN_MILLIS);
if (process.env.TEST_REFUSAL_REPORT_MILLIS) receiverBounds.refusalReportMillis = Number(process.env.TEST_REFUSAL_REPORT_MILLIS);
const paths = statePaths(process.env.TEST_STATE_ROOT);
await ensurePrivateDirectory(paths.root);
const store = new EventStore(paths);
await store.init();
// The ledger works before it is wedged, so the wedge is the variable and not a broken fixture.
await store.append("fixture_precheck", {});

const server = net.createServer(() => {});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.controlSocket, resolve); });

let entered; const accepted = new Promise((resolve) => { entered = resolve; });
const receiver = await startReceiver(
  async (frame) => { entered(frame); await new Promise(() => {}); },   // accepted, never recorded
  {
    sessionsDir: process.env.TEST_SESSIONS_DIR,
    socketDir: process.env.TEST_SOCKET_DIR,
    stateRoot: paths.root,
    peerIdentityReader: () => ({ pid: process.pid, uid: process.getuid(), procStart: processStart() }),
    // Verbatim the wiring in src/daemon.mjs.
    onFrameRefused: async (refusal) => { await store.append("peer_frame_refused", refusal); },
    ...receiverBounds
  }
);

// One frame accepted and unrecordable, so the shutdown has something to strand and report.
const socketPath = receiverSocketPath(paths.root, process.env.TEST_SOCKET_DIR);
const keyName = `${process.pid}.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`;
const { peerToken } = JSON.parse(await fsp.readFile(path.join(process.env.TEST_SESSIONS_DIR, keyName), "utf8"));
const client = net.createConnection({ path: socketPath });
await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
client.write(`${JSON.stringify({ type: "auth", token: peerToken })}\n`);
client.write(`${JSON.stringify({ type: "reply", n: 1 })}\n`);
await accepted;

// A readerless FIFO where the event log was. `EventStore#write` opens that path O_WRONLY per
// append, and that open does not return until something opens the read end — so the write chain
// stops with no error to catch, which is what a wedged ledger is. Every later `append` queues
// behind it, including the shutdown's own refusal report and `store.close()`.
if (process.env.TEST_STALL_LEDGER === "1") {
  await fsp.rm(paths.events);
  execFileSync("/usr/bin/mkfifo", ["-m", "600", paths.events]);
  const wedge = store.append("fixture_wedge", {});
  wedge.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
}

let closing = false;
async function shutdown(signal) {
  if (closing) return; closing = true;
  const startedAt = Date.now();
  const problems = await shutdownResources({ server, receiver, store, paths, timeoutMs: SHUTDOWN_WAIT_MILLIS });
  for (const problem of problems) process.stderr.write(`shutdown incomplete: ${problem.reason?.code ?? "INTERNAL_FAILURE"}: ${problem.reason?.message ?? "unknown"}\n`);
  process.stderr.write(`${signal}: shutdown took ${Date.now() - startedAt} ms with ${problems.length} problem(s)\n`);
  process.exit(problems.length > 0 ? 1 : 0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.stdout.write(`${JSON.stringify({ pid: process.pid, address: receiver.address })}\n`);
setInterval(() => {}, 60_000);
