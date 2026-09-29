import fsp from "node:fs/promises";
import path from "node:path";
import { assertPrivateFile } from "./state-paths.mjs";

// Daemon settings that must survive whoever starts the daemon. The daemon is started by whichever
// MCP serve asks first (control.mjs ensureDaemon) and inherits that serve's environment, which is
// the Codex MCP config's — so a setting put only in an environment variable silently does not
// reach it (measured at the M1 install, 2026-09-29). The state directory is the one place every
// start shares, so the settings live there: `<state>/config.json`, an owned 0600 file.
//
//   { "alertCommand": "/abs/path/air-notify.sh", "archiveBackup": "user@host:/abs/path" }
//
// Precedence per setting: file, then environment, then default (not configured). A file that
// exists but cannot be trusted (not private, not JSON, unknown keys, bad values) configures
// nothing at all — not even from the environment — and is reported once: a half-read settings file
// is a guess about what the operator meant.
export const SETTINGS_FILENAME = "config.json";
const KEYS = { alertCommand: "UNIVERSAL_PEER_ALERT_COMMAND", archiveBackup: "UNIVERSAL_PEER_ARCHIVE_BACKUP" };
const REMOTE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\/[A-Za-z0-9._/-]*$/;
const valid = {
  alertCommand: (v) => typeof v === "string" && path.isAbsolute(v) && !/[\s'"`$;&|<>]/.test(v),
  archiveBackup: (v) => typeof v === "string" && (REMOTE.test(v) || (path.isAbsolute(v) && !/[\s'"`$;&|<>]/.test(v)))
};

export async function loadSettings({ root, env = process.env }) {
  const file = path.join(root, SETTINGS_FILENAME);
  let fromFile = null; let invalid = null;
  try {
    await assertPrivateFile(file, { maxBytes: 16 * 1024 });
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("not an object"), { reason: "not_an_object" });
    for (const [key, value] of Object.entries(parsed)) {
      if (key === LEGACY_BODIES) { if (typeof value !== "boolean") throw Object.assign(new Error("bad value"), { reason: `invalid_${key}` }); continue; }
      if (!(key in KEYS)) throw Object.assign(new Error("unknown key"), { reason: "unknown_key" });
      if (!valid[key](value)) throw Object.assign(new Error("bad value"), { reason: `invalid_${key}` });
    }
    fromFile = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") invalid = error?.reason ?? (error instanceof SyntaxError ? "not_json" : "not_private");
  }
  const out = { invalid };
  for (const [key, envName] of Object.entries(KEYS)) {
    if (invalid) { out[key] = { value: null, source: "config_invalid" }; continue; }
    if (fromFile && fromFile[key] !== undefined) { out[key] = { value: fromFile[key], source: "file" }; continue; }
    const fromEnv = env[envName];
    if (typeof fromEnv === "string" && fromEnv !== "" && valid[key](fromEnv)) { out[key] = { value: fromEnv, source: "env" }; continue; }
    out[key] = { value: null, source: "default" };
  }
  // The compatibility window (M4 review [상]2): while true, the diagnostic answers (peer_wait,
  // peer_list_events, a peer_send replay) keep handing out every row's body as before M4. File only,
  // never the environment, and anything but a literal `true` — including a broken file — is off.
  out[LEGACY_BODIES] = { value: !invalid && fromFile?.[LEGACY_BODIES] === true, source: !invalid && fromFile?.[LEGACY_BODIES] !== undefined ? "file" : "default" };
  return out;
}
export const LEGACY_BODIES = "legacyBodiesInDiagnostics";
export const LEGACY_BODIES_WARNING = "진단 본문 노출 호환창 켜짐";

// What daemon_status shows: "configured(file)", "configured(env)", "not_configured(default)" or
// "not_configured(config_invalid)". Never the value itself (it is a path).
export function settingsStatus(settings) {
  const show = (s) => (s.value ? `configured(${s.source})` : `not_configured(${s.source})`);
  return { alert: show(settings.alertCommand), backup: show(settings.archiveBackup), ...(settings.invalid ? { configError: settings.invalid } : {}), ...(settings[LEGACY_BODIES]?.value ? { legacyBodiesInDiagnostics: true, warning: LEGACY_BODIES_WARNING } : {}) };
}
