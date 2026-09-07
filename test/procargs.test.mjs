import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProcStart, parseProcArgs, processIdentity, processStart, processUid, provePermissionMode, readProcessArgv, renderedProcStart } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

const cleanups = [];
afterEach(async () => { for (const undo of cleanups.splice(0).reverse()) await undo(); });

function fixture(argv, executable = argv[0], extraPadding = 0) {
  const encoder = new TextEncoder(); const exec = encoder.encode(executable); const usedForExec = exec.length + 1; const head = 4 + Math.ceil(usedForExec / 8) * 8 + extraPadding;
  const args = argv.map((value) => encoder.encode(value)); const size = head + args.reduce((sum, value) => sum + value.length + 1, 0);
  const bytes = new Uint8Array(size); new DataView(bytes.buffer).setInt32(0, argv.length, true); bytes.set(exec, 4);
  let cursor = head; for (const value of args) { bytes.set(value, cursor); cursor += value.length + 1; }
  return bytes;
}

describe("KERN_PROCARGS2 parser", () => {
  test("preserves empty arguments and requires exact executable", () => expect(parseProcArgs(fixture(["/opt/bin/claude", "", "--permission-mode", "bypassPermissions"]))).toEqual(["/opt/bin/claude", "", "--permission-mode", "bypassPermissions"]));
  test("rejects truncated argc", () => { const bytes = fixture(["/opt/bin/claude"]); new DataView(bytes.buffer).setInt32(0, 2, true); expect(() => parseProcArgs(bytes)).toThrow(); });
  test("rejects executable mismatch", () => expect(() => parseProcArgs(fixture(["claude"], "/opt/bin/claude"))).toThrow("target argv executable mismatch"));

  // The equality does two jobs and both are asserted here, because an attempt on 2026-09-07 to
  // drop it for the first reason silently dropped the second. A layout this build reads at the
  // wrong offset starts inside the exec path's zero padding and hands back an empty first
  // string; no exec path is the empty string, so the same comparison refuses it.
  test("refuses an argv region that starts inside the padding", () => {
    expect(() => parseProcArgs(fixture(["/opt/bin/claude"], "/opt/bin/claude", 8))).toThrow("target argv executable mismatch");
    expect(() => parseProcArgs(fixture(["", "--permission-mode", "default"], "/opt/bin/claude"))).toThrow("target argv executable mismatch");
  });

  test("accepts every measured zero-padding width", () => {
    for (let padding = 0; padding <= 7; padding += 1) {
      const length = ((7 - padding + 8) % 8) + 8; const executable = `/${"x".repeat(length - 1)}`;
      expect(parseProcArgs(fixture([executable, "x"]))).toEqual([executable, "x"]);
    }
  });
  test("rejects malformed executable and alignment boundaries", () => {
    expect(() => parseProcArgs(new Uint8Array(3))).toThrow();
    const noNull = new Uint8Array(24).fill(0x61); new DataView(noNull.buffer).setInt32(0, 1, true); expect(() => parseProcArgs(noNull)).toThrow();
    expect(() => parseProcArgs(fixture(["/opt/bin/claude"], "/opt/bin/claude", 8))).toThrow();
    const executable = "/opt/bin/claud"; const attacked = fixture([executable]); attacked[4 + executable.length + 1] = 0x78; expect(() => parseProcArgs(attacked)).toThrow("unavailable");
  });
  test("proves bypass exactly", () => expect(provePermissionMode("bypass", 20, "same", () => ["/opt/bin/claude", "--permission-mode", "bypassPermissions"], () => "same")).toEqual({ mode: "bypass", verifiedBy: "kern_procargs2" }));
  test("fails duplicate, mismatch, and procStart drift", () => {
    expect(() => provePermissionMode("bypass", 20, "same", () => ["claude", "--permission-mode", "bypassPermissions", "--permission-mode", "default"], () => "same")).toThrow();
    expect(() => provePermissionMode("prompting", 20, "same", () => ["claude", "--permission-mode", "bypassPermissions"], () => "same")).toThrow();
    let n = 0; expect(() => provePermissionMode("prompting", 20, "same", () => ["claude", "--permission-mode", "default"], () => (++n === 1 ? "same" : "changed"))).toThrow();
  });
  test("fails missing, absent, and unknown permission mode values", () => {
    expect(() => provePermissionMode("prompting", 20, "same", () => ["claude", "--permission-mode"], () => "same")).toThrow();
    expect(() => provePermissionMode("prompting", 20, "same", () => ["claude"], () => "same")).toThrow();
    expect(() => provePermissionMode("prompting", 20, "same", () => ["claude", "--permission-mode", "future"], () => "same")).toThrow();
  });

  // A reader is a seam and a seam is an input. What comes back has to be a list of strings, and
  // an unrenderable start time is not a start time to compare against.
  test("refuses a reader that hands back a shape the kernel never produces", () => {
    for (const read of [() => "claude --permission-mode default", () => ({ argv: ["claude"] }), () => [], () => [7], () => null]) {
      expect(() => provePermissionMode("prompting", 20, "same", read, () => "same")).toThrow("target argv unavailable");
    }
    expect(() => provePermissionMode("prompting", 20, "", () => ["claude", "--permission-mode", "default"], () => "same")).toThrow("target identity is unrenderable");
  });
});

