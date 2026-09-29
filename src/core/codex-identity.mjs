import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProcStart, processParent, processStart, readProcessImage } from "../adapters/claude-native-v1/darwin-procargs.mjs";

// Which Codex thread ran this command? (M4)
//
// A Codex host runs many threads in one process, so the kernel pid alone names "some Codex", never a
// thread. What the host does write, and the kernel keeps, is the environment of each command it
// starts: `CODEX_THREAD_ID=<thread uuid>` (present in the Codex binary; read here out of
// KERN_PROCARGS2, i.e. the copy the kernel took at exec, not anything the process says now).
//
// The proof, walking up from the calling process:
//   1. the nearest ancestor whose exec-time environment carries CODEX_THREAD_ID names the thread;
//   2. some ancestor at or above it must be a Codex executable (exec path basename `codex`), so a
//      stray variable in an ordinary shell proves nothing;
//   3. the thread must have a rollout file under $CODEX_HOME/sessions (the host's own registration
//      of that thread), and the start time of the process that carried the variable must not change
//      while it is read (a recycled pid fails).
// Every refusal is named. What this does not establish: that the command was typed by the model
// rather than by another process of the same user that copied the variable. Same Mac, same user is
// the boundary this product keeps (docs/security).
export const CODEX_THREAD_ENV = "CODEX_THREAD_ID";
export const MAX_CODEX_DEPTH = 10;
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function defaultCodexHome(environment = process.env) {
  return typeof environment.CODEX_HOME === "string" && environment.CODEX_HOME !== "" ? environment.CODEX_HOME : path.join(os.homedir(), ".codex");
}

// Rollout files are `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. Looked for by name only;
// the file is never opened (it holds the conversation).
export function threadHasRollout(codexHome, threadId, { maxDays = 4000 } = {}) {
  const root = path.join(codexHome, "sessions"); const suffix = `-${threadId}.jsonl`; let scanned = 0;
  const walk = (dir, depth) => {
    let names; try { names = fs.readdirSync(dir); } catch { return false; }
    for (const name of names.sort().reverse()) {
      const full = path.join(dir, name);
      if (depth === 3) { if (name.startsWith("rollout-") && name.endsWith(suffix)) { try { const st = fs.lstatSync(full); if (st.isFile() && st.uid === process.getuid()) return true; } catch {} } continue; }
      if (!/^\d{2,4}$/.test(name)) continue;
      if (depth === 2 && (scanned += 1) > maxDays) return false;
      if (walk(full, depth + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}

export function createCodexResolver({ codexHome = defaultCodexHome(), imageReader = readProcessImage, parentReader = processParent, startReader = processStart, rollout = threadHasRollout, maxDepth = MAX_CODEX_DEPTH } = {}) {
  return function resolveCodexThread(pid) {
    let current = pid; let threadId = null; let carrier = null; let carrierDepth = null; let hostSeen = false; let hostDepth = null; const seen = new Set();
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      if (!Number.isInteger(current) || current <= 1 || seen.has(current)) break;
      seen.add(current);
      let image = null; try { image = imageReader(current, [CODEX_THREAD_ENV]); } catch { image = null; }
      if (image) {
        if (threadId === null && typeof image.env?.[CODEX_THREAD_ENV] === "string" && image.env[CODEX_THREAD_ENV] !== "") {
          const value = image.env[CODEX_THREAD_ENV].toLowerCase();
          if (!THREAD.test(value)) return { proven: false, reason: "codex_thread_malformed" };
          threadId = value; carrier = current; carrierDepth = depth;
        }
        if (threadId !== null && path.basename(image.executable ?? "") === "codex") { hostSeen = true; hostDepth = depth; break; }
      }
      try { current = parentReader(current); } catch { break; }
    }
    if (threadId === null) return { proven: false, reason: "no_codex_thread" };
    if (!hostSeen) return { proven: false, reason: "codex_host_not_ancestor", threadId };
    let before = null; try { before = normalizeProcStart(startReader(carrier)); } catch {}
    if (!rollout(codexHome, threadId)) return { proven: false, reason: "codex_thread_unregistered", threadId };
    let after = null; try { after = normalizeProcStart(startReader(carrier)); } catch {}
    if (before === null || before !== after) return { proven: false, reason: "process_identity_changed", threadId };
    return { proven: true, threadId, carrierPid: carrier, carrierProcStart: before, depth: carrierDepth, hostDepth };
  };
}
