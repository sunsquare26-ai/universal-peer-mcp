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

// `Promise.allSettled` with a clock, for shutdown paths.
//
// Every entry gets a result. One that has not settled when the bound ends is reported as a
// rejection naming what did not finish, so a stall leaves through the caller's normal failure
// path instead of holding it open. This exists because a shutdown's waits are not all on work
// that is guaranteed to end: the ledger write chain can stop (`EventStore.close` awaits it),
// `net.Server#close` only calls back once every connection has ended, and the refusal reporter a
// receiver close runs is an `EventStore.append`. Measured on the unfixed code, with a real
// EventStore stalled on a readerless FIFO: the close had not settled after 8 s, so the cleanup,
// the named refusal and the non-zero exit were all unreachable. A daemon that cannot die is worse
// on this channel than one that dies loudly — an operator swapping the binary has no way forward.
//
// It lives here, exported, rather than inline in `src/daemon.mjs`, for the reason that file's own
// receiver wiring was moved out: a function can be imported and asserted, and a bound buried in a
// top-level-await script is a bound with no test over it.
//
// Entries are `[label, promise]`. Rejections are attached on every entry as it is raced, so an
// abandoned one cannot surface as an unhandled rejection. The timer is always cleared.
export async function settleAllWithin(labelled, millis) {
  let expire;
  const expired = new Promise((resolve) => { expire = resolve; });
  const timer = setTimeout(() => expire(TIMED_OUT), Math.max(0, millis));
  try {
    return await Promise.all(labelled.map(async ([label, promise]) => {
      const outcome = await Promise.race([
        Promise.resolve(promise).then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })),
        expired
      ]);
      if (outcome !== TIMED_OUT) return outcome;
      return {
        status: "rejected",
        reason: Object.assign(new Error(`${label} did not finish within ${Math.max(0, millis)} ms of the shutdown`), { code: "SHUTDOWN_WAIT_TIMEOUT", label })
      };
    }));
  } finally { clearTimeout(timer); }
}
const TIMED_OUT = Symbol("timed out");
