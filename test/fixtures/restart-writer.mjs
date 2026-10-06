import fsp from "node:fs/promises";
import net from "node:net";
const { socketPath, keyPath, body } = JSON.parse(await fsp.readFile(process.argv[2], "utf8"));
const { peerToken } = JSON.parse(await fsp.readFile(keyPath, "utf8"));
const socket = net.createConnection(socketPath);
socket.on("error", () => socket.destroy());
socket.once("connect", () => socket.write(JSON.stringify({ type: "auth", token: peerToken }) + "\n" + JSON.stringify({ type: "message", message: { content: body } }) + "\n"));
const timer = setTimeout(() => { socket.destroy(); process.exit(2); }, 3000);
socket.once("close", () => { clearTimeout(timer); process.exit(0); });
