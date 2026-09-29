import crypto from "node:crypto";
import path from "node:path";
import { atomicPrivateWrite, ensurePrivateDirectory, INBOUND_DIRNAME } from "./state-paths.mjs";

// A frame's body is the one thing that arrived and that nothing on this side kept. The ledger is
// the wrong place for it and says so — the published event contract has no field for a body
// (docs/correlated-reply-hook.md) — and the hook that was the right place is not installed by the
// shipped daemon, which that same page states plainly: "What the shipped daemon does with it:
// Nothing." So every inbound body was read once, in memory, and dropped. In `acceptFrame` the
// uncorrelated branch returned a reason and nothing else, and the correlated branch handed the
// text to a hook that was null. A consumer on this side had no way to read what a peer wrote,
// which is the gap the peer reported in its own words as "body hook이 없으므로 파일이 필수입니다".
//
// So the body is written beside the ledger as its own private file and the ledger row names the
// file. That keeps the contract the ledger declares — a file name and a hash are not a body — and
// it keeps the text whether or not the frame could be correlated, which is the order that
// matters: losing the data is worse than losing the correlation.
//
// The name recorded in the row is relative to the state directory and never absolute. The public
// projection rewrites every absolute path to "[path]" (src/mcp/redact.mjs), and a field that is
// always redacted is a field that was never published.
export const MAX_INBOUND_BODY_BYTES = 1024 * 1024;

export class InboundSpool {
  constructor(paths) { this.directory = paths.inbound; this.ready = null; }

  async #ensure() {
    if (!this.ready) this.ready = ensurePrivateDirectory(this.directory);
    await this.ready;
  }

  // Truncation is on a byte bound, is reported, and is never silent. The cut is taken back to a
  // UTF-8 start byte rather than through a character, because a file that cannot be decoded is
  // not a preserved body; and the hash is taken over the bytes that were actually written, after
  // the cut, so what the row promises is what the file holds.
  async write(body) {
    if (typeof body !== "string" || body.length === 0) return {};
    const full = Buffer.from(body, "utf8");
    const end = utf8Bound(full, MAX_INBOUND_BODY_BYTES);
    const bytes = end === full.byteLength ? full : full.subarray(0, end);
    await this.#ensure();
    const name = `${new Date().toISOString().replace(/[:.]/g, "")}-${crypto.randomBytes(8).toString("hex")}.txt`;
    await atomicPrivateWrite(path.join(this.directory, name), bytes);
    return {
      bodyFile: `${INBOUND_DIRNAME}/${name}`,
      bodyBytes: bytes.byteLength,
      bodySha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      ...(bytes.byteLength === full.byteLength ? {} : { bodyTruncated: true })
    };
  }
}

// The largest length not greater than `max` that ends on a character boundary. Continuation bytes
// are 0b10xxxxxx, so walking back off them lands on the start byte of the character the bound cut
// through, and that character is left out rather than written half.
//
// Exported because the read side takes the same kind of cut for the same reason, at a smaller bound
// (src/core/inbound-hydrate.mjs). One function, so the two cuts cannot disagree about where a
// character begins.
export function utf8Bound(bytes, max) {
  if (bytes.byteLength <= max) return bytes.byteLength;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}
