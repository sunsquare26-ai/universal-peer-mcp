import { CLIENT_CAPS_KEY, handleModern, PROTOCOL_KEY } from "./modern-2026-07-28.mjs";
import { handleLegacy, initializeLegacy } from "./legacy-2025-06-18.mjs";

export function createFacade(options) {
  let era = null;
  return {
    async handle(request) {
      if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return request?.id === undefined ? null : { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "invalid request" } };
      const modernSignal = Object.prototype.hasOwnProperty.call(request?.params?._meta ?? {}, PROTOCOL_KEY);
      if (era === null) {
        if (modernSignal) era = "modern";
        else if (request.method === "initialize") era = "legacy";
        else return request.id === undefined ? null : { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "request did not select a supported MCP era" } };
      }
      if (era === "modern") {
        if (!modernSignal) return request.id === undefined ? null : { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "modern connection requires metadata on every request" } };
        return handleModern(request, options);
      }
      if (modernSignal || request.method === "server/discover") return request.id === undefined ? null : { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "MCP eras cannot be mixed" } };
      if (request.method === "initialize") return initializeLegacy(request);
      return handleLegacy(request, options);
    }
  };
}

export function modernMeta() { return { [PROTOCOL_KEY]: "2026-07-28", [CLIENT_CAPS_KEY]: {} }; }
