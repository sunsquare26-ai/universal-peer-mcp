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
  const socketPath = path.join(root, "target.sock"); const server = net.createServer(); await new Promise((resolve) => server.listen(socketPath, resolve)); await fsp.chmod(socketPath, overrides.socketMode ?? 0o600); cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const row = { pid: 4321, sessionId: "10000000-0000-4000-8000-000000000020", cwd, procStart: "fixture-start", peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"], messagingSocketPath: socketPath, name: "Renamed" , ...overrides.row };
  const rowPath = path.join(sessionsDir, "4321.json");
  await fsp.writeFile(rowPath, `${JSON.stringify(row)}\n`, { mode: 0o600 }); await fsp.chmod(rowPath, overrides.registryMode ?? 0o600);
  const keyPath = path.join(sessionsDir, `4321.${crypto.createHash("sha256").update(path.resolve(socketPath)).digest("hex")}.key`);
  await fsp.writeFile(keyPath, `${JSON.stringify({ procStart: row.procStart, peerToken: "a".repeat(32) })}\n`, { mode: 0o600 }); await fsp.chmod(keyPath, overrides.keyMode ?? 0o600);
  const expected = { sessionId: row.sessionId, cwd: overrides.expectedCwd ?? cwd, expectedDisplayName: "Expected", permissionMode: "prompting", ...overrides.expected };
  const options = { sessionsDir, processUidReader: () => overrides.uid ?? process.getuid(), processStartReader: () => overrides.start ?? row.procStart, startReader: () => overrides.proofStart ?? row.procStart, argvReader: () => overrides.argv ?? ["/opt/bin/claude", "--permission-mode", "default"] };
  return { expected, options };
}

describe("exact target identity", () => {
  test("display name is diagnostic, not authority", async () => { const { expected, options } = await fixture(); const target = await resolveTarget(expected, options); expect(target.observedDisplayName).toBe("Renamed"); expect(target.expectedDisplayName).toBe("Expected"); });
  test("fails another uid and PID start reuse", async () => { let item = await fixture({ uid: process.getuid() + 1 }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live"); item = await fixture({ start: "reused" }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live"); });
  test("fails cwd mismatch", async () => { const item = await fixture({ expectedCwd: os.tmpdir() }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("cwd mismatch"); });
  test("requires every native peer feature used by the adapter", async () => { const item = await fixture({ row: { peerFeatures: ["notify_idle"] } }); await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("unsupported Claude peer protocol"); });
});

// The registry row is the one file in this adapter that a mode cannot make private, because we do
// not write it: Claude Code 2.1.260 writes ~/.claude/sessions/<pid>.json at 0644, and every live
// row on this machine is 0644. Demanding 0600 there refused every real session and bought nothing
// — the row carries pid, session id, cwd and a socket path, and the secret that admits a sender,
// peerToken, is in a separate file we also do not write. Readability is not ours to close. Forgery
// is: a row another account can rewrite can point us at a socket of its choosing, and that needs
// the write bit. So the row is judged on group and other write, and nothing else in this adapter
// moves — the key file, the socket, and the sessions directory stay at 0600/0700.
describe("what a mode on a session file can prove", () => {
  test("accepts the world-readable row Claude Code actually writes", async () => {
    for (const mode of [0o600, 0o640, 0o644, 0o604]) {
      const item = await fixture({ registryMode: mode });
      await expect(resolveTarget(item.expected, item.options)).resolves.toMatchObject({ pid: 4321 });
    }
  });

  test("refuses a row another account could rewrite", async () => {
    for (const mode of [0o664, 0o666, 0o622, 0o606, 0o620, 0o602]) {
      const item = await fixture({ registryMode: mode });
      await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("0 live");
    }
  });

  test("keeps the key file at 0600, readable by no one else", async () => {
    for (const mode of [0o640, 0o644, 0o604, 0o660, 0o666]) {
      const item = await fixture({ keyMode: mode });
      await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("key is not private");
    }
  });

  test("keeps the socket at 0600, connectable by no one else", async () => {
    for (const mode of [0o640, 0o644, 0o604, 0o660, 0o666]) {
      const item = await fixture({ socketMode: mode });
      await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("socket is not private");
    }
  });
});

// A session resumed with `claude --resume <id>` takes its permission mode from settings, so its
// arguments will never hold the flag and no reader will ever find one. There is no second source
// in this build: the mode is proved from argv or the target does not resolve, and what that
// costs is written down in docs/known-issues.md rather than answered with a default.
describe("a target whose arguments cannot carry the mode", () => {
  test("does not resolve, and says the argv could not prove it", async () => {
    const item = await fixture({ argv: ["claude", "--resume", "10000000-0000-4000-8000-000000000020"] });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("permission mode argv cannot be proven");
  });

  test("takes the mode from the kernel and never from the config", async () => {
    let item = await fixture();
    await expect(resolveTarget(item.expected, item.options)).resolves.toMatchObject({ permission: { mode: "prompting", verifiedBy: "kern_procargs2" } });
    item = await fixture({ argv: ["/opt/bin/claude", "--permission-mode", "bypassPermissions"] });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow("permission mode mismatch");
  });
});

// The argv[0]/exec-path equality is one door of several and it is the cheapest to satisfy: a
// caller who controls the target sets argv[0] to whatever the exec path says. So this asserts
// what the equality is not carrying — with argv[0] equal to the exec path, every other door the
// resolver guards is still shut.
test("an argv[0] that equals the exec path opens none of the other doors", async () => {
  const argv = ["/opt/bin/claude", "--permission-mode", "default"];
  for (const [overrides, message] of [[{ uid: process.getuid() + 1 }, "0 live"], [{ start: "reused" }, "0 live"], [{ registryMode: 0o666 }, "0 live"], [{ keyMode: 0o644 }, "key is not private"], [{ socketMode: 0o666 }, "socket is not private"], [{ expectedCwd: os.tmpdir() }, "cwd mismatch"], [{ row: { peerFeatures: ["notify_idle"] } }, "unsupported Claude peer protocol"]]) {
    const item = await fixture({ ...overrides, argv });
    await expect(resolveTarget(item.expected, item.options)).rejects.toThrow(message);
  }
});
