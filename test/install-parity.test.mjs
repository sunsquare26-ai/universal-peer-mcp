// Two installs of this package run side by side — one the Codex side launches, one the Claude side
// launches — and they are supposed to be the same build. Nothing checked that. A peer channel where
// one end is running code the other end does not have fails in ways that look like protocol bugs:
// a field one side writes and the other has never heard of, a ledger row one side cannot project.
//
// This compares the two `src` trees by content. It reads and never writes: an install is not this
// test's to modify, and a test that repaired a difference would be hiding the thing it exists to
// find.
//
// The two roots are injected, never hardcoded — an absolute path baked into a test is a test that
// only means anything on one machine:
//
//   UNIVERSAL_PEER_MCP_INSTALL_A=<package root>  UNIVERSAL_PEER_MCP_INSTALL_B=<package root>
//
// A root that is not given, or is given and is not there, is an explicit failure and not a skip. A
// skipped comparison reads as a passing one in every summary that counts tests, which is the same
// silence this repair is about everywhere else.
//
// The manifests are compared by parsing them, not by handing them to `shasum -c`. A three-column
// manifest — digest, byte count, path — is not the two-column format `shasum -c` reads: it takes the
// second column as the start of the filename and reports a file it cannot find as a non-OK line, so
// a tree that matches perfectly comes back as every file failing.
import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const A_ENV = "UNIVERSAL_PEER_MCP_INSTALL_A";
const B_ENV = "UNIVERSAL_PEER_MCP_INSTALL_B";

async function installRoot(name) {
  const configured = process.env[name];
  expect(typeof configured === "string" && configured !== "",
    `${name} is not set. Point it at an installed package root (the directory holding src/) to compare the two side-by-side installs.`).toBe(true);
  const src = path.join(configured, "src");
  let stat = null;
  try { stat = await fsp.stat(src); } catch {}
  expect(stat !== null && stat.isDirectory(), `${name}=${configured} has no src/ directory to compare.`).toBe(true);
  return src;
}

// Every file under one tree, as `sha256  bytes  relative/path`, sorted. Symbolic links are recorded
// as links rather than followed: two trees that differ only in where a link points differ.
async function manifest(root) {
  const lines = [];
  const walk = async (directory, prefix) => {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { lines.push(`symlink:${await fsp.readlink(absolute)}  0  ${relative}`); continue; }
      if (entry.isDirectory()) { await walk(absolute, relative); continue; }
      if (!entry.isFile()) continue;
      const bytes = await fsp.readFile(absolute);
      lines.push(`${crypto.createHash("sha256").update(bytes).digest("hex")}  ${bytes.length}  ${relative}`);
    }
  };
  await walk(root, "");
  return lines.sort();
}

// The parser the comment above is about: three columns, the path being everything after the second,
// so a path with a space in it survives.
function parseManifest(lines) {
  const entries = new Map();
  for (const line of lines) {
    const match = /^(\S+)  (\d+)  (.+)$/.exec(line);
    expect(match, `manifest line is not "digest  bytes  path": ${line}`).not.toBeNull();
    entries.set(match[3], { digest: match[1], bytes: Number(match[2]) });
  }
  return entries;
}

test("R4 the two installed src trees are the same build", async () => {
  const [left, right] = await Promise.all([installRoot(A_ENV), installRoot(B_ENV)]);
  const [a, b] = await Promise.all([manifest(left), manifest(right)]).then(([x, y]) => [parseManifest(x), parseManifest(y)]);

  const onlyInA = [...a.keys()].filter((file) => !b.has(file)).sort();
  const onlyInB = [...b.keys()].filter((file) => !a.has(file)).sort();
  const differing = [...a.keys()].filter((file) => b.has(file) && a.get(file).digest !== b.get(file).digest).sort();

  const report = [
    `${A_ENV}: ${left} (${a.size} files)`,
    `${B_ENV}: ${right} (${b.size} files)`,
    onlyInA.length ? `only in A: ${onlyInA.join(", ")}` : "",
    onlyInB.length ? `only in B: ${onlyInB.join(", ")}` : "",
    differing.length ? `differing content: ${differing.join(", ")}` : ""
  ].filter(Boolean).join("\n");

  expect(onlyInA, report).toEqual([]);
  expect(onlyInB, report).toEqual([]);
  expect(differing, report).toEqual([]);
  expect(a.size, report).toBe(b.size);
});
