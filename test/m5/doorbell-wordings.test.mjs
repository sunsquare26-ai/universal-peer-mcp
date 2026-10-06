// Every wording a build has sent under a derived Claude doorbell id is frozen here by hash. A
// reservation is replayed byte for byte (doorbell-service.mjs), so an old wording that drifts — say
// a shared line edited for the newest one — would turn every old reservation into a conflict.
// Add a new wording at the front of claudeDoorbellVersions and its hash at the front here.
import { expect, test } from "bun:test";
import crypto from "node:crypto";
import { claudeDoorbellVersions } from "../../src/core/doorbell.mjs";

test("historical Claude doorbell wordings never change (r6, r5, pre-M5 bare line)", () => {
  const hashes = claudeDoorbellVersions("11111111-1111-4111-8111-111111111111").map((x) => crypto.createHash("sha256").update(x).digest("hex"));
  expect(hashes.slice(-3)).toEqual(["1cb8c7993bc53e103df518ac1932baa24c42adf888a4e2b20074bceea7344276","e56b88b1677e0189ff2044e169702bde8f66b496b4cd216816dc504518001515","9d8654ae82203f28fa3527ec416594ffb85d6c3024acb16997f046c565b44586"]);
});
