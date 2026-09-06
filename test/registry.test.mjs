import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveTarget } from "../src/adapters/claude-native-v1/registry.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(overrides = {}) {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-registry-")); cleanups.push(() => fsp.rm(made, { recursive: true, force: true })); const root = await fsp.realpath(made); await fsp.chmod(root, 0o700);
  const sessionsDir = path.join(root, "sessions"); const cwd = path.join(root, "project"); await fsp.mkdir(sessionsDir, { mode: 0o700 }); await fsp.mkdir(cwd);
  const socketPath = path.join(root, "target.sock"); const server = net.createServer(); await new Promise((resolve) => server.listen(socketPath, resolve)); await fsp.chmod(socketPath, 0o600); cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const row = { pid: 4321, sessionId: "10000000-0000-4000-8000-000000000020", cwd, procStart: "fixture-start", peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"], messagingSocketPath: socketPath, name: "Renamed" , ...overrides.row };
  await fsp.writeFile(path.join(sessionsDir, "4321.json"), `${JSON.stringify(row)}\n`, { mode: overrides.registryMode ?? 0o600 });
  const keyPath = path.join(sessionsDir, `4321.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await fsp.writeFile(keyPath, `${JSON.stringify({ procStart: row.procStart, peerToken: "a".repeat(32) })}\n`, { mode: overrides.keyMode ?? 0o600 });
  const expected = { sessionId: row.sessionId, cwd: overrides.expectedCwd ?? cwd, expectedDisplayName: "Expected", permissionMode: "prompting" };
  const options = { sessionsDir, processUidReader: () => overrides.uid ?? process.getuid(), processStartReader: () => overrides.start ?? row.procStart, startReader: () => overrides.proofStart ?? row.procStart, argvReader: () => ["/opt/bin/claude", "--permission-mode", "default"] };
  return { expected, options };
}

describe("exact target identity", () => {
  test("display name is diagnostic, not authority", async () => { const { expected, options } = await fixture(); const target = await resolveTarget(expected, options); expect(target.observedDisplayName).toBe("Renamed"); expect(target.expectedDisplayName).toBe("Expected"); });
  test("fails another uid and PID start reuse", async () => { let item = await fixture({ uid: process.getuid() + 1 }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live"); item = await fixture({ start: "reused" }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live"); });
  test("fails cwd mismatch", async () => { const item = await fixture({ expectedCwd: os.tmpdir() }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("cwd mismatch"); });
  test("fails broad registry and token modes", async () => { let item = await fixture({ registryMode: 0o644 }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live"); item = await fixture({ keyMode: 0o644 }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("key is not private"); });
  test("requires every native peer feature used by the adapter", async () => { const item = await fixture({ row: { peerFeatures: ["notify_idle"] } }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("unsupported Claude peer protocol"); });
});
