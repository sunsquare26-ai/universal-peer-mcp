#!/usr/bin/env bun
const command = process.argv[2] ?? "serve";
if (command === "serve") {
  const args = process.argv.slice(3); const enabled = [];
  for (let index = 0; index < args.length; index += 1) { if (args[index] !== "--enable" || !["milestone", "code-review"].includes(args[index + 1])) { process.stderr.write("usage: universal-peer-mcp serve [--enable milestone] [--enable code-review]\n"); process.exit(2); } enabled.push(args[index + 1]); index += 1; }
  if (enabled.length) process.env.CLAUDE_PEER_MCP_EXTENSIONS = [...new Set(enabled)].sort().join(",");
  await import("./server.mjs");
}
else if (["trace", "stats", "doorbell", "body-dispose", "post", "inbox", "inbox-ack", "link", "register", "unregister", "peers", "whoami"].includes(command)) {
  const { observeCommand } = await import("./observe-cli.mjs");
  try { process.stdout.write(`${JSON.stringify(await observeCommand(command, process.argv.slice(3)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "FAILED", message: String(error?.message ?? error).slice(0, 500) })}\n`); process.exitCode = 1; }
}
else if (command === "doctor") { const { doctor } = await import("./doctor.mjs"); process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`); }
else { process.stderr.write("usage: universal-peer-mcp [serve [--enable milestone] [--enable code-review]|doctor|trace <id> [--ledger f]|stats [--days n] [--ledger f]|doorbell --thread <uuid> --message-id <uuid> [--alias a]|body-dispose --seq <n> --disposition processed|discard|register --alias <name> [--replace]|unregister --alias <name>|peers|whoami|post --to a[,b] --body-file f|inbox|inbox-ack --message-id <id>]\n"); process.exitCode = 2; }
