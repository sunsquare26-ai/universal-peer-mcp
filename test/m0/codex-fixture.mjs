// Shared M3 fixture: a stand-in Codex CLI and a stand-in app-server connection.
// The CLI answers `--version` and records the argv of every other call; the connection answers
// initialize (with a release in userAgent), thread/loaded/list and thread/read.
import fs from "node:fs/promises";
import path from "node:path";

export const THREAD_UUID = "01a0d249-5457-7f82-8602-b992529eac16";
export const VERSION = "0.157.0";

export async function writeCli(root, { version = VERSION, reply = "Queued message 01a0ead6-9156-7000-8000-000000000000 for thread %T." } = {}) {
  const cli = path.join(root, "codex-fixture");
  await fs.writeFile(cli, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[2]==='--version'){console.log('codex-cli ${version}');process.exit(0);}fs.appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))},JSON.stringify(process.argv.slice(2))+'\\n');fs.writeFileSync(${JSON.stringify(path.join(root, "argv.json"))},JSON.stringify(process.argv.slice(2)));console.log(${JSON.stringify(reply)}.replace('%T',process.argv[4]));`, { mode: 0o700 });
  return cli;
}

export function fakeConnect({ root, state = "idle", version = VERSION, threadId = THREAD_UUID, calls = [] }) {
  return () => ({
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === "initialize") return { userAgent: `codex_cli_rs/${version} (Mac OS 27.0.0; arm64)`, codexHome: "/x", platformFamily: "unix", platformOs: "macos" };
      if (method === "thread/loaded/list") return { data: [threadId] };
      // Like the real server: turns only when asked for them (the adapter must not ask: on a long
      // live thread that answer is tens of MB), the newest turn through thread/turns/list.
      if (method === "thread/read") { if (params?.includeTurns) throw Object.assign(new Error("full hydration requested"), { code: "FULL_HYDRATION" }); return { thread: { id: params?.threadId ?? threadId, cwd: root, status: state === "active" ? { type: "active", activeFlags: [] } : { type: state }, turns: [] } }; }
      if (method === "thread/turns/list") return { data: state === "active" ? [{ id: "turn-1", status: "inProgress" }] : [{ id: "turn-0", status: "completed" }] };
      if (method === "turn/start") return { turn: { id: "turn-2" } };
      if (method === "turn/steer") return { turnId: params.expectedTurnId };
      return {};
    },
    notify() {}, close() {}
  });
}

export async function writeTargets(root, entry) {
  await fs.writeFile(path.join(root, "codex-targets.json"), JSON.stringify({ "codex-main": entry }), { mode: 0o600 });
}
export const queueTarget = (root, cli, extra = {}) => ({ transport: "cli-queue", cliPath: cli, threadId: THREAD_UUID, cwd: root, socketPath: path.join(root, "app-server.sock"), ...extra });
