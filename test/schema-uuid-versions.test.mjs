// The public result validator accepted UUID versions 1 to 5 and refused every other one. Version
// 7 is in use — it is what a time-ordered id generator produces — and every id in a result is
// declared `format: "uuid"`. So a peer that answers with a v7 message id makes the tool that
// would report the answer fail its own output contract: `invalid_public_result`, for that
// messageId, on every call, for as long as the ledger holds that row. There is no cursor past it
// for `peer_wait`, and `peer_send` replays into the same wall.
//
// `requireUuid` in src/core/limits.mjs already accepted 1 to 8, so the id was let in at the door
// and refused on the way out. That asymmetry is the whole fault.
//
// The format check itself stays: a value that is not a UUID is still not a UUID.
import { expect, test } from "bun:test";
import { validateSchema } from "../src/mcp/schema-validator.mjs";
import { requireUuid } from "../src/core/limits.mjs";
import { createFacade, modernMeta } from "../src/mcp/facade.mjs";
import { toolDefinitions } from "../src/mcp/tools.mjs";

const uuid = { type: "string", format: "uuid" };
const of = (version) => `10000000-0000-${version}000-8000-000000000001`;
// Built rather than written out: every uuid literal in this repository has to be in the fixture
// band, and the point of the ones below is that they are not uuids at all (test/pack.test.mjs).
const withVariant = (nibble) => `10000000-0000-4000-${nibble}000-000000000001`;

test("every UUID version a peer may answer with is a UUID here", () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    expect({ version, valid: validateSchema(uuid, of(version)).valid }).toEqual({ version, valid: true });
    expect(requireUuid(of(version), "id")).toBe(of(version));
  }
});

test("what is not a UUID is still refused", () => {
  for (const value of ["", "not-a-uuid", of(0), of("f"), withVariant("c"), withVariant(7), "10000000000040008000000000000001", `${of(4)}x`]) {
    expect({ value, valid: validateSchema(uuid, value).valid }).toEqual({ value, valid: false });
  }
});

// The death, through the wire that publishes it: one `peer_wait` result whose responding message
// id is a v7, projected and validated exactly as the façade does it.
test("a v7 response id does not kill the tool that reports it", async () => {
  const tools = toolDefinitions(["review"], { admin: false });
  const answer = {
    event: { seq: 2, type: "peer_reply", at: "2026-09-07T00:00:00Z", messageId: of(4), responseMessageId: of(7), threadId: of(7), evidence: "application_ack", verdict: "pass" },
    events: [{ seq: 1, type: "send_requested", at: "2026-09-07T00:00:00Z", messageId: of(4), threadId: of(7), alias: "review", kind: "question" }],
    evidence: "application_ack"
  };
  const facade = createFacade({ tools, callTool: async () => answer });
  const response = await facade.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta(), name: "peer_wait", arguments: { messageId: of(4) } } });
  expect(response.result.isError).toBeUndefined();
  expect(response.result.structuredContent.event.responseMessageId).toBe(of(7));
});
