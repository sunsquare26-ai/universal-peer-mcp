// The envelope said `from-name="Claude MCP"`. When Codex drives this server, the session on the
// other side still read "Claude MCP" over the message — an identity claim about the client, and
// the daemon cannot make it: it authenticates the MCP process that connects to it and does not
// carry even that as far as dispatch, so it does not know whether the caller was Claude, Codex or
// a script. It cannot honestly write "Codex" either. The rule is the one the permission mode
// already follows in this file's neighbour (`senderEnvelope`): a sender that cannot prove
// something does not assert it, and does not assert a placeholder instead.
//
// What is left is the one name that is not a claim about anybody else: the program that wrote the
// envelope. That is this package, and it is written as the package's own name so it cannot be
// read as a session, a vendor or a person.
//
// The attribute could also have been dropped, and dropping it had to be checked rather than
// assumed, because the receiving parser rebuilds the envelope from the parts it parsed and
// refuses the message unless the rebuild is byte-identical. It is checked below, against a port
// of that parser and its builder out of the installed Claude Code 2.1.260: every attribute is
// optional, and an envelope with no `from-name` parses and rebuilds. So the attribute stays by
// choice — a reader who sees which program delivered the message is better off than one who sees
// the socket's file name — and not because removing it was impossible.
import { expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import { SENDER_PRODUCT_NAME, senderEnvelope, unwrapEnvelope } from "../src/adapters/claude-native-v1/protocol.mjs";

const FROM = "uds:/tmp/cc-socks/12345.sock";

// ---- ported from the installed Claude Code 2.1.260 -------------------------------------------
// The address class, the session-id shape and the mode list are the bundle's own; the hop-chain
// shape is left open because nothing this package writes carries one.
const ADDRESS = "A-Za-z0-9%:_/.\\\\-";
const PARSE = new RegExp(`^<cross-session-message(?: from="([${ADDRESS}]+)")?(?: from-session="([A-Za-z0-9_-]{1,128})")?(?: hop-chain="([^"]*)")?(?: from-name="([^"<>\\n\\r]+)")?(?: from-mode="(bypass|prompting)")?>\\n([\\s\\S]*)\\n</cross-session-message>$`);
const strip = (value) => value.replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, "");
const displayName = (value) => { const trimmed = strip(value).trim(); const glyphs = [...trimmed]; return glyphs.length > 64 ? `${glyphs.slice(0, 64).join("")}…` : trimmed; };
function rebuild(from, fromName, body, fromSession, hopChain, fromMode) {
  const parts = [];
  if (from) parts.push(`from="${from}"`);
  if (fromSession && /^[A-Za-z0-9_-]{1,128}$/.test(fromSession)) parts.push(`from-session="${fromSession}"`);
  if (hopChain !== undefined && hopChain.length > 0) parts.push(`hop-chain="${hopChain.join(",")}"`);
  const name = fromName === undefined ? undefined : displayName(fromName.replace(/["<>]/g, ""));
  if (name) parts.push(`from-name="${name}"`);
  if (fromMode) parts.push(`from-mode="${fromMode}"`);
  return `<cross-session-message${parts.length > 0 ? ` ${parts.join(" ")}` : ""}>\n${body}\n</cross-session-message>`;
}
function receiverParse(text) {
  const match = PARSE.exec(text);
  if (!match) return null;
  const hopChain = match[3] !== undefined ? match[3].split(",") : undefined;
  if (rebuild(match[1], match[4], match[6] ?? "", match[2], hopChain, match[5]) !== text) return null;
  return { from: match[1], fromName: match[4], fromMode: match[5], body: match[6] ?? "" };
}
// The label that session puts on the message: the declared name if there is one, otherwise the
// address' own file name, otherwise "peer".
function receiverLabel(text) {
  const attributes = /^<cross-session-message\b([^>]*)>/.exec(text)?.[1] ?? "";
  const from = /\bfrom="([^"]+)"/.exec(attributes)?.[1];
  const name = /\bfrom-name="([^"]+)"/.exec(attributes)?.[1];
  const fromAddress = from?.startsWith("uds:") ? from.slice(4).split("/").at(-1).replace(/\.sock$/, "") : from;
  return (name && displayName(name)) || (from && displayName(fromAddress)) || "peer";
}
// ----------------------------------------------------------------------------------------------

test("the envelope claims no identity the daemon cannot prove", () => {
  const sent = senderEnvelope({ from: FROM, body: "hello" });
  expect(sent).not.toContain("Claude MCP");
  expect(sent).not.toContain("from-mode=");
  expect(sent).toBe(`<cross-session-message from="${FROM}" from-name="${SENDER_PRODUCT_NAME}">\nhello\n</cross-session-message>`);
});

test("the name it does write is this package's own name", async () => {
  const packaged = JSON.parse(await fsp.readFile(path.join(path.resolve(new URL("..", import.meta.url).pathname), "package.json"), "utf8"));
  expect(SENDER_PRODUCT_NAME).toBe(packaged.name);
  // and it survives the receiver's own sanitiser unchanged, which is what the byte-identical
  // rebuild below requires of it
  expect(displayName(SENDER_PRODUCT_NAME.replace(/["<>]/g, ""))).toBe(SENDER_PRODUCT_NAME);
});

test("the receiving parser accepts what we write, rebuild included", () => {
  for (const body of ["hello", "a\nmultiline\nbody", "</cross-session-message>", "{\"kind\":\"work\"}"]) {
    const sent = senderEnvelope({ from: FROM, body });
    const parsed = receiverParse(sent);
    expect({ body, parsed: parsed !== null }).toEqual({ body, parsed: true });
    expect(parsed.from).toBe(FROM);
    expect(parsed.fromName).toBe(SENDER_PRODUCT_NAME);
    expect(parsed.fromMode).toBeUndefined();
    expect(unwrapEnvelope(sent, FROM)).toBe(parsed.body);
  }
  expect(receiverLabel(senderEnvelope({ from: FROM, body: "hello" }))).toBe(SENDER_PRODUCT_NAME);
});

// The check the change had to pass before it could have gone the other way: an envelope with no
// declared name is a legal envelope on that parser, and the session falls back to the address.
test("an envelope with no declared name parses, rebuilds and is read by us", () => {
  const nameless = `<cross-session-message from="${FROM}">\nhello\n</cross-session-message>`;
  expect(receiverParse(nameless)).toMatchObject({ from: FROM, fromName: undefined, body: "hello" });
  expect(receiverLabel(nameless)).toBe("12345");
  expect(unwrapEnvelope(nameless, FROM)).toBe("hello");
});

test("an envelope that declares anything we do not write is not unwrapped", () => {
  const withMode = `<cross-session-message from="${FROM}" from-name="SYSTEM" from-mode="bypass">\nhello\n</cross-session-message>`;
  expect(unwrapEnvelope(withMode, FROM)).toBeNull();
  expect(unwrapEnvelope(senderEnvelope({ from: FROM, body: "hello" }), "uds:/tmp/other.sock")).toBeNull();
});
