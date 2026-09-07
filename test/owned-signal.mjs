// Signalling by pid is signalling whoever holds that pid now. The end to end run starts
// daemons, remembers their pids and tears them down at the end, and by then some of those
// processes have exited — on a machine that recycles pids, the number the test still holds can
// belong to the person's own editor. So a pid is never enough here: what is remembered is the
// pid together with the process start time the daemon published, and nothing is signalled
// unless the process that answers to that pid still has that start time.
//
// This lives beside the end to end test rather than inside it so the rule can be tested on its
// own, with real processes, in a second rather than in five minutes.
//
// The start time is read through the product's own reader on purpose. The value remembered here
// is the one the daemon published, and a second reader that renders the same instant differently
// — another zone, another day padding — answers "not the process I remember" for every live
// daemon and this file stops ending anything it started. Agreement with the publisher is the
// whole guard; an independent copy of the rendering rule is what makes it drift.
import { normalizeProcStart, processStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

export function procStartOf(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { return processStart(pid) || null; }
  catch { return null; }                        // ps exits non zero when there is no such pid
}

export function owns(pid, procStart) {
  if (typeof procStart !== "string" || !procStart) return false;
  return procStartOf(pid) === normalizeProcStart(procStart);
}

// registry is a Map of pid to the start time recorded when the pid was first seen.
export function signalOwned(registry, signal) {
  const signalled = [];
  for (const [pid, procStart] of registry) {
    if (!owns(pid, procStart)) continue;
    try { process.kill(pid, signal); signalled.push(pid); } catch {}
  }
  return signalled;
}

// A child handle knows whether it has been reaped; a pid does not. Asking first is the
// difference between ending our own child and ending a stranger that inherited its number.
export function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try { child.kill(signal); return true; } catch { return false; }
}
