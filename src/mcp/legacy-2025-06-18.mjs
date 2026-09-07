import { SERVER_INFO } from "./modern-2026-07-28.mjs";
import { publicToolError, publicToolFailure, redactPublic } from "./redact.mjs";
import { projectSchema, validateSchema } from "./schema-validator.mjs";
import { publicResultSchema } from "./tools.mjs";

export const LEGACY_VERSION = "2025-06-18";

export function initializeLegacy(request) {
  return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: LEGACY_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
}

export async function handleLegacy(request, { tools, callTool }) {
  if (request.method === "notifications/initialized") return null;
  if (request.id === undefined) return null;
  if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools } };
  if (request.method !== "tools/call") return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } };
  const name = request.params?.name; const args = request.params?.arguments ?? {};
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool || !plain(args) || !validateSchema(tool.inputSchema, args).valid) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid tools/call parameters" } };
  try {
    const value = publicResult(tool, await callTool(name, args));
    return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } };
  } catch (cause) { const structuredContent = publicToolFailure(cause); return { jsonrpc: "2.0", id: request.id, result: { isError: true, structuredContent, content: [{ type: "text", text: publicToolError(structuredContent.reason) }] } }; }
}
function publicResult(tool, raw) {
  const successSchema = publicResultSchema(tool);
  if (!successSchema) throw codedError("INVALID_PUBLIC_RESULT", "tool has no public result contract");
  const value = redactPublic(projectSchema(successSchema, raw));
  const checked = validateSchema(successSchema, value);
  if (!checked.valid) throw codedError("INVALID_PUBLIC_RESULT", "daemon returned an invalid public result");
  return value;
}
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
