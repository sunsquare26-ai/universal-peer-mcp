import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTargets, permissionRecord, promptingModeAtLaunch, provenPermission, publicTarget, samePermission } from "../src/core/target-config.mjs";
import { outboundFrames, SENDER_PRODUCT_NAME, senderEnvelope } from "../src/adapters/claude-native-v1/protocol.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

// A permission mode is two facts or it is nothing: what the mode is, and how anyone knows. The
// pair is minted in one place and read through accessors, because a mode that can be read on its
// own will be read on its own, and the reading will happen at the moment it matters least and
// costs most.
describe("a mode never travels without its provenance", () => {
  test("is minted as a frozen pair and refuses a mode it does not know", () => {
    expect(provenPermission("prompting")).toEqual({ mode: "prompting", verifiedBy: "kern_procargs2" });
    expect(Object.isFrozen(provenPermission("bypass"))).toBeTrue();
    for (const mode of ["manual", "", null, undefined, "PROMPTING"]) {
      expect(() => provenPermission(mode)).toThrow("invalid permission mode");
    }
  });

  test("cannot be taken out of a hand-made object that carries no provenance", () => {
    expect(permissionRecord({ mode: "prompting", verifiedBy: "kern_procargs2" })).toEqual({ mode: "prompting", verifiedBy: "kern_procargs2" });
    for (const value of [{ mode: "prompting" }, { verifiedBy: "kern_procargs2" }, { mode: "prompting", verifiedBy: "trust_me" }, { mode: "manual", verifiedBy: "kern_procargs2" }, {}, null, undefined, "prompting"]) {
      expect(() => permissionRecord(value)).toThrow("permission mode has no recorded provenance");
    }
  });

  // The write path re-reads the target immediately before the socket write and compares what it
  // got against what the send was reserved against. It compares the pair, not the mode, so the
  // day a second provenance exists the comparison already sees a change of provenance as a
  // change of permission.
  test("compares as a pair, not as a mode", () => {
    expect(samePermission(provenPermission("prompting"), provenPermission("prompting"))).toBeTrue();
    expect(samePermission(provenPermission("prompting"), { mode: "prompting", verifiedBy: "operator_declared" })).toBeFalse();
    expect(samePermission(provenPermission("prompting"), provenPermission("bypass"))).toBeFalse();
  });
});

// Rule A. An unproven mode is answered here exactly as bypass is: no. The two mistakes are not
// mirror images — a target really in bypass that somebody merely said was prompting acts with
// nobody watching while the sender believes somebody is, while a target really in prompting that
// was called bypass only waits — so the unproven side of the question gets the strict answer.
// The question itself is narrower than the old name claimed: it is about argv at exec, not about
// the target's mode now, not about its inbound policy, and not about anyone being present.
describe("the one question about the mode in argv at launch", () => {
  test("is answered yes only for a mode the kernel proved", () => {
    expect(promptingModeAtLaunch(provenPermission("prompting"))).toBeTrue();
    expect(promptingModeAtLaunch(provenPermission("bypass"))).toBeFalse();
    expect(promptingModeAtLaunch({ mode: "prompting", verifiedBy: "operator_declared" })).toBeFalse();
    expect(promptingModeAtLaunch({ mode: "bypass", verifiedBy: "operator_declared" })).toBeFalse();
  });

  test("is answered no for anything that is not a permission at all", () => {
    for (const value of [{ mode: "prompting" }, { mode: "prompting", verifiedBy: "operator" }, {}, null, undefined, "prompting"]) expect(promptingModeAtLaunch(value)).toBeFalse();
  });

  test("is not a gate: no shipped file outside its own module calls it", async () => {
    const callers = [];
    const walk = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.isFile() || !full.endsWith(".mjs") || full.endsWith("target-config.mjs")) continue;
        if (/promptingModeAtLaunch\s*\(/.test(await fsp.readFile(full, "utf8"))) callers.push(path.relative(ROOT, full));
      }
    };
    await walk(path.join(ROOT, "src"));
    expect(callers).toEqual([]);
  });
});

// Rule B, enforced where it can be checked rather than remembered. The scan is over the shipped
// source, and it fails if any file outside the module that owns the pair pulls a mode out of a
// permission on its own — by member access, by index, or by destructuring without taking the
// provenance in the same statement.
describe("nothing outside the accessor reads a mode on its own", () => {
  const OWNER = path.join("src", "core", "target-config.mjs");
  const MEMBER = /permission[A-Za-z]*\s*(?:\?\.|\.)\s*mode\b/i;
  const INDEXED = /permission[A-Za-z]*\s*(?:\?\.)?\[\s*["'`]mode/i;
  const LOOSE = /\{[^{}]*\bmode\b[^{}]*\}\s*=\s*[^;\n]*permission/i;

  function offences(text, file) {
    const found = [];
    text.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      const loose = LOOSE.test(code) && !/verifiedBy/.test(code);
      if (MEMBER.test(code) || INDEXED.test(code) || loose) found.push(`${file}:${index + 1}`);
    });
    return found;
  }

  async function sources(dir) {
    const found = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await sources(full));
      else if (entry.name.endsWith(".mjs")) found.push(full);
    }
    return found;
  }

  // A scan that matches nothing is not a check. These are the shapes it has to catch.
  test("the scan catches the ways a mode gets read alone", () => {
    expect(offences('if (target.permission.mode === "prompting") send();', "x")).toEqual(["x:1"]);
    expect(offences('const m = permission?.mode;', "x")).toEqual(["x:1"]);
    expect(offences('const m = permission["mode"];', "x")).toEqual(["x:1"]);
    expect(offences('const { mode } = target.permission;', "x")).toEqual(["x:1"]);
    expect(offences('const { mode, verifiedBy } = permissionRecord(target.permission);', "x")).toEqual([]);
    expect(offences('// target.permission.mode is discussed in prose here', "x")).toEqual([]);
  });

  test("the shipped source has none of them", async () => {
    const files = await sources(path.join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(10);
    const found = [];
    for (const file of files) {
      const relative = path.relative(ROOT, file);
      if (relative === OWNER) continue;
      found.push(...offences(await fsp.readFile(file, "utf8"), relative));
    }
    expect(found).toEqual([]);
  });
});

