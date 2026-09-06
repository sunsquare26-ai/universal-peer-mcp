import { describe, expect, test } from "bun:test";
import { parseProcArgs, provePermissionMode } from "../src/adapters/claude-native-v1/darwin-procargs.mjs";

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
  test("rejects executable mismatch", () => expect(() => parseProcArgs(fixture(["claude"], "/opt/bin/claude"))).toThrow());
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
});
