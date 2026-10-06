// A stand-in Codex app-server for tests: websocket JSON-RPC on a unix socket (the transport the
// real one uses), one loaded thread. Records every turn/start and turn/steer input to <log>.
//   node stub-app-server.cjs <socket> <threadId> <state idle|active> <log> [version]
const http = require("node:http"); const fs = require("node:fs");
const { WebSocketServer } = require(require.resolve("ws", { paths: [process.cwd()] }));
const [sock, threadId, state, log, version = "0.159.0"] = process.argv.slice(2);
try { fs.unlinkSync(sock); } catch {}
const server = http.createServer(); const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => ws.on("message", (data) => {
  const m = JSON.parse(data.toString()); if (m.id === undefined) return;
  const reply = (result) => ws.send(JSON.stringify({ id: m.id, result }));
  if (m.method === "initialize") return reply({ userAgent: `stub/${version} (test)`, codexHome: "/x", platformFamily: "unix", platformOs: "macos" });
  if (m.method === "thread/loaded/list") return reply({ data: [threadId] });
  // Like the live server: a full-history read of a long thread is larger than the client's frame
  // bound (live codex-main: 45,353,470 bytes); the stub answers it with a 46 MiB frame so a client
  // that asks for it fails the same way.
  if (m.method === "thread/read" && m.params.includeTurns) return ws.send(JSON.stringify({ id: m.id, result: { thread: { id: m.params.threadId, status: { type: state }, turns: [], pad: "x".repeat(46 * 1024 * 1024) } } }));
  if (m.method === "thread/read") return reply({ thread: { id: m.params.threadId, cwd: "/", status: state === "active" ? { type: "active", activeFlags: [] } : { type: state }, turns: [] } });
  if (m.method === "thread/turns/list") return reply({ data: state === "active" ? [{ id: "turn-running", status: "inProgress" }] : [{ id: "turn-old", status: "completed" }] });
  if (m.method === "turn/start" || m.method === "turn/steer") {
    fs.appendFileSync(log, JSON.stringify({ method: m.method, threadId: m.params.threadId, text: m.params.input?.[0]?.text, expectedTurnId: m.params.expectedTurnId ?? null }) + "\n");
    return reply(m.method === "turn/start" ? { turn: { id: "turn-new" } } : { turnId: m.params.expectedTurnId });
  }
  reply({});
}));
server.listen(sock, () => { fs.chmodSync(sock, 0o600); process.stdout.write("ready\n"); });
