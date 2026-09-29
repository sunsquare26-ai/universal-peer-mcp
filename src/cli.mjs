#!/usr/bin/env bun
const command = process.argv[2] ?? "serve";
if (command === "serve") {
  const args = process.argv.slice(3); const enabled = [];
  for (let index = 0; index < args.length; index += 1) { if (args[index] !== "--enable" || !["milestone", "code-review"].includes(args[index + 1])) { process.stderr.write("usage: universal-peer-mcp serve [--enable milestone] [--enable code-review]\n"); process.exit(2); } enabled.push(args[index + 1]); index += 1; }
  if (enabled.length) process.env.CLAUDE_PEER_MCP_EXTENSIONS = [...new Set(enabled)].sort().join(",");
  await import("./server.mjs");
}
else if (["trace", "stats", "doorbell"].includes(command)) { const { observeCommand } = await import("./observe-cli.mjs"); process.stdout.write(`${JSON.stringify(await observeCommand(command, process.argv.slice(3)), null, 2)}\n`); }
else if (command === "doctor") { const { doctor } = await import("./doctor.mjs"); process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`); }
else { process.stderr.write("usage: universal-peer-mcp [serve [--enable milestone] [--enable code-review]|doctor|trace <id> [--ledger f]|stats [--days n] [--ledger f]|doorbell --thread <uuid> --message-id <uuid> [--alias a]]\n"); process.exitCode = 2; }
