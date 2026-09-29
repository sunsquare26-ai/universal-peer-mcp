import { referenceHex } from "./limits.mjs";

// What the ledger may keep of an inbound body besides its length and digest: the protocol header
// of its first line, reduced to allowlisted fields with closed-shape values. No free text.
//
// This replaced a masked first line (M1 draft). Pattern masking cannot be complete — a name, a
// six-digit one-time code or an address passes any set of patterns — and the ledger, its daily
// copies and the off-machine backup are kept long. So the rule is the other way round: nothing is
// kept unless it is a known protocol word or an id, and everything else on the line is dropped.
//
//   verb      PEER_ACK | PEER_REPLY | PEER_REQUEST | PEER_POST | PEER_DOORBELL
//   v         "1"
//   messageId a full uuid
//   threadId  a full uuid or a hex reference (8..32 hex)
//   replyTo   a full uuid or a hex reference
//   verdict   pass | fail
//
// A body whose first line is not such a header yields null: the row says only that a body of N
// bytes with digest D arrived.
export const HEADER_VERBS = Object.freeze(["PEER_ACK", "PEER_REPLY", "PEER_REQUEST", "PEER_POST", "PEER_DOORBELL"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = { message_id: "messageId", messageid: "messageId", mid: "messageId", thread_id: "threadId", threadid: "threadId", thread: "threadId", reply_to: "replyTo", replyto: "replyTo", re: "replyTo", v: "v", verdict: "verdict" };

function idValue(field, value) {
  if (UUID.test(value)) return value.toLowerCase();
  if (field === "messageId") return null;
  return referenceHex(value);
}

export function protocolHeader(body) {
  if (typeof body !== "string" || body.length === 0) return null;
  const line = body.split(/\r?\n/, 1)[0].slice(0, 1024).trim();
  const tokens = line.split(/[ \t|]+/).filter(Boolean);
  const verb = tokens[0];
  if (!HEADER_VERBS.includes(verb)) return null;
  const header = { verb };
  for (const token of tokens.slice(1)) {
    const at = token.indexOf("=");
    if (at <= 0) continue;
    const field = KEYS[token.slice(0, at).toLowerCase().replaceAll("-", "_")];
    if (!field || field in header) continue;
    const value = token.slice(at + 1);
    if (field === "v") { if (value === "1") header.v = "1"; continue; }
    if (field === "verdict") { const lowered = value.toLowerCase(); if (lowered === "pass" || lowered === "fail") header.verdict = lowered; continue; }
    const id = idValue(field, value);
    if (id !== null) header[field] = id;
  }
  return header;
}
