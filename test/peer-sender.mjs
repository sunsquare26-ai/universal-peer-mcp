#!/usr/bin/env bun
// A sender that is a separate process, so the receiver's identity read names a pid that is
// not the test runner's. Five shapes, and the difference between them is the whole point:
//
//   direct       the shipped sender, directSend, unchanged, from a process that stays alive
//   hold         write, keep the connection open, close later      — a live session
//   close        write, close in the write callback, exit          — the shape socat has
//   child        write, hand the open descriptor to a child which writes the rest, then hold
//   child-close  as child, and then close the connection while this process stays alive
//
// "child" is the one that shows what a per connection identity cache loses: the second batch
// is written by a different process on the same socket, and the kernel reports it as such.
// "child-close" is the other half of the same finding: the writer is gone and the process
// that opened the connection is not, so a read taken at accept still answers — with the wrong
// process. It writes --closed-file once the connection is really closed, which is how a test
// waits for that state instead of sleeping for it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { directSend } from "../src/adapters/claude-native-v1/transport.mjs";

const options = {};
for (let index = 0; index < process.argv.length - 1; index += 1) {
  if (process.argv[index].startsWith("--")) options[process.argv[index].slice(2)] = process.argv[index + 1];
}
const script = path.resolve(new URL(import.meta.url).pathname);
// --wait-file lets the caller finish setting up before anything is written, and the frames are
// read after it so they may depend on what that setup produced.
if (options["wait-file"]) await waitForFile(options["wait-file"]);
const batches = JSON.parse(await fsp.readFile(options.frames, "utf8"));
const holdMs = Number(options["hold-ms"] ?? 1200);
const wire = (frames) => `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
const report = async (value) => { await fsp.writeFile(options.report, `${JSON.stringify(value)}\n`); };

if (options.mode === "inherited-write") await inheritedWrite();
else if (options.mode === "direct") await direct();
else await handWritten();

async function waitForFile(file) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the file this sender waits for never appeared");
}

// the child half: the connected socket arrives as file descriptor 3. With a hold it stays
// alive after the write because the receiver has to be able to look the writer up; with
// --hold-ms 0 it exits at once, which is the case where the writer cannot be looked up.
async function inheritedWrite() {
  fs.writeSync(3, wire(batches.second));
  await report({ childPid: process.pid });
  setTimeout(() => process.exit(0), holdMs);
}

// the shipped path: no hand written socket and no hand written close. The process stays alive
// afterwards because a daemon does, which is the only thing this mode adds.
async function direct() {
  const target = { ...batches.target, socketPath: options.socket };
  const result = await directSend(target, [...batches.first, ...batches.second], { reverify: async () => target });
  await report({ bytesWritten: result.bytesWritten, senderPid: process.pid });
  setTimeout(() => process.exit(0), holdMs);
}

async function handWritten() {
  const socket = net.createConnection({ path: options.socket });
  socket.on("error", () => process.exit(3));
  socket.once("connect", async () => {
    if (options.mode === "close") {
      socket.write(wire([...batches.first, ...batches.second]), () => { socket.destroy(); process.exit(0); });
      return;
    }
    socket.write(wire(batches.first));
    if (options.mode === "child" || options.mode === "child-close") {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const child = spawn(process.execPath, [script, "--mode", "inherited-write", "--frames", options.frames, "--report", options.report, "--hold-ms", String(options["child-hold-ms"] ?? 400)], {
        stdio: ["ignore", "ignore", "inherit", socket._handle.fd]
      });
      await new Promise((resolve) => child.once("exit", resolve));
      if (options.mode === "child-close") {
        // the descriptor is closed on both sides here, and this process keeps running: the
        // writer of the last frames is gone, the process that opened the connection is not.
        socket.once("close", () => setTimeout(() => fs.writeFileSync(options["closed-file"], "closed\n"), 20));
        socket.destroy();
        setTimeout(() => process.exit(0), holdMs);
        return;
      }
    } else {
      socket.write(wire(batches.second));
    }
    setTimeout(() => { socket.destroy(); process.exit(0); }, holdMs);
  });
}
