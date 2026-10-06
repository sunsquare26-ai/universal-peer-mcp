// Writes one authenticated frame onto a receiver's socket from a separate process, then records
// that its bytes have left. Separate, because the test it serves has to block its own event loop
// between the write and the close — which is the only way to hold a connection in the listen
// backlog on purpose, and the only way to assert what a shutdown does with one.
import fs from "node:fs";
import net from "node:net";

const socket = net.createConnection({ path: process.env.TEST_SOCKET_PATH });
socket.on("error", () => {});
socket.once("connect", () => {
  socket.write(process.env.TEST_FRAMES, () => { fs.writeFileSync(process.env.TEST_MARKER, "flushed"); });
});
// Held open: the shipped sender holds until the receiver closes, and a writer that exits here would
// let the connection end on its own, which is not the case under test.
setInterval(() => {}, 60_000);
