// Executed with Node: Bun's ws/http shims do not implement the UDS upgrade.
// This helper only bridges transport. It never starts a Codex server or model.
import WebSocket from 'ws';
import net from 'node:net';
const socketPath = process.argv[2];
const ws = new WebSocket('ws://localhost/', {
  createConnection: () => net.createConnection(socketPath),
  handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024,
  perMessageDeflate: false, followRedirects: false
});
let buffer = ''; const queue = [];
ws.on('open', () => { for (const line of queue.splice(0)) ws.send(line); });
ws.on('message', data => { process.stdout.write(data.toString() + '\n'); });
ws.on('error', () => process.exit(1));
ws.on('close', () => process.exit(0));
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) process.exit(1);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (ws.readyState === WebSocket.OPEN) ws.send(line);
    else { queue.push(line); if (queue.length > 128) process.exit(1); }
  }
});
process.stdin.on('end', () => { ws.terminate(); process.exit(0); });
