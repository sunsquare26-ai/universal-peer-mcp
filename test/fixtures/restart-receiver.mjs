import fsp from "node:fs/promises";
import { EventStore } from "../../src/core/events.mjs";
import { statePaths } from "../../src/core/state-paths.mjs";
import { InboundSpool } from "../../src/core/inbound-spool.mjs";
import { PeerCore, frameObserver } from "../../src/core/peer-core.mjs";
import { startReceiver } from "../../src/adapters/claude-native-v1/receiver.mjs";

const config = JSON.parse(await fsp.readFile(process.argv[2], "utf8"));
const paths = statePaths(config.stateRoot);
const store = new EventStore(paths); await store.init();
// Seed the exact durable request snapshot held before a daemon restart. No resolver, identity
// reader, auth or receive path is mocked; the target remains this test's native parent process.
await store.reserveRequest(config.request);
const core = new PeerCore({ targets: {}, store, address: "pending", inboundSpool: new InboundSpool(paths) });
const receiver = await startReceiver(frameObserver({ core, store }), {
  stateRoot: paths.root, sessionsDir: config.sessionsDir, socketDir: config.socketDir,
  onFrameRefused: (refusal) => store.append("peer_frame_refused", refusal)
});
core.address = receiver.address;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  try { await receiver.close(); await store.close(); process.exit(0); }
  catch { process.exit(1); }
}
process.once("SIGTERM", close);
process.stdout.write(JSON.stringify({ pid: process.pid, address: receiver.address, requests: store.events.filter((e) => e.type === "send_requested").length }) + "\n");
setInterval(() => {}, 60000);
