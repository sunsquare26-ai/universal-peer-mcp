#!/usr/bin/env bun
import os from "node:os";
import { statePaths } from "./core/state-paths.mjs";

const command = process.argv[2] ?? "serve";
if (command === "serve") {
  const args = process.argv.slice(3); const enabled = [];
  for (let index = 0; index < args.length; index += 1) { if (args[index] !== "--enable" || !["milestone", "code-review"].includes(args[index + 1])) { process.stderr.write("usage: claude-peer-mcp serve [--enable milestone] [--enable code-review]\n"); process.exit(2); } enabled.push(args[index + 1]); index += 1; }
  if (enabled.length) process.env.CLAUDE_PEER_MCP_EXTENSIONS = [...new Set(enabled)].sort().join(",");
  await import("./server.mjs");
}
else if (command === "doctor") {
  const paths = statePaths();
  process.stdout.write(`${JSON.stringify({ ok: process.platform === "darwin", platform: process.platform, arch: process.arch, runtime: `Bun ${Bun.version}`, stateDirectory: paths.root.replace(os.homedir(), "~"), note: "doctor does not print tokens or process arguments" }, null, 2)}\n`);
} else { process.stderr.write("usage: claude-peer-mcp [serve [--enable milestone] [--enable code-review]|doctor]\n"); process.exitCode = 2; }
