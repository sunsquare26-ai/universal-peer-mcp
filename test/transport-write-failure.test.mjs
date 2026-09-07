// A write that failed was recorded as a write that succeeded.
//
// `socket.write(wire, () => written())` dropped the callback's first argument, which is the
// error. Node and Bun call that callback for a write that did not happen — measured on Bun 1.3.11
// against a real unix socket: writing to a destroyed stream calls back with
// `ERR_STREAM_DESTROYED`, writing after `end()` with `ERR_STREAM_WRITE_AFTER_END`, and writing to
// a socket whose peer has gone with `EPIPE` — and in all three `socket.bytesWritten` is 0 and the
// receiver got nothing. The old callback ignored the argument, called `written()`, and `settled`
// was then true, so the `error` event that followed was swallowed by `if (settled) return`. The
// ledger got `socket_write_complete`, `durableState` read it back as `"written"`, and the code
// review view read it back as `delivery: "written"`.
//
// It is not a rare shape. `receiver.mjs` destroys the connection on every refusal, on a handler
// rejection, and on daemon close for every socket that is still open.
//
// The bytes were the second half. The number on the ledger was `Buffer.byteLength(wire)` — the
// length we meant to write — and no code in `src/` had ever read `socket.bytesWritten`. It is
// read now, at the flush, and a callback that returns clean while the socket carried less than
// the wire is a failure rather than a write.
import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { directSend } from "../src/adapters/claude-native-v1/transport.mjs";
import { processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function listener(prefix, onConnection = () => {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), prefix)); cleanups.push(() => fsp.rm(made, { recursive: true, force: true }));
  const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const socketPath = path.join(root, "peer.sock");
  const read = [];
  const server = net.createServer((socket) => { socket.on("error", () => {}); socket.on("data", (chunk) => read.push(chunk.length)); onConnection(socket); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { socketPath, read };
}

const target = (socketPath) => ({ pid: process.pid, procStart: processStart(), socketPath, token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" } });
const frames = [{ type: "user", msgV: 1, message: { role: "user", content: "a body that must not be reported as sent when it was not" } }];

// The identity read runs between connect and write and is handed the socket, so it is where a
// test can put the socket into the state the receiver puts it in — destroyed — without reaching
// inside the sender.
test("a write that fails with an error is not reported as a write", async () => {
  const peer = await listener("peer-write-error-");
  const bounded = [];
  await expect(directSend(target(peer.socketPath), frames, {
    reverify: async () => target(peer.socketPath),
    peerPidReader: (socket) => { socket.destroy(); return process.pid; },
    onHoldBound: (detail) => bounded.push(detail)
  })).rejects.toThrow();
  await Bun.sleep(80);
  expect(peer.read).toEqual([]);
  expect(bounded).toEqual([]);
});

// The same failure with the argument the runtime is not obliged to pass. Bun 1.3.11 always
// passes one, so the branch is produced here at the socket boundary: the callback returns clean
// and nothing left the machine. A guard that trusted the argument alone would call this a write.
test("a write that fails without an error argument is not reported as a write either", async () => {
  const peer = await listener("peer-write-silent-");
  await expect(directSend(target(peer.socketPath), frames, {
    reverify: async () => target(peer.socketPath),
    peerPidReader: (socket) => {
      socket.write = (_chunk, callback) => { socket.destroy(); (typeof _chunk === "function" ? _chunk : callback)(); return false; };
      return process.pid;
    }
  })).rejects.toThrow();
  await Bun.sleep(80);
  expect(peer.read).toEqual([]);
});

test("a write that succeeds reports the bytes the socket carried, not the bytes we meant to write", async () => {
  const peer = await listener("peer-write-ok-", (socket) => { socket.on("data", () => socket.destroy()); });
  const result = await directSend(target(peer.socketPath), frames, { reverify: async () => target(peer.socketPath), holdBoundMs: 5_000 });
  await Bun.sleep(80);
  expect(peer.read).toEqual([result.bytesWritten]);
  expect(result.bytesWritten).toBe(result.bytesIntended);
});

// The hold bound carries the same measured number, because it is the same write.
test("the hold bound reports the measured bytes", async () => {
  const peer = await listener("peer-write-hold-");
  const bounded = [];
  const result = await directSend(target(peer.socketPath), frames, { reverify: async () => target(peer.socketPath), holdBoundMs: 120, onHoldBound: (detail) => bounded.push(detail) });
  await Bun.sleep(400);
  expect(bounded).toHaveLength(1);
  expect(bounded[0].bytesWritten).toBe(result.bytesWritten);
  expect(peer.read).toEqual([result.bytesWritten]);
});
