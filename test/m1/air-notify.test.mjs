import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../tools/alert-bridge/air-notify.sh", import.meta.url));
const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });
const EVENTS = (t) => `osascript -e 'tell application "System Events" to display notification "${t}" with title "UniversalPeer"'`;
const PLAIN = (t) => `osascript -e 'display notification "${t}" with title "UniversalPeer"'`;

// A fake ssh: records each call's argv (one per line, calls separated by ---) and exits with the
// next code from `codes`.
async function stand(codes = [0]) {
  const root = await tempRoot(); roots.push(root);
  const fake = path.join(root, "ssh"); const codesFile = path.join(root, "codes");
  await fsp.writeFile(codesFile, codes.join("\n") + "\n");
  await fsp.writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${path.join(root, "ssh.argv")}\necho --- >> ${path.join(root, "ssh.argv")}\nc=$(head -1 ${codesFile}); tail -n +2 ${codesFile} > ${codesFile}.n; mv ${codesFile}.n ${codesFile}\nexit \${c:-0}\n`, { mode: 0o700 });
  const run = (...args) => spawnSync("/bin/bash", [SCRIPT, ...args], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", UNIVERSAL_PEER_SSH_BIN: fake, UNIVERSAL_PEER_ALERT_LOG_DIR: path.join(root, "alerts"), UNIVERSAL_PEER_AIR_SSH: "owner@second-mac.example" } });
  const log = async () => (await fsp.readFile(path.join(root, "alerts", "universal-peer.log"), "utf8")).trim().split("\n");
  const calls = async () => (await fsp.readFile(path.join(root, "ssh.argv"), "utf8").catch(() => "")).split("---\n").filter(Boolean).map((c) => c.trim().split("\n"));
  return { root, run, log, calls };
}
const ID = "0f7c715a-0000-4000-8000-000000000001";
const TEXT = `UniversalPeer 경보: ledger_poisoned ${ID}`;

test("default is System Events in the GUI session; logs first, one ssh call, kind and id only", async () => {
  const s = await stand([0]);
  expect(s.run("universal-peer", "ledger_poisoned", `ledger_poisoned:${ID}`, "EACCES").status).toBe(0);
  const lines = await s.log();
  expect(lines[0]).toMatch(new RegExp(` alert kind=ledger_poisoned key=ledger_poisoned:${ID} code=EACCES$`));
  expect(lines[1]).toMatch(/ notify key=.* air=ok method=system_events$/);
  const calls = await s.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0, 7)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "owner@second-mac.example"]);
  expect(calls[0][7]).toBe(EVENTS(TEXT));
  expect((await fsp.stat(path.join(s.root, "alerts"))).mode & 0o777).toBe(0o700);
  expect((await fsp.stat(path.join(s.root, "alerts", "universal-peer.log"))).mode & 0o777).toBe(0o600);
});

test("System Events refused (rc 1): falls back to plain osascript", async () => {
  const s = await stand([1, 0]);
  expect(s.run("universal-peer", "ledger_poisoned", `ledger_poisoned:${ID}`, "EACCES").status).toBe(0);
  const calls = await s.calls();
  expect(calls.map((c) => c[7])).toEqual([EVENTS(TEXT), PLAIN(TEXT)]);
  expect((await s.log())[1]).toMatch(/air=ok method=osascript_fallback rc_events=1$/);
});

test("both refused: logged, not notified, exit 2", async () => {
  const s = await stand([1, 1]);
  expect(s.run("universal-peer", "backup_failed", "backup_failed:2026-09-29", "255").status).toBe(2);
  expect((await s.log())[1]).toMatch(/air=failed rc=1$/);
});

test("an unreachable Air (ssh 255) is not retried with the fallback", async () => {
  const s = await stand([255, 0]);
  expect(s.run("universal-peer", "backup_failed", "backup_failed:2026-09-29", "255").status).toBe(2);
  expect(await s.calls()).toHaveLength(1);
  const lines = await s.log();
  expect(lines[0]).toContain("alert kind=backup_failed");
  expect(lines[1]).toMatch(/air=failed rc=255$/);
});

test("anything that could carry text or break quoting is refused before logging or ssh", async () => {
  const s = await stand();
  for (const args of [["universal-peer", "ledger_poisoned", "key\"; rm -rf ~", "-"], ["universal-peer", "Kind", "k", "-"], ["universal-peer", "backup_failed", "소유자", "-"], ["universal-peer", "backup_failed", "k"], ["other", "a", "b", "c"]]) {
    expect(s.run(...args).status).toBe(64);
  }
  expect(await s.calls()).toEqual([]);
  await expect(fsp.access(path.join(s.root, "alerts", "universal-peer.log"))).rejects.toThrow();
});

test("--test sends the fixed test text", async () => {
  const s = await stand([0]);
  expect(s.run("--test").status).toBe(0);
  expect((await s.calls())[0][7]).toBe(EVENTS("UniversalPeer 경보 시험"));
});
