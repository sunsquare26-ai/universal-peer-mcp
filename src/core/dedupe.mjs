import crypto from "node:crypto";
import { MAX_BODY_BYTES, requireUuid } from "./limits.mjs";

export function canonicalSend({ alias, messageId, threadId, replyTo = null, kind, body }) {
  if (typeof alias !== "string") throw new Error("alias is required");
  requireUuid(messageId, "messageId"); requireUuid(threadId, "threadId");
  if (replyTo !== null) requireUuid(replyTo, "replyTo");
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(kind)) throw new Error("invalid kind");
  if (typeof body !== "string" || body.length === 0 || Buffer.byteLength(body) > MAX_BODY_BYTES || body.includes("\0")) throw new Error("invalid body");
  return JSON.stringify({ alias, messageId: messageId.toLowerCase(), threadId: threadId.toLowerCase(), replyTo: replyTo?.toLowerCase() ?? null, kind, body });
}

export function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
