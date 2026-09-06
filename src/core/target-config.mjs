import fsp from "node:fs/promises";
import path from "node:path";
import { assertPrivateFile } from "./state-paths.mjs";
import { plainObject, requireUuid } from "./limits.mjs";

const ALIAS = /^[a-z][a-z0-9-]{1,47}$/;

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
    if (!["prompting", "bypass"].includes(raw.permissionMode)) throw new Error(`invalid permissionMode for ${alias}`);
    if (raw.expectedDisplayName !== undefined && (typeof raw.expectedDisplayName !== "string" || Buffer.byteLength(raw.expectedDisplayName) > 256)) throw new Error(`invalid expectedDisplayName for ${alias}`);
    result[alias] = Object.freeze({ sessionId: requireUuid(raw.sessionId, "sessionId"), cwd, expectedDisplayName: raw.expectedDisplayName ?? null, permissionMode: raw.permissionMode });
  }
  return Object.freeze(result);
}

export function publicTarget(target, connected = false, observedDisplayName = null) {
  return { connected, permissionMode: target.permissionMode, expectedDisplayName: target.expectedDisplayName, observedDisplayName };
}
