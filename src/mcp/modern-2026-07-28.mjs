import { publicToolError, publicToolFailure, redactPublic } from "./redact.mjs";
import { projectSchema, validateSchema } from "./schema-validator.mjs";
import { publicResultSchema } from "./tools.mjs";

export const MODERN_VERSION = "2026-07-28";
export const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
export const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
export const SERVER_INFO = Object.freeze({ name: "universal-peer-mcp", version: "0.1.0" });

export async function handleModern(request, { tools, callTool }) {
  if (request.id === undefined) return null;
  const meta = request?.params?._meta;
  if (!plain(meta) || meta[PROTOCOL_KEY] !== MODERN_VERSION || !plain(meta[CLIENT_CAPS_KEY])) {
    const requested = plain(meta) ? meta[PROTOCOL_KEY] : null;
    if (typeof requested === "string" && requested !== MODERN_VERSION) return error(request.id, -32022, "UnsupportedProtocolVersion", { requested, supported: [MODERN_VERSION] });
    return error(request.id, -32602, "modern requests require protocolVersion and clientCapabilities metadata");
  }
  if (request.method === "server/discover") return result(request.id, { resultType: "complete", supportedVersions: [MODERN_VERSION], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private" });
  if (request.method === "tools/list") return result(request.id, { resultType: "complete", tools, ttlMs: 0, cacheScope: "private" });
  if (request.method !== "tools/call") return error(request.id, -32601, "method not found");
  const tool = tools.find((candidate) => candidate.name === request.params?.name);
  const args = request.params?.arguments ?? {};
  if (!tool || !plain(args) || !validateSchema(tool.inputSchema, args).valid) return error(request.id, -32602, "invalid tools/call parameters");
  try {
    const value = publicResult(tool, await callTool(request.params.name, request.params.arguments ?? {}));
    return result(request.id, { resultType: "complete", structuredContent: value, content: [{ type: "text", text: summary(request.params.name, value) }] });
  } catch (cause) { const structuredContent = publicToolFailure(cause); return result(request.id, { resultType: "complete", isError: true, structuredContent, content: [{ type: "text", text: publicToolError(structuredContent.reason) }] }); }
}

function publicResult(tool, raw) {
  const successSchema = publicResultSchema(tool);
  if (!successSchema) throw codedError("INVALID_PUBLIC_RESULT", "tool has no public result contract");
  const value = redactPublic(projectSchema(successSchema, raw));
  const checked = validateSchema(successSchema, value);
  if (!checked.valid) throw codedError("INVALID_PUBLIC_RESULT", "daemon returned an invalid public result");
  return value;
}

function result(id, value) { return { jsonrpc: "2.0", id, result: { ...value, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } }; }
function error(id, code, message, data) { return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function summary(name, value) { if (name === "peer_send") return value.replay ? "앞서 기록한 전송 결과입니다." : "메시지를 한 번 전송했습니다."; if (name === "peer_wait") return value.timedOut ? "기다리는 동안 새 상태가 없었습니다." : "요청한 상태를 받았습니다."; return `${name} 결과`; }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
