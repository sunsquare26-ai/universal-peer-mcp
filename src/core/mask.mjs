import { redactPublic } from "../mcp/redact.mjs";

// What a diagnostic row may keep of a body: its first line, masked, and short. The body itself
// stays in the private spool for as long as the retention allows (src/core/retention.mjs); this
// line is what is left to recognise the message by after that, so it is written as if it will be
// read by someone who must not learn anything personal from it.
//
// The masks are pattern-based and therefore a floor, not a proof. They cover what has actually
// appeared in peer bodies here (a resident registration number, e-mail addresses, a token-shaped
// assignment; measured 2026-09-29 by pattern count only) plus phone and long account-like numbers,
// and then the package's own public redaction (paths, sockets, credentials).
export const FIRST_LINE_MAX_CHARS = 120;

const RRN = /(?<!\d)\d{6}\s*-?\s*[1-8][\d*]{6}(?![\d*])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<!\d)(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g;
// Ten or more digits in one run (dashes allowed): account and card numbers. A date has eight and
// is left alone.
const LONG_NUMBER = /(?<![\dA-Fa-f-])\d[\d-]{8,}\d(?![\dA-Fa-f-])/g;
const longNumber = (run) => (run.replace(/-/g, "").length >= 10 ? "[number]" : run);

export function maskText(text) {
  if (typeof text !== "string") return "";
  const masked = text.replace(RRN, "[rrn]").replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(LONG_NUMBER, longNumber);
  return redactPublic(masked);
}

// One line, masked, at most FIRST_LINE_MAX_CHARS code points. Returns null for a body with no
// text, so a row never carries an empty string that reads like a line that was there.
export function maskFirstLine(body) {
  if (typeof body !== "string" || body.length === 0) return null;
  const first = body.split(/\r?\n/, 1)[0].trim();
  if (first.length === 0) return null;
  const masked = [...maskText(first)];
  return masked.length > FIRST_LINE_MAX_CHARS ? `${masked.slice(0, FIRST_LINE_MAX_CHARS).join("")}…` : masked.join("");
}
