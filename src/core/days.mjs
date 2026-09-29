// Operating days are Korea time (the owner's and both Main sessions' day). One function, so the
// archive, the daily counts and the retention clock cannot disagree about which day a row is in.
export const DAY_OFFSET_MINUTES = 9 * 60;

export function dayOf(at, offsetMinutes = DAY_OFFSET_MINUTES) {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}
