import { MAX_WAIT_MS } from "./limits.mjs";

export function waitForEvent(emitter, find, timeoutMs = 30_000, onTimeout = () => ({ timedOut: true })) {
  const current = find(); if (current) return Promise.resolve(current);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw new Error("invalid timeoutMs");
  return new Promise((resolve) => {
    const timer = setTimeout(() => { emitter.off("event", listener); resolve(onTimeout()); }, timeoutMs);
    const listener = () => { const value = find(); if (!value) return; clearTimeout(timer); emitter.off("event", listener); resolve(value); };
    emitter.on("event", listener);
  });
}
