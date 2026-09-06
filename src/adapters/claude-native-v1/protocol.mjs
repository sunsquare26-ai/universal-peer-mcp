import crypto from "node:crypto";
import { requireUuid } from "../../core/limits.mjs";

export function senderEnvelope({ from, body, permissionMode }) {
  if (!/^uds:\/[^\0\r\n]+\.sock$/.test(from)) throw new Error("invalid sender address");
  if (!["prompting", "bypass"].includes(permissionMode)) throw new Error("invalid sender permission mode");
  return `<cross-session-message from="${escapeXml(from)}" from-name="Claude MCP" from-mode="${permissionMode}">\n${body}\n</cross-session-message>`;
}

export function outboundFrames({ token, targetSessionId, senderAddress, permissionMode, messageId, subscriptionId, content }) {
  [targetSessionId, messageId, subscriptionId].forEach((value) => requireUuid(value, "transport id"));
  if (typeof token !== "string" || token.length < 16) throw new Error("invalid target token");
  return [
    { type: "auth", token },
    { type: "user", msgV: 1, msg_id: messageId, uuid: crypto.randomUUID(), session_id: targetSessionId, priority: "next", from: senderAddress, message: { role: "user", content } },
    { type: "control", action: "notify_when_idle", msgV: 1, msg_id: subscriptionId, session_id: targetSessionId, from: senderAddress, from_mode: permissionMode }
  ];
}

export function encodeFrames(frames) {
  const wire = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
  if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error("outbound frame exceeds 1 MiB");
  return wire;
}

export function parseMarker(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) return null;
  const first = content.split(/\r?\n/, 1)[0].trim();
  const match = /^PEER_(ACK|REPLY) v=1 message_id=([0-9a-f-]{36}) thread_id=([0-9a-f-]{36}) reply_to=([0-9a-f-]{36})(?: verdict=(pass|fail))?$/i.exec(first);
  if (!match) return null;
  try {
    const result = { type: match[1].toLowerCase(), messageId: requireUuid(match[2], "messageId"), threadId: requireUuid(match[3], "threadId"), replyTo: requireUuid(match[4], "replyTo"), verdict: match[5]?.toLowerCase() ?? null };
    if (result.type === "ack" && result.verdict !== null) return null;
    if (result.type === "reply" && !["pass", "fail"].includes(result.verdict)) return null;
    return result;
  } catch { return null; }
}

function escapeXml(value) { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
