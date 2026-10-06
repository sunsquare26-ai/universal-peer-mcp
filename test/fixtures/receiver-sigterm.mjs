import { startReceiver } from "../../src/adapters/claude-native-v1/receiver.mjs";

const receiver = await startReceiver(async () => {}, {
  sessionsDir: process.env.TEST_SESSIONS_DIR,
  socketDir: process.env.TEST_SOCKET_DIR,
  stateRoot: process.env.TEST_STATE_ROOT
});

let closing = false;
async function close(signal) {
  if (closing) return;
  closing = true;
  try { await receiver.close(); process.exit(0); }
  catch (error) { process.stderr.write(`${signal}: ${error?.message ?? error}\n`); process.exit(1); }
}

process.once("SIGINT", () => close("SIGINT"));
process.once("SIGTERM", () => close("SIGTERM"));
process.stdout.write(`${JSON.stringify({ pid: process.pid, address: receiver.address })}\n`);
setInterval(() => {}, 60_000);
