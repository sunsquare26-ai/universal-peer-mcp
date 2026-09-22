#!/usr/bin/env bun
const command = process.argv[2] ?? "serve";
if (command === "serve") {
  const args = process.argv.slice(3); const enabled = [];
  for (let index = 0; index < args.length; index += 1) { if (args[index] !== "--enable" || !["milestone", "code-review", "codex-wake", "codex-wake-bridge"].includes(args[index + 1])) { process.stderr.write("usage: universal-peer-mcp serve [--enable milestone] [--enable code-review] [--enable codex-wake] [--enable codex-wake-bridge]\n"); process.exit(2); } enabled.push(args[index + 1]); index += 1; }
  if (enabled.length) process.env.CLAUDE_PEER_MCP_EXTENSIONS = [...new Set(enabled)].sort().join(",");
  await import("./server.mjs");
}
else if (command === "wake" || command === "wake-status") {
  const { CodexWake } = await import("./extensions/codex-wake/index.mjs");
  const { statePaths } = await import("./core/state-paths.mjs");
  const { publicToolFailure } = await import("./mcp/redact.mjs");
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error("input too large"); }
    const args = JSON.parse(input);
    const wake = new CodexWake({ root: statePaths().root });
    const result = command === "wake" ? await wake.wake(args) : await wake.status(args);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify(publicToolFailure(error)) + "\n"); process.exitCode = 1; }
}
else if (command === "doctor") { const { doctor } = await import("./doctor.mjs"); process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`); }
else { process.stderr.write("usage: universal-peer-mcp [serve [--enable milestone] [--enable code-review] [--enable codex-wake] [--enable codex-wake-bridge]|doctor]\n"); process.exitCode = 2; }
