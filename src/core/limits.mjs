export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_CONTROL_BYTES = 1024 * 1024;
export const MAX_WAIT_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

// Compare old ledger spellings without changing persisted bytes or accepting non-UUID IDs.
export function sameUuid(left, right) {
  return typeof left === "string" && typeof right === "string" && UUID.test(left) && UUID.test(right)
    && left.toLowerCase() === right.toLowerCase();
}

// An id with its dashes taken out and its case squeezed. It is the one form a reference is
// compared in, so a sender that writes a uuid with dashes and a sender that writes the same uuid
// without them are the same sender here.
export function bareHex(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/-/g, "") : "";
}

// The shape of a reference to an id: the leading hex of one, at least eight digits and at most a
// whole uuid. Eight is the width every id in this system is abbreviated to in a log line and in a
// board row, so it is the width a person or a model writes by hand. It narrows and never names —
// a reference matching more than one row is refused by the caller, not resolved here.
const REFERENCE = /^[0-9a-f]{8,32}$/;
export function referenceHex(value) {
  const hex = bareHex(value);
  return REFERENCE.test(hex) ? hex : null;
}
export function referenceMatches(full, reference) {
  return typeof reference === "string" && reference.length > 0 && bareHex(full).startsWith(reference);
}
