import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doctor } from "../src/doctor.mjs";

const made = [];
afterEach(async () => { for (const dir of made.splice(0)) await fsp.rm(dir, { recursive: true, force: true }); });

const HEALTHY = { peerProtocol: 1, peerFeatures: ["notify_idle", "reply_across_default_dirs"] };
const FIXTURE_SESSION = "10000000-0000-4000-8000-000000000001";

async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-doctor-"));
  made.push(dir); await fsp.chmod(dir, 0o700);
  return await fsp.realpath(dir);
}

async function sessions(rows) {
  const dir = await tempDir();
  let pid = 40001;
  for (const row of rows) { await fsp.writeFile(path.join(dir, `${pid}.json`), typeof row === "string" ? row : JSON.stringify(row), { mode: 0o600 }); pid += 1; }
  return dir;
}

async function report(rows, stateRoot) {
  return doctor({ stateRoot: stateRoot ?? await tempDir(), sessionsDir: await sessions(rows) });
}

test("doctor prints no absolute path for a state directory outside the home", async () => {
  const root = await tempDir();
  const document = await report([HEALTHY], root);
  expect(document.stateDirectory).toBe("[path]");
  expect(JSON.stringify(document)).not.toContain(root);
  expect(JSON.stringify(document)).not.toContain(path.basename(root));
});

test("doctor keeps the documented home shorthand for the default state directory", async () => {
  const document = await report([HEALTHY], path.join(os.homedir(), "Library", "Application Support", "claude-peer-mcp"));
  expect(document.stateDirectory).toBe("~/Library/Application Support/claude-peer-mcp");
  expect(JSON.stringify(document)).not.toContain(os.homedir());
});

test("doctor masks another account's home path that surfaces in a config error", async () => {
  const root = await tempDir();
  const stranger = ["", "Users", "not-a-real-account", "project"].join("/");
  await fsp.writeFile(path.join(root, "targets.json"), JSON.stringify({ "frontend-review": { sessionId: FIXTURE_SESSION, cwd: stranger, permissionMode: "prompting" } }), { mode: 0o600 });
  const document = await report([HEALTHY], root);
  expect(document.targets.schemaValid).toBe(false);
  expect(typeof document.targets.reason).toBe("string");
  expect(document.targets.reason).toContain("[path]");
  expect(JSON.stringify(document)).not.toContain("not-a-real-account");
});

test("doctor never echoes a registry supplied peerProtocol value", async () => {
  const planted = `Bearer ${"a".repeat(24)}`;
  const document = await report([{ peerProtocol: planted, peerFeatures: HEALTHY.peerFeatures }]);
  expect(Object.keys(document.claudeRegistry.byProtocol)).toEqual(["invalid"]);
  expect(JSON.stringify(document)).not.toContain("aaaaaaaa");
  expect(JSON.stringify(document)).not.toContain("Bearer");
  expect(document.claudeRegistry.ok).toBe(false);
});

test("doctor calls a healthy registry compatible", async () => {
  const document = await report([HEALTHY, HEALTHY]);
  expect(document.claudeRegistry).toMatchObject({ ok: true, entries: 2, compatible: 2, incompatible: 0, unreadable: 0, supportedProtocol: 1 });
  expect(document.claudeRegistry.byProtocol).toEqual({ "1": 2 });
  expect(document.claudeRegistry.missingRequiredFeatures).toEqual({});
  expect(document.claudeRegistry.directory).toBe("[path]");
});

test("doctor fails the registry check on an unsupported protocol", async () => {
  const document = await report([{ peerProtocol: 99, peerFeatures: HEALTHY.peerFeatures }]);
  expect(document.claudeRegistry).toMatchObject({ ok: false, entries: 1, compatible: 0, incompatible: 1, unreadable: 0 });
  expect(document.claudeRegistry.byProtocol).toEqual({ "99": 1 });
  expect(document.ok).toBe(false);
});

test("doctor fails the registry check when a required peer feature is missing", async () => {
  const document = await report([{ peerProtocol: 1, peerFeatures: ["notify_idle"] }]);
  expect(document.claudeRegistry).toMatchObject({ ok: false, compatible: 0, incompatible: 1 });
  expect(document.claudeRegistry.missingRequiredFeatures).toEqual({ reply_across_default_dirs: 1 });
  expect(document.ok).toBe(false);
});

test("doctor fails the registry check on an unreadable entry", async () => {
  const document = await report(["{ this is not json"]);
  expect(document.claudeRegistry).toMatchObject({ ok: false, entries: 1, compatible: 0, unreadable: 1 });
  expect(document.ok).toBe(false);
});

test("doctor buckets a registry entry with no peerProtocol as absent", async () => {
  const document = await report([{ peerFeatures: HEALTHY.peerFeatures }]);
  expect(document.claudeRegistry.byProtocol).toEqual({ absent: 1 });
  expect(document.claudeRegistry.ok).toBe(false);
});

test("doctor creates nothing, not even the state directory it reports on", async () => {
  const parent = await tempDir();
  const root = path.join(parent, "never-created");
  const document = await report([HEALTHY], root);
  expect(document.state.present).toBe(false);
  await expect(fsp.lstat(root)).rejects.toThrow();
  expect(await fsp.readdir(parent)).toEqual([]);
});

test("doctor reports a state directory it cannot read as a failure, not as absent", async () => {
  const parent = await tempDir();
  const root = path.join(parent, "locked");
  await fsp.mkdir(root, { mode: 0o700 });
  await fsp.chmod(parent, 0o000);
  try {
    expect(await fsp.lstat(root).then(() => null, (error) => error.code)).toBe("EACCES");
    const document = await report([HEALTHY], root);
    expect(document.state).toMatchObject({ ok: false, status: "unreadable", present: null });
    expect(document.targets).toMatchObject({ ok: false, status: "unreadable", present: null });
    expect(document.ok).toBe(false);
    expect(JSON.stringify(document)).not.toContain(path.basename(parent));
  } finally { await fsp.chmod(parent, 0o700); }
});

test("doctor does not call a state directory healthy when it cannot read the files inside it", async () => {
  const root = await tempDir();
  await fsp.writeFile(path.join(root, "targets.json"), "{}", { mode: 0o600 });
  await fsp.chmod(root, 0o600);
  try {
    const document = await report([HEALTHY], root);
    expect(document.state.ok).toBe(false);
    expect(document.state.status).toBe("present");
    expect(document.state.unreadable).toBeGreaterThan(0);
    expect(document.ok).toBe(false);
  } finally { await fsp.chmod(root, 0o700); }
});

test("doctor reports a session registry it cannot read as unreadable, not as missing", async () => {
  const parent = await tempDir();
  const sessionsDir = path.join(parent, "sessions");
  await fsp.mkdir(sessionsDir, { mode: 0o700 });
  await fsp.chmod(parent, 0o000);
  try {
    const document = await doctor({ stateRoot: await tempDir(), sessionsDir });
    expect(document.claudeRegistry).toMatchObject({ ok: false, status: "unreadable" });
    expect(document.ok).toBe(false);
  } finally { await fsp.chmod(parent, 0o700); }
});

test("a healthy state directory and a missing one keep their documented status words", async () => {
  const parent = await tempDir();
  const absent = await report([HEALTHY], path.join(parent, "never-created"));
  expect(absent.state).toMatchObject({ ok: true, status: "absent", present: false });
  expect(absent.targets).toMatchObject({ ok: true, status: "absent", present: false });
  const root = await tempDir();
  const present = await report([HEALTHY], root);
  expect(present.state).toMatchObject({ ok: true, status: "present", present: true, unreadable: 0 });
});
