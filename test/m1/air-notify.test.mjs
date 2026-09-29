import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../tools/alert-bridge/air-notify.sh", import.meta.url));
const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });

async function stand(sshExit = 0) {
  const root = await tempRoot(); roots.push(root);
  const fake = path.join(root, "ssh");
  await fsp.writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${path.join(root, "ssh.argv")}\nexit ${sshExit}\n`, { mode: 0o700 });
  const run = (...args) => spawnSync("/bin/bash", [SCRIPT, ...args], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", UNIVERSAL_PEER_SSH_BIN: fake, UNIVERSAL_PEER_ALERT_LOG_DIR: path.join(root, "alerts") } });
  const log = async () => (await fsp.readFile(path.join(root, "alerts", "universal-peer.log"), "utf8")).trim().split("\n");
  const argv = async () => (await fsp.readFile(path.join(root, "ssh.argv"), "utf8")).trim().split("\n");
  return { root, run, log, argv };
}

test("logs one line, then notifies the Air with kind and id only", async () => {
  const s = await stand();
  const r = s.run("universal-peer", "ledger_poisoned", "ledger_poisoned:0f7c715a-0000-4000-8000-000000000001", "EACCES");
  expect(r.status).toBe(0);
  const lines = await s.log();
  expect(lines[0]).toMatch(/ alert kind=ledger_poisoned key=ledger_poisoned:0f7c715a-0000-4000-8000-000000000001 code=EACCES$/);
  expect(lines[1]).toMatch(/ notify key=.* air=ok$/);
  const argv = await s.argv();
  expect(argv.slice(0, 6)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"]);
  expect(argv[6]).toBe("hyungseoklee@macbookair.tail72dd63.ts.net");
  expect(argv[7]).toBe(`osascript -e 'display notification "UniversalPeer 경보: ledger_poisoned 0f7c715a-0000-4000-8000-000000000001" with title "UniversalPeer"'`);
  expect((await fsp.stat(path.join(s.root, "alerts"))).mode & 0o777).toBe(0o700);
  expect((await fsp.stat(path.join(s.root, "alerts", "universal-peer.log"))).mode & 0o777).toBe(0o600);
});

test("an unreachable Air still leaves the log line and exits 2", async () => {
  const s = await stand(255);
  expect(s.run("universal-peer", "backup_failed", "backup_failed:2026-09-29", "255").status).toBe(2);
  const lines = await s.log();
  expect(lines[0]).toContain("alert kind=backup_failed");
  expect(lines[1]).toMatch(/air=failed rc=255$/);
});

test("anything that could carry text or break quoting is refused before logging or ssh", async () => {
  const s = await stand();
  for (const args of [["universal-peer", "ledger_poisoned", "key\"; rm -rf ~", "-"], ["universal-peer", "Kind", "k", "-"], ["universal-peer", "backup_failed", "사장님", "-"], ["universal-peer", "backup_failed", "k"], ["other", "a", "b", "c"]]) {
    expect(s.run(...args).status).toBe(64);
  }
  await expect(fsp.access(path.join(s.root, "ssh.argv"))).rejects.toThrow();
  await expect(fsp.access(path.join(s.root, "alerts", "universal-peer.log"))).rejects.toThrow();
});

test("--test sends the fixed test text", async () => {
  const s = await stand();
  expect(s.run("--test").status).toBe(0);
  expect((await s.argv())[7]).toContain("\"UniversalPeer 경보 시험\"");
});
