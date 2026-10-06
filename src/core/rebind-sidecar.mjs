import fsp from "node:fs/promises";
import { assertPrivateFile, atomicPrivateWrite } from "./state-paths.mjs";
import { plainObject, requireUuid, sameUuid } from "./limits.mjs";
import { serializeByFile } from "./target-config.mjs";

// Everything succession needs to remember, kept beside the target table and never inside it.
//
// `targets.json` is the operator's file and every build of this package reads it. `loadTargets`
// refuses a field it does not recognise, and `src/server.mjs` reads a table it cannot parse as no
// table at all — so one unknown field written into it unpublishes every alias on any build that
// predates the field, and rolling the code back does not roll that back, because the field is on
// disk. A separate file is invisible to a build that does not know it exists, which is what makes
// this feature installable and removable while the other side keeps running.
//
// It holds two things: the switch, and what each alias used to point at.
export const REBIND_STATE_FILENAME = "targets-rebind.json";
export const REBIND_MODES = Object.freeze(["proof", "off"]);
export const DEFAULT_REBIND_MODE = "proof";
const MAX_PREVIOUS_SESSION_IDS = 8;
const MAX_ALIASES = 128;

// No file is not a failure. It is what every install has before the first succession, and the
// default it stands for is `proof` — the failure this path answers is total (every message to that
// alias is refused until a person edits the table), and the only way to succeed is to hold a
// receipt the kernel wrote.
const ABSENT = Object.freeze({ mode: DEFAULT_REBIND_MODE, history: Object.freeze({}), present: false });

export async function readRebindState(file) {
  let text;
  try { await assertPrivateFile(file, { maxBytes: 64 * 1024 }); text = await fsp.readFile(file, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return ABSENT; throw error; }
  const parsed = JSON.parse(text);
  if (!plainObject(parsed)) throw new Error("rebind state must be an object");
  const mode = parsed.mode === undefined ? DEFAULT_REBIND_MODE : parsed.mode;
  if (!REBIND_MODES.includes(mode)) throw new Error(`rebind mode must be one of ${REBIND_MODES.join(", ")}`);
  const raw = parsed.history === undefined ? {} : parsed.history;
  if (!plainObject(raw) || Object.keys(raw).length > MAX_ALIASES) throw new Error("rebind history must be a small object");
  const history = {};
  for (const [alias, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids) || ids.length > MAX_PREVIOUS_SESSION_IDS) throw new Error(`invalid rebind history for ${alias}`);
    history[alias] = Object.freeze(ids.map((id) => requireUuid(id, "previousSessionIds")));
  }
  return Object.freeze({ mode, history: Object.freeze(history), present: true });
}

// The one place this file is written. It is queued behind the target table's own writer for the
// same reason that one is queued behind itself: two aliases can succeed at the same moment, and a
// read-modify-write that is not serialized loses one of them.
export async function recordSuccession(file, alias, previousSessionId, { maxPrevious = MAX_PREVIOUS_SESSION_IDS } = {}) {
  return serializeByFile(file, async () => {
    let stored = ABSENT; let mode = null;
    try { const state = await readRebindState(file); stored = state; mode = state.present ? state.mode : null; }
    catch { stored = ABSENT; mode = null; }
    const kept = Math.max(1, Math.min(maxPrevious, MAX_PREVIOUS_SESSION_IDS));
    const held = requireUuid(previousSessionId, "previousSessionIds");
    const history = { ...stored.history };
    history[alias] = [...(history[alias] ?? []).filter((id) => !sameUuid(id, held)), held].slice(-kept);
    // `mode` is written back only when the file already said one, so recording a succession never
    // turns the switch on in a file that never carried it.
    const next = { ...(mode === null ? {} : { mode }), history };
    await atomicPrivateWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    return { previousSessionIds: history[alias] };
  });
}

export function previousSessionIdsFor(state, alias) { return state?.history?.[alias] ?? []; }
