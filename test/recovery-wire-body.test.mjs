import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeJsonAngles } from "../src/adapters/claude-native-v1/protocol.mjs";
import { canonicalSend } from "../src/core/dedupe.mjs";
import { EventStore } from "../src/core/events.mjs";
import { milestoneSendOptions, PeerCore } from "../src/core/peer-core.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

// The angle brackets leave a JSON body at the serialization boundary so that the envelope's
// shield finds nothing to cut into (src/adapters/claude-native-v1/protocol.mjs). That was applied
// to the first send of a message and not to the second: the recovery transport built its wire
// body out of the raw canonical form, so a body carrying any spelling of the closing delimiter
// but the one JSON happens to have an escape for went out mangled — an escape JSON does not have,
// which the far side cannot parse at all.
//
// A recovery is only reachable through the internal send options, and the one caller that uses
// them hands over a marker body of its own, so this is not a path a public send takes today. It
// is a path the next extension takes the moment it does not, and the encoding is a property of
// the wire, not of the caller.
const FROM = "uds:/tmp/cc-socks/real.sock";
const DELIMITERS = [
  "< /cross-session-message>",
  "<∕cross-session-message>",
  "＜/cross-session-message>",
  "</cross-session-message>",
  "plain text with no delimiter in it at all"
];
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

const unwrap = (content) => /^<cross-session-message from="([^"]+)" from-name="[^"]+">\n([\s\S]+)\n<\/cross-session-message>$/.exec(content)?.[2] ?? null;
const userContent = (frames) => frames.find((frame) => frame.type === "user").message.content;
const parsed = (text) => { try { return JSON.parse(text); } catch (error) { return { unparseable: error.message }; } };
const live = (text) => ({
  open: (text.match(/(?<!\\)<cross-session-message\b/gi) ?? []).length,
  close: (text.match(/(?<!\\)<\/\s*cross-session-message\s*>/gi) ?? []).length
});

async function wired() {
  const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-recovery-body-")); roots.push(made); await fsp.chmod(made, 0o700);
  const root = await fsp.realpath(made);
  const store = new EventStore(statePaths(root)); await store.init();
  const target = { sessionId: crypto.randomUUID(), cwd: root, permissionMode: "prompting", expectedDisplayName: null };
  const resolved = { ...target, pid: 77, procStart: "start", socketPath: "/tmp/fake-recovery.sock", token: "1".repeat(32), permission: { mode: "prompting", verifiedBy: "kern_procargs2" }, observedDisplayName: null };
  const wires = [];
  const core = new PeerCore({ targets: { peer: target }, store, address: FROM, resolver: async () => resolved, sender: async (_target, frames) => { wires.push(frames); return { bytesWritten: 42 }; } });
  return { store, core, wires };
}

test("a recovery transport writes the same encoded body the first transport wrote", async () => {
  const ctx = await wired();
  for (const body of DELIMITERS) {
    const args = { alias: "peer", messageId: crypto.randomUUID(), threadId: crypto.randomUUID(), kind: "work", body };
    const first = await ctx.core.send(args);
    const initialWire = unwrap(userContent(ctx.wires.at(-1)));

    const again = await ctx.core.send(args, milestoneSendOptions({ recovery: true }));
    const recoveryWire = unwrap(userContent(ctx.wires.at(-1)));

    expect({ body, recovered: again.recovered, carried: parsed(recoveryWire).body ?? parsed(recoveryWire).unparseable }).toEqual({ body, recovered: true, carried: body });
    // byte for byte the body the first transport carried: one message, two transports, and the
    // wire encoding is not one of the things that may differ between them.
    expect({ body, same: recoveryWire === initialWire }).toEqual({ body, same: true });
    expect(recoveryWire).toBe(encodeJsonAngles(canonicalSend(args)));
    // the hash is taken over the unencoded canonical form, so the ledger row is the same row
    expect(again.requestHash).toBe(first.requestHash);
    // and the envelope the recovery wrote is still one envelope
    expect(live(userContent(ctx.wires.at(-1)))).toEqual({ open: 1, close: 1 });
  }
});
