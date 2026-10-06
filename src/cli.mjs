#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
// The directory holding a `universal-peer-mcp` this process was started through, if any — handed to
// an opened session on PATH. A checkout run as `bun src/cli.mjs` has none, and nothing is added.
function commandDir() {
  for (const candidate of [process.env.UNIVERSAL_PEER_BIN_DIR, process.argv[1] && path.dirname(process.argv[1])]) {
    if (typeof candidate === "string" && path.isAbsolute(candidate) && fs.existsSync(path.join(candidate, "universal-peer-mcp"))) return candidate;
  }
  return null;
}
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
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "FAILED", message: String(error?.message ?? error).slice(0, 500), ...(typeof error?.reason === "string" ? { reason: error.reason } : {}) })}\n`); process.exitCode = 1; }
}
else if (command === "setup") {
  // M5: the one step after installing (src/setup.mjs). Prints the plan; --yes applies it.
  const { applySetup, planSetup, renderSetup } = await import("./setup.mjs");
  const args = process.argv.slice(3);
  try {
    // Strict: every option known, every value present and not another flag; the plan names the exact
    // command that applies it, options included.
    const options = {}; let yes = false; const echo = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--yes") { yes = true; continue; }
      if (args[i] !== "--state" && args[i] !== "--bin-dir") throw Object.assign(new Error(`unknown setup option ${args[i]}; usage: setup [--state <dir>] [--bin-dir <dir>] [--yes]`), { code: "INVALID_ARGUMENTS" });
      const value = args[i + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) throw Object.assign(new Error(`${args[i]} needs a directory`), { code: "INVALID_ARGUMENTS" });
      options[args[i] === "--state" ? "state" : "binDir"] = path.resolve(value); echo.push(args[i], path.resolve(value)); i += 1;
    }
    const plan = planSetup(options);
    process.stdout.write(renderSetup(plan, yes ? { applied: applySetup(plan), argv: echo } : { argv: echo }));
  } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "FAILED", message: String(error?.message ?? error).slice(0, 500) })}\n`); process.exitCode = 1; }
}
else if (command === "status") {
  // M5 F3: who is there and what waits on whom (src/core/overview.mjs). --json for the raw view.
  const { controlCall } = await import("./core/control.mjs"); const { renderOverview } = await import("./core/overview.mjs");
  try { const view = await controlCall("peer_overview", {}); process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(view, null, 2)}\n` : renderOverview(view)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "FAILED", message: String(error?.message ?? error).slice(0, 500) })}\n`); process.exitCode = 1; }
}
else if (command === "open") {
  // M5: reopen a registered peer's session in this terminal (src/core/open.mjs).
  const { planOpen, runOpen } = await import("./core/open.mjs");
  const args = process.argv.slice(3); const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  try {
    const plan = await planOpen(args[0], { binDir: commandDir(), claude: option("--claude"), codex: option("--codex"), cwd: option("--cwd"), permissionFlag: option("--permission-mode") });
    if (args.includes("--print")) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else { process.stderr.write(`universal-peer: opening ${plan.alias} (${plan.kind}) in ${plan.cwd}\n`); process.exitCode = await runOpen(plan); }
  } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "FAILED", message: String(error?.message ?? error).slice(0, 500) })}\n`); process.exitCode = 1; }
}
else if (command === "doctor") { const { doctor } = await import("./doctor.mjs"); process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`); }
else { process.stderr.write("usage: universal-peer-mcp [serve [--enable milestone] [--enable code-review]|setup [--state dir] [--bin-dir dir] [--yes]|status [--json]|open <alias> [--print]|doctor|trace <id> [--ledger f]|stats [--days n] [--ledger f]|doorbell --thread <uuid> --message-id <uuid> [--alias a]|body-dispose --seq <n> --disposition processed|discard|register --alias <name> [--replace]|unregister --alias <name>|peers|whoami|post --to a[,b] --body-file f|inbox|inbox-ack --message-id <id>]\n"); process.exitCode = 2; }
