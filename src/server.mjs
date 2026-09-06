import { controlCall, ensureDaemon } from "./core/control.mjs";
import { statePaths } from "./core/state-paths.mjs";
import { createFacade } from "./mcp/facade.mjs";
import { toolDefinitions } from "./mcp/tools.mjs";
import { loadTargets } from "./core/target-config.mjs";

const paths = statePaths(); let targets = {}; try { targets = await loadTargets(paths.targets); } catch (error) { if (error.code !== "ENOENT") throw error; }
await ensureDaemon();
const daemon = await controlCall("daemon_status");
const admin = daemon.admin === true;
const enabledExtensions = Array.isArray(daemon.enabledExtensions) ? daemon.enabledExtensions : [];
const requestedExtensions = parseExtensions(process.env.CLAUDE_PEER_MCP_EXTENSIONS);
const tools = toolDefinitions(Object.keys(targets), { admin, extensions: enabledExtensions, requestedExtensions });
const facade = createFacade({ tools, callTool: async (name, args) => {
  const result = await controlCall(name, args);
  const extensionMismatch = JSON.stringify(requestedExtensions) !== JSON.stringify(enabledExtensions);
  if (name !== "daemon_status" || (!extensionMismatch && requestedExtensions.length === 0)) return result;
  return { ...result, requestedExtensions, extensionMismatch };
} });
export const MAX_STDIN_FRAME_BYTES = 1024 * 1024;
let buffer = Buffer.alloc(0); let discardingFrame = false;
process.stdin.on("data", (chunk) => {
  let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (discardingFrame) {
    const newline = incoming.indexOf(0x0a);
    if (newline < 0) return;
    discardingFrame = false; incoming = incoming.subarray(newline + 1);
  }
  buffer = Buffer.concat([buffer, incoming]);
  while (true) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    const frame = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
    if (frame.byteLength > MAX_STDIN_FRAME_BYTES) { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "frame too large" } }); continue; }
    const line = frame.toString("utf8"); if (!line.trim()) continue; void handle(line);
  }
  if (buffer.byteLength > MAX_STDIN_FRAME_BYTES) {
    buffer = Buffer.alloc(0); discardingFrame = true;
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "frame too large" } });
  }
});
async function handle(line) { let request; try { request = JSON.parse(line); } catch { return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); } const response = await facade.handle(request); if (response !== null) write(response); }
function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function parseExtensions(value) { if (!value) return []; const names = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort(); return names.filter((name) => ["code-review", "milestone"].includes(name)); }
