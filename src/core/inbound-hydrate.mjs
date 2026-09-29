import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_INBOUND_BODY_BYTES, utf8Bound } from "./inbound-spool.mjs";
import { INBOUND_DIRNAME } from "./state-paths.mjs";

// The spool keeps every inbound body and the ledger row names the file that holds it
// (src/core/inbound-spool.mjs). That closed the loss and left a gap: a file name is only reachable
// by a reader that opens files, and the reader on the other end of these tools is a session that
// reads the answer. So the daemon was asked to push, which it cannot do — it has no channel to wake
// anybody — and the conclusion drawn from that was that one line of consumer code was owed by the
// receiving side.
//
// The tool answer is the channel. `peer_wait`, `peer_list_events` and a `peer_send` replay all
// carry the rows already; carrying the text beside the name costs the receiver nothing and needs no
// code on its side. This module reads the spooled file back at that boundary and returns copies of
// the rows with the text attached.
//
// Three things it deliberately does not do:
//
//  - It does not write. The ledger keeps a name, a length and a digest and no body, exactly as
//    before, and the spool files are opened read-only. The rows it returns are copies made for one
//    response; the in-memory ledger `EventStore` holds is not mutated, because a hydrated row would
//    then be served from the store for the rest of the process's life.
//  - It does not replace `bodyFile`. That name and `bodySha256` are the durable record of the whole
//    body and stay on every row, including the rows it has to leave empty.
//  - It does not cut silently. A row whose text was cut says `bodyInlineTruncated: true`; a row
//    that has a file and no text says why in `bodyInlineOmitted`.
//
// The bounds. A body is inlined up to `INLINE_BODY_MAX_BYTES`, and one response carries at most
// `INLINE_TOTAL_MAX_BYTES` of body text across all of its rows. The third number is not a policy
// but a guard: `controlCall` refuses a control response over 1 MiB
// (src/core/control.mjs), and `peer_list_events` with no cursor answers with the whole ledger —
// measured 941,796 bytes on 2026-09-11, which is already within 107 KiB of that refusal. Inlining a
// fixed 64 KiB on top of it would spend most of the remaining margin and bring the refusal forward.
// So the budget is what is left under `INLINE_RESPONSE_CEILING_BYTES` after the rows themselves,
// and a response that is already large inlines less, or nothing, and says so per row instead of
// failing as a whole.
export const INLINE_BODY_MAX_BYTES = 8 * 1024;
export const INLINE_TOTAL_MAX_BYTES = 64 * 1024;
export const INLINE_RESPONSE_CEILING_BYTES = 896 * 1024;

// `inbound/<name>.txt` and nothing else. The value comes off a row this daemon wrote, but the
// ledger is a file on disk and this is the one place a recorded string is turned into a path, so it
// is read as a name rather than trusted as one: no separator, no leading dot, so no segment of it
// can be `..` and nothing outside the spool directory is reachable through it.
const SPOOL_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}\.txt$/;
function spoolName(event) {
  const value = event?.bodyFile;
  if (typeof value !== "string") return null;
  const prefix = `${INBOUND_DIRNAME}/`;
  if (!value.startsWith(prefix)) return null;
  const name = value.slice(prefix.length);
  return SPOOL_NAME.test(name) ? name : null;
}

export async function hydrateInboundBodies(events, {
  root,
  perBody = INLINE_BODY_MAX_BYTES,
  total = INLINE_TOTAL_MAX_BYTES,
  ceiling = INLINE_RESPONSE_CEILING_BYTES
} = {}) {
  if (!Array.isArray(events) || events.length === 0 || typeof root !== "string" || root === "") return events;
  const carriers = [];
  for (let index = 0; index < events.length; index += 1) if (spoolName(events[index]) !== null) carriers.push(index);
  if (carriers.length === 0) return events;
  let budget = Math.max(0, Math.min(total, ceiling - Buffer.byteLength(JSON.stringify(events))));
  const hydrated = events.slice();
  // Newest row first. A budget spent on the oldest rows of a long listing is a budget that never
  // reaches the answer the caller is actually waiting for, and the rows that are left without text
  // still carry their file name.
  for (let at = carriers.length - 1; at >= 0; at -= 1) {
    const index = carriers[at];
    const row = await inlineOne(events[index], root, Math.min(perBody, budget));
    hydrated[index] = row;
    if (typeof row.bodyInlineBytes === "number") budget -= row.bodyInlineBytes;
  }
  return hydrated;
}

async function inlineOne(event, root, cap) {
  if (!(cap > 0)) return { ...event, bodyInlineOmitted: "response_budget" };
  const file = path.join(root, INBOUND_DIRNAME, spoolName(event));
  let bytes;
  try {
    // The checks the rest of this package makes of a state file, made on the descriptor the bytes
    // are read from rather than on the name: a regular file this user owns, nothing group- or
    // world-accessible, no bigger than the spool can write, and O_NOFOLLOW so a name swapped for a
    // symbolic link between the check and the read cannot be followed.
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > MAX_INBOUND_BODY_BYTES) throw new Error("spooled body is not an owned private regular file");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  } catch { return { ...event, bodyInlineOmitted: "unreadable" }; }
  const end = utf8Bound(bytes, cap);
  const kept = end === bytes.byteLength ? bytes : bytes.subarray(0, end);
  let body;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(kept); }
  catch { return { ...event, bodyInlineOmitted: "unreadable" }; }
  if (body.length === 0) return { ...event, bodyInlineOmitted: "response_budget" };
  return {
    ...event,
    body,
    bodyInlineBytes: kept.byteLength,
    ...(kept.byteLength === bytes.byteLength ? {} : { bodyInlineTruncated: true })
  };
}