// The envelope is the one part of a send a person reads, and it used to carry a mode there. The
// value it carried was the *recipient's*, which made a statement about the sender change with
// whoever it was addressed to; the cure is not a better value but no statement, because the
// daemon authenticates the process that connected to it and not the session behind that process.
// What the wire says now is the writer's address and a display name, for every caller and every
// recipient alike.
describe("what goes on the wire", () => {
  const from = "uds:/path/to/state/universal-peer-mcp.sock";
  const ids = { targetSessionId: "10000000-0000-4000-8000-000000000001", messageId: "10000000-0000-4000-8000-000000000002", subscriptionId: "10000000-0000-4000-8000-000000000003" };
  const frames = (extra) => outboundFrames({ token: "a".repeat(32), senderAddress: from, content: "x", ...ids, ...extra });

  test("names no permission mode anywhere, in the envelope or in the frames", () => {
    const envelope = senderEnvelope({ from, body: "x" });
    expect(envelope).toBe(`<cross-session-message from="uds:/path/to/state/universal-peer-mcp.sock" from-name="${SENDER_PRODUCT_NAME}">\nx\n</cross-session-message>`);
    for (const attribute of ["from-mode", "from-mode-verified-by", "from_mode"]) expect(envelope).not.toContain(attribute);
    for (const frame of frames({})) expect(Object.keys(frame)).not.toContain("from_mode");
    expect(JSON.stringify(frames({}))).not.toContain("from_mode");
  });

  test("cannot be talked into carrying one", () => {
    const bare = senderEnvelope({ from, body: "x" });
    for (const permission of [provenPermission("prompting"), provenPermission("bypass"), { mode: "prompting" }, { mode: "prompting", verifiedBy: "operator" }, null, undefined]) {
      expect(senderEnvelope({ from, body: "x", permission, permissionMode: permission?.mode })).toBe(bare);
      expect(JSON.stringify(frames({ permission, permissionMode: permission?.mode }))).not.toContain("from_mode");
    }
  });

  // The condition the review put on shipping: sender metadata is a fact about us, so addressing
  // two different targets — different sessions, different sockets, different modes — must not
  // move a byte of it.
  test("does not change with the recipient", () => {
    const one = frames({ token: "a".repeat(32), targetSessionId: "10000000-0000-4000-8000-000000000001" });
    const two = frames({ token: "b".repeat(48), targetSessionId: "10000000-0000-4000-8000-000000000009" });
    const senderMeta = (list) => list.filter((frame) => frame.type !== "auth").map((frame) => ({ from: frame.from, from_mode: frame.from_mode, keys: Object.keys(frame).filter((key) => key.startsWith("from")) }));
    expect(senderMeta(one)).toEqual(senderMeta(two));
    expect(senderEnvelope({ from, body: "x", permission: provenPermission("prompting") })).toBe(senderEnvelope({ from, body: "x", permission: provenPermission("bypass") }));
  });
});

// This build proves the mode from argv or does not resolve the target, so targets.json has no
// field for saying it. A file that carries one is refused by name rather than ignored: a knob
// that is accepted and does nothing is how an operator comes to believe a session is guarded
// when nothing read what they wrote.
describe("the target file has no place to declare a mode", () => {
  async function targets(entry) {
    const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-declared-")); roots.push(made);
    await fsp.chmod(made, 0o700);
    const root = await fsp.realpath(made);
    const cwd = path.join(root, "project"); await fsp.mkdir(cwd);
    const file = path.join(root, "targets.json");
    await fsp.writeFile(file, JSON.stringify({ review: { sessionId: "10000000-0000-4000-8000-000000000002", cwd, permissionMode: "prompting", ...entry } }), { mode: 0o600 });
    return file;
  }

  test("loads the fields it does name, and nothing else", async () => {
    const loaded = await loadTargets(await targets({}));
    expect(Object.keys(loaded.review).sort()).toEqual(["cwd", "expectedDisplayName", "permissionMode", "sessionId"]);
    expect(loaded.review.permissionMode).toBe("prompting");
  });

  test("refuses a permissionModeSource rather than accepting one it cannot honour", async () => {
    for (const value of ["operator_declared", true, false, "", "operator", "kern_procargs2", 1, null]) {
      await expect(loadTargets(await targets({ permissionModeSource: value }))).rejects.toThrow("unknown target field for review");
    }
  });

  test("keeps the target list to the fields the published schema names", async () => {
    const loaded = await loadTargets(await targets({}));
    expect(Object.keys(publicTarget(loaded.review)).sort()).toEqual(["connected", "expectedDisplayName", "observedDisplayName", "permissionMode"]);
  });
});