// The equality is what keeps a process that renamed itself out of the resolver, and it is
// measured against a real one rather than argued about: a child exec'd with argv0 "/bin/ls"
// reports that argv[0] and the kernel's own exec path, and the two do not match.
describe("a forged argv[0]", () => {
  test("is refused against the exec path the kernel wrote", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { argv0: "/bin/ls", stdio: "ignore" });
    cleanups.push(() => { try { child.kill("SIGKILL"); } catch {} });
    for (let waited = 0; waited < 40 && !child.pid; waited += 1) await Bun.sleep(25);
    await Bun.sleep(250);
    expect(() => readProcessArgv(child.pid)).toThrow("target argv executable mismatch");
    expect(() => provePermissionMode("prompting", child.pid, processStart(child.pid), readProcessArgv, processStart)).toThrow("target argv executable mismatch");
  });

  // And the shape that does pass, read live: a child launched by absolute path, which is the
  // shape the live Claude Code session measured on 2026-09-07 was launched in. A launch off
  // PATH is not — argv[0] "bun" against exec path ~/.bun/bin/bun is this very test runner —
  // and that cost is written down in docs/known-issues.md rather than worked around here.
  test("reads a child launched by absolute path, which is the shape that resolves", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    cleanups.push(() => { try { child.kill("SIGKILL"); } catch {} });
    for (let waited = 0; waited < 40 && !child.pid; waited += 1) await Bun.sleep(25);
    await Bun.sleep(250);
    const argv = readProcessArgv(child.pid);
    expect(Array.isArray(argv)).toBeTrue();
    expect(argv[0]).toBe(process.execPath);
  });
});

// A start time is a kernel fact that arrives as text a program printed, so the program and the two
// variables that decide how it prints are part of the fact. Measured on this machine, TZ=UTC0 and
// LC_ALL=C: `ps` renders "Mon Sep  7 08:16:23 2026", de_DE renders "Mo.  7 Sep. 08:16:23 2026" —
// a different field order, not just different spelling — and ko_KR renders
// "2026년  9월  7일 월요일 08시 16분 23초". Claude Code writes the C rendering into the registry
// row, so on a machine whose account is set to Korean this reader compared Korean text against
// English text and no session ever resolved. Nothing about that is visible in the output; it just
// never matches.
function withEnv(values) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  cleanups.push(async () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function hostilePs(body) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-hostile-ps-"));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ps");
  await fsp.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  withEnv({ PATH: `${dir}:${process.env.PATH ?? ""}` });
  return dir;
}
const trueStart = () => execFileSync("/bin/ps", ["-ww", "-p", String(process.pid), "-o", "lstart="], { encoding: "utf8", env: { TZ: "UTC0", LC_ALL: "C" } }).trim().replace(/\s+/g, " ");

describe("the program that renders a start time", () => {
  test("is /bin/ps, not whatever PATH offers", async () => {
    await hostilePs('echo "Thu Jan  1 00:00:00 1970"; exit 0');
    expect(processStart(process.pid)).toBe(trueStart());
    expect(processIdentity(process.pid).procStart).toBe(trueStart());
    expect(processUid(process.pid)).toBe(process.getuid());
  });

  test("is not confused by a PATH entry that answers with the right shape and the wrong uid", async () => {
    await hostilePs(`echo "  4294967290 Thu Jan  1 00:00:00 1970"; exit 0`);
    expect(processIdentity(process.pid).uid).toBe(process.getuid());
  });
});

describe("the rendering the reader's account cannot move", () => {
  test("is the same string whatever LC_ALL, LANG and TZ the reader sits in", () => {
    const pinned = trueStart();
    for (const locale of ["ko_KR.UTF-8", "de_DE.UTF-8", "fr_FR.UTF-8", "C"]) {
      withEnv({ LC_ALL: locale, LANG: locale, LC_TIME: locale, TZ: "Asia/Seoul" });
      expect(processStart(process.pid)).toBe(pinned);
      expect(processIdentity(process.pid).procStart).toBe(pinned);
      expect(processUid(process.pid)).toBe(process.getuid());
    }
  });

  test("has one shape, and anything else is refused rather than compared", () => {
    expect(renderedProcStart("Mon Sep  7 08:16:23 2026")).toBe("Mon Sep 7 08:16:23 2026");
    expect(renderedProcStart("  Mon Sep 17 08:16:23 2026  \n")).toBe("Mon Sep 17 08:16:23 2026");
    for (const value of ["", "   ", "Mon Sep", "Mon Sep  7 08:16:23", "Mo.  7 Sep. 08:16:23 2026", "2026년  9월  7일 월요일 08시 16분 23초", "lun.  7 sept. 08:16:23 2026", "Mon Sep  7 08:16:23 2026\nTue Sep  8 08:16:23 2026", null, undefined, 20260907, ["Mon Sep  7 08:16:23 2026"]]) {
      expect(() => renderedProcStart(value)).toThrow("process start unavailable");
    }
  });

  test("keeps the squeeze and the shape check in agreement", () => {
    const pinned = processStart(process.pid);
    expect(normalizeProcStart(pinned)).toBe(pinned);
    expect(renderedProcStart(pinned)).toBe(pinned);
  });
});
