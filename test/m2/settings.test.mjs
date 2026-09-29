import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadSettings, settingsStatus } from "../../src/core/settings.mjs";
import { tempRoot } from "../m1/helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const ENV = { UNIVERSAL_PEER_ALERT_COMMAND: "/env/air-notify.sh", UNIVERSAL_PEER_ARCHIVE_BACKUP: "u@air:/env/archive" };
async function withFile(content, mode = 0o600) {
  const root = await tempRoot(); roots.push(root);
  if (content !== null) { await fsp.writeFile(path.join(root, "config.json"), content, { mode }); await fsp.chmod(path.join(root, "config.json"), mode); }
  return root;
}

test("file wins over environment, per setting", async () => {
  const root = await withFile(JSON.stringify({ alertCommand: "/file/air-notify.sh" }));
  const s = await loadSettings({ root, env: ENV });
  expect(s.alertCommand).toEqual({ value: "/file/air-notify.sh", source: "file" });
  expect(s.archiveBackup).toEqual({ value: "u@air:/env/archive", source: "env" });
  expect(settingsStatus(s)).toEqual({ alert: "configured(file)", backup: "configured(env)" });
});

test("no file: environment, then default", async () => {
  const root = await withFile(null);
  expect(settingsStatus(await loadSettings({ root, env: ENV }))).toEqual({ alert: "configured(env)", backup: "configured(env)" });
  expect(settingsStatus(await loadSettings({ root, env: {} }))).toEqual({ alert: "not_configured(default)", backup: "not_configured(default)" });
});

test("a broken or untrusted file configures nothing, not even from the environment", async () => {
  for (const [content, mode, reason] of [
    ["{not json", 0o600, "not_json"],
    [JSON.stringify({ alertCommand: "/a" }), 0o644, "not_private"],
    [JSON.stringify({ alertCommand: "/a", extra: 1 }), 0o600, "unknown_key"],
    [JSON.stringify({ alertCommand: "relative/air.sh" }), 0o600, "invalid_alertCommand"],
    [JSON.stringify({ archiveBackup: "u@air:/x; rm -rf ~" }), 0o600, "invalid_archiveBackup"],
    ["[]", 0o600, "not_an_object"]
  ]) {
    const root = await withFile(content, mode);
    const s = await loadSettings({ root, env: ENV });
    expect(s.invalid).toBe(reason);
    expect(settingsStatus(s)).toEqual({ alert: "not_configured(config_invalid)", backup: "not_configured(config_invalid)", configError: reason });
  }
});

test("status never shows the configured path", async () => {
  const root = await withFile(JSON.stringify({ alertCommand: "/secret/place/air-notify.sh", archiveBackup: "u@air:/x" }));
  expect(JSON.stringify(settingsStatus(await loadSettings({ root, env: {} })))).not.toContain("/secret/place");
});
