import fsp from "node:fs/promises";
import path from "node:path";
import { assertPrivateFile } from "./state-paths.mjs";
import { sha256 } from "./dedupe.mjs";
import { plainObject, requireUuid } from "./limits.mjs";

const ALIAS = /^[a-z][a-z0-9-]{1,47}$/;
const MODES = ["prompting", "bypass"];

// Where a permission mode came from. This build knows one answer: `kern_procargs2`, the kernel's
// own copy of the arguments the target was executed with. It is written down beside every mode
// anyway, because a mode read on its own is a mode nobody can check, and because the day a
// second source exists — an operator declaring the mode for a session whose argv cannot carry
// it — everything downstream is already reading the pair rather than the word.
export const KERNEL_PROVEN = "kern_procargs2";
const SOURCES = [KERNEL_PROVEN];

export function provenPermission(mode) { return mintPermission(mode, KERNEL_PROVEN); }
function mintPermission(mode, verifiedBy) {
  if (!MODES.includes(mode)) throw new Error("invalid permission mode");
  return Object.freeze({ mode, verifiedBy });
}

// One narrow question, and the name says exactly how narrow: was `prompting` the mode in the
// arguments the kernel recorded when this target process was executed? It is asked of the pair
// rather than the mode, so a permission that arrived without its provenance answers exactly as
// `bypass` does — no.
//
// Three things it does not establish, and each was once read into the older name `humanGateProven`:
//   - not the target's mode now. argv is fixed at exec; a session's effective mode is runtime
//     state that a person can change afterwards, and nothing here re-reads it.
//   - not the target's policy for messages arriving from another session. That policy is the
//     receiver's and is not in argv at all.
//   - not that a person is present, watching, or will answer. Measured on 2026-09-07: three
//     messages sent to a live `prompting` session sat in its approval queue and expired after
//     300 s with nobody there.
//
// So this is a launch-time fact about one process, useful for telling a caller what kind of
// target it is addressing, and not a gate anything may treat as proof that a human is in the
// loop. Nothing in `src/` decides anything on it today.
export function promptingModeAtLaunch(permission) {
  return permission?.verifiedBy === KERNEL_PROVEN && permission?.mode === "prompting";
}

// The only way to get a mode out of a permission, and it never comes out alone. A permission
// whose provenance is not one this build knows is not a permission at all, so a hand-made
// `{ mode: "prompting" }` cannot reach a ledger line or a status result. Nothing about a
// permission reaches the wire at all — see `senderEnvelope` for why.
export function permissionRecord(permission) {
  const mode = permission?.mode;
  const verifiedBy = permission?.verifiedBy;
  if (!MODES.includes(mode) || !SOURCES.includes(verifiedBy)) throw new Error("permission mode has no recorded provenance");
  return { mode, verifiedBy };
}

// Two permissions are the same permission only when they agree about the mode and about how the
// mode is known. A target that was proved a minute ago and is merely declared now has changed,
// and the write that re-checks it before the socket is written has to see that change.
export function samePermission(left, right) {
  return left?.mode === right?.mode && left?.verifiedBy === right?.verifiedBy;
}

export async function loadTargets(file) {
  await assertPrivateFile(file, { maxBytes: 256 * 1024 });
  const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
  if (!plainObject(parsed) || Object.keys(parsed).length > 128) throw new Error("targets must be a small object");
  const result = {};
  for (const [alias, raw] of Object.entries(parsed)) {
    if (!ALIAS.test(alias) || !plainObject(raw)) throw new Error("invalid target entry");
    const allowed = new Set(["sessionId", "cwd", "expectedDisplayName", "permissionMode"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(`unknown target field for ${alias}`);
    const cwd = await fsp.realpath(raw.cwd);
    if (!path.isAbsolute(cwd)) throw new Error(`target cwd must be absolute: ${alias}`);
    if (!MODES.includes(raw.permissionMode)) throw new Error(`invalid permissionMode for ${alias}`);
    if (raw.expectedDisplayName !== undefined && (typeof raw.expectedDisplayName !== "string" || Buffer.byteLength(raw.expectedDisplayName) > 256)) throw new Error(`invalid expectedDisplayName for ${alias}`);
    result[alias] = Object.freeze({ sessionId: requireUuid(raw.sessionId, "sessionId"), cwd, expectedDisplayName: raw.expectedDisplayName ?? null, permissionMode: raw.permissionMode });
  }
  return Object.freeze(result);
}

// One reading of the table, reduced to something two processes can compare. Counting the entries
// was what this used to be and counting is blind to the change that matters: repoint one alias at
// another session and the count does not move, so a daemon holding the old row and a server that
// has read the new one agreed they were looking at the same table while a message addressed to
// that alias went to the session the operator had just taken it off. Every field the resolver is
// given is in here, in the normalized form `loadTargets` produced — same file, same loader, same
// digest — and the aliases are sorted so key order cannot make two identical tables differ.
export function targetTableDigest(targets) {
  const table = targets ?? {};
  return sha256(JSON.stringify(Object.keys(table).sort().map((alias) => [alias, table[alias].sessionId, table[alias].cwd, table[alias].expectedDisplayName ?? null, table[alias].permissionMode])));
}

// What the target list shows is the operator's own file read back, before anything is resolved:
// `connected` is false and no process has been looked at. The proved answer belongs to a
// resolution, and that answer is what `peer_status` carries, with its provenance beside it.
export function publicTarget(target, connected = false, observedDisplayName = null) {
  return { connected, permissionMode: target.permissionMode, expectedDisplayName: target.expectedDisplayName, observedDisplayName };
}
