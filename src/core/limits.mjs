export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_CONTROL_BYTES = 1024 * 1024;
export const MAX_WAIT_MS = 300_000;

export function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireUuid(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}
