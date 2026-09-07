import { expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readScreen } from "./screen.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const ALLOWED_ROOT_FILES = new Set([
  "package.json", "README.md", "LICENSE", "NOTICE",
  "SECURITY.md", "TRADEMARKS.md", "CONTRIBUTING.md", "COMPATIBILITY.md",
  "targets.example.json"
]);
const ALLOWED_PREFIXES = ["src/", "docs/", "examples/"];
// The one picture that ships: the sanitized screenshot design 354 asks for. It is drawn from a
// fixture rather than captured, its bytes are pinned here, and the text inside it is recovered
// from its pixels below and scanned exactly like any other file. test/screenshot.test.mjs holds
// the rest of the gate — chunk list, metadata, tamper.
const SIGNED_IMAGE = "docs/round-trip.png";
const SIGNED_IMAGE_SHA256 = "329351901aa6ed2fefb6da681185f75e10252463821475da00bb7edd646c3cfe";
const REQUIRED = [
  "package.json", "LICENSE", "README.md", "SECURITY.md", "TRADEMARKS.md", "CONTRIBUTING.md", "COMPATIBILITY.md",
  "targets.example.json", "docs/architecture.md", "docs/configuration.md", "docs/troubleshooting.md", "docs/known-issues.md",
  "docs/demo-ack.md", "docs/round-trip.png", "examples/codex-config.toml", "examples/claude-mcp.json",
  "src/cli.mjs", "src/doctor.mjs", "src/server.mjs", "src/daemon.mjs"
];
const DENY_PATH = [
  /(^|\/)test(s)?\//, /(^|\/)fixtures?\//, /(^|\/)node_modules\//, /(^|\/)dist\//,
  /\.claude/, /provenance/i, /design/i, /\.golden\./, /(^|\/)targets\.json$/,
  /(^|\/)events\.jsonl$/, /\.sock$/, /\.pid$/, /\.token$/, /\.lock$/, /\.tgz$/,
  /(^|\/)\.env/, /\.DS_Store$/, /(^|\/)state\//
];
const TEXT = /\.(mjs|js|json|md|txt|toml|yml|yaml|example)$/;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg|pdf)$/i;

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const FIXTURE_UUID = /^10000000-0000-4000-8000-[0-9a-f]{12}$/;
const SECRET = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgh[opsu]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bglpat-[A-Za-z0-9_-]{16,}/, /\bnpm_[A-Za-z0-9]{30,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /\bBearer\s+[A-Za-z0-9._-]{16,}/
];
// Assembled from fragments on purpose: a scanner must not carry the strings it bans, or the
// file that clears the release becomes the one thing an operator deny list keeps flagging.
const INTERNAL = [
  new RegExp(`\\b${"er"}${"p"}\\b`, "i"), new RegExp(`\\b${"JW"}${"A"}\\b`), new RegExp(`\\b${"Visi"}${"on"}\\b`),
  new RegExp(`\\.claude/${"work"}${"trees"}`), /\b\d{2,7}\.[0-9a-f]{64}\.key\b/
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/;
const HOME_PATH = /\/Users\/([^\s/"'`)\]}>,;:!?*\\]+)/gu;
const HOME_NAME_ALLOWED = new Set(["example"]);
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;

// Every picture is kept out — by extension, by file header, and by embedded markup — except
// the one signed screenshot, which is checked separately and far harder. Extension alone is not
// a gate: a renamed PNG would still carry a menu bar, a user name and a path.
const IMAGE_MAGIC = [
  ["png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["jpeg", (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))],
  ["gif", (bytes) => ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))],
  ["bmp", (bytes) => bytes.length >= 26 && bytes.subarray(0, 2).toString("latin1") === "BM"],
  ["webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
  ["tiff", (bytes) => ["II*\u0000", "MM\u0000*"].includes(bytes.subarray(0, 4).toString("latin1"))],
  ["heif", (bytes) => bytes.subarray(4, 8).toString("latin1") === "ftyp" && ["heic", "heix", "mif1", "avif"].includes(bytes.subarray(8, 12).toString("latin1"))],
  ["pdf", (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-"]
];
// base64 is not the only encoding a data uri has, and a vector image does not need a data uri
// at all, so the shapes are matched separately and none of them assumes base64.
const EMBEDDED_IMAGE = /data:image\/[a-z0-9.+-]*\s*[;,]/i;
const INLINE_SVG = /<\s*svg[\s/>]/i;
const ENCODED_SVG = /%3c\s*svg/i;

// A character reference is not decoration. A browser and a markdown renderer both resolve a
// numeric reference to the letter it names, so one reference dropped into the middle of a data
// uri scheme leaves a picture that renders and bytes that match nothing — and the same trick
// hides the at sign in an address or the hyphens in a uuid. Every scan therefore runs over the
// decoded text as well as the raw text. (The worked example is PICTURE.decimalReference below,
// assembled from fragments so that decoding this file does not produce what it bans.)
//
// Decoding is one pass, the way a parser does it: text that renders as "&#105;" is not a
// reference and is not decoded again. The named table is every reference in the HTML5 set whose
// expansion is an ASCII character — the only ones that can rebuild any shape below — together
// with the invisible characters this scanner already bans. Over-decoding here can only add a
// false positive, never remove a true one, so an unknown name is left exactly as it was.
//
// A reference has no length limit, and a digit counter is therefore not a gate: "&#00000105;"
// is the same letter as "&#105;" to every renderer. The leading zeros are consumed outside the
// counted digits, so padding of any length decodes and a value that is still out of range is
// left alone.
const NAMED_REFERENCES = new Map(Object.entries({
  Tab: "\t", NewLine: "\n", excl: "!", quot: '"', QUOT: '"', num: "#", dollar: "$", percnt: "%",
  amp: "&", AMP: "&", apos: "'", lpar: "(", rpar: ")", ast: "*", midast: "*", plus: "+",
  comma: ",", period: ".", sol: "/", colon: ":", semi: ";", lt: "<", LT: "<", equals: "=",
  gt: ">", GT: ">", quest: "?", commat: "@", lsqb: "[", lbrack: "[", bsol: "\\", rsqb: "]",
  rbrack: "]", Hat: "^", lowbar: "_", UnderBar: "_", grave: "`", DiacriticalGrave: "`",
  lcub: "{", lbrace: "{", verbar: "|", vert: "|", VerticalLine: "|", rcub: "}", rbrace: "}",
  fjlig: "fj", nbsp: "\u00a0", NonBreakingSpace: "\u00a0", hyphen: "\u2010", dash: "\u2010",
  ZeroWidthSpace: "\u200b", NegativeVeryThinSpace: "\u200b", NegativeThinSpace: "\u200b",
  NegativeMediumSpace: "\u200b", NegativeThickSpace: "\u200b", InvisibleTimes: "\u200b",
  InvisibleComma: "\u200b", zwnj: "\u200c", zwj: "\u200d", NoBreak: "\u2060",
  af: "\u2061", ApplyFunction: "\u2061", lrm: "\u200e", rlm: "\u200f"
}));
const CHARACTER_REFERENCE = /&(?:#0*(\d{1,7})|#[xX]0*([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g;
export function decodeReferences(text) {
  if (!text.includes("&")) return text;
  return text.replace(CHARACTER_REFERENCE, (whole, decimal, hex, name) => {
    if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10)) ?? whole;
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16)) ?? whole;
    return NAMED_REFERENCES.get(name) ?? whole;
  });
}
function codePoint(value) {
  if (!Number.isInteger(value) || value < 1 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null;
  return String.fromCodePoint(value);
}
function readings(raw) { const decoded = decodeReferences(raw); return decoded === raw ? [raw] : [raw, decoded]; }

// A url parser removes ascii tab, line feed and carriage return from a url before it resolves
// it, so a data uri split by any of them is one data uri to a browser and to a markdown
// renderer while the raw bytes match nothing. The image shapes are matched over that reading as
// well. Only the image shapes: the same removal across a whole document would join lines that
// have nothing to do with each other and invent leaks that are not there.
const URL_WHITESPACE = /[\t\n\r]/g;
function urlReadings(raw) { return [...new Set(readings(raw).flatMap((body) => [body, body.replace(URL_WHITESPACE, "")]))]; }

// The whole file, not the first page of it. A picture appended to a long document is still a
// picture, and 64 KiB into a markdown file is a comfortable place to hide one.
export function imageOffenders(file, bytes) {
  const offenders = [];
  if (file === SIGNED_IMAGE) {
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    return digest === SIGNED_IMAGE_SHA256 ? [] : [`${file}: the signed screenshot is not the bytes that were signed`];
  }
  if (IMAGE.test(file)) offenders.push(`${file}: image file extension`);
  for (const [name, matches] of IMAGE_MAGIC) if (matches(bytes)) offenders.push(`${file}: ${name} file header`);
  for (const body of urlReadings(bytes.toString("latin1"))) {
    if (EMBEDDED_IMAGE.test(body)) offenders.push(`${file}: embedded image data uri`);
    if (INLINE_SVG.test(body)) offenders.push(`${file}: inline vector image`);
    if (ENCODED_SVG.test(body)) offenders.push(`${file}: url encoded vector image`);
  }
  return [...new Set(offenders)];
}

// Signed exceptions. The key is the file, the value is the SHA-256 of the exact matched
// text, so the shape itself never has to be written down here and any other match in the
// same file still fails. A digest that stops matching is reported as stale, not ignored.
const ALLOWED_LEAK_DIGESTS = new Map([
  // test/mcp.test.mjs feeds a synthetic bearer string to the redactor on purpose; the
  // assertion there is that it never reaches a public result.
  ["test/mcp.test.mjs", new Set(["2e6ad69016f66d4b5a95aa38017878b0b4a537bc138b2a374e4e69ae1af59c33"])]
]);
const usedDigests = new Set();

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function allowed(file, matched) {
  const hash = digest(matched);
  if (!ALLOWED_LEAK_DIGESTS.get(file)?.has(hash)) return false;
  usedDigests.add(`${file}:${hash}`); return true;
}

// A signed exception clears one matched string, so every match has to be offered to it. A
// scanner that stops at the first hit lets a real secret hide behind an approved one on the
// same line. The offender line carries a digest prefix, never the matched text itself.
const globalPatterns = new Map();
function everyMatch(pattern, body) {
  let scan = globalPatterns.get(pattern);
  if (!scan) { scan = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`); globalPatterns.set(pattern, scan); }
  return [...body.matchAll(scan)].map((match) => match[0]);
}

// One scanner, used both on the real tree and on synthetic input, so the negative control
// exercises exactly the code that clears the release.
export function scanBody(file, raw, context = {}) {
  const { home = os.homedir(), denyTerms = [] } = context;
  const offenders = [];
  for (const source of readings(raw)) {
    for (const body of [source, source.normalize("NFC"), source.normalize("NFD")]) {
      if (home && body.includes(home)) offenders.push(`${file}: literal home path`);
      for (const match of body.matchAll(HOME_PATH)) if (!HOME_NAME_ALLOWED.has(match[1]) && !allowed(file, match[0])) offenders.push(`${file}: user home path`);
      for (const pattern of SECRET) for (const match of everyMatch(pattern, body)) if (!allowed(file, match)) offenders.push(`${file}: secret shaped by ${pattern} (${digest(match).slice(0, 12)})`);
      for (const pattern of INTERNAL) for (const match of everyMatch(pattern, body)) if (!allowed(file, match)) offenders.push(`${file}: internal name ${pattern} (${digest(match).slice(0, 12)})`);
      for (const match of everyMatch(EMAIL, body)) if (!allowed(file, match)) offenders.push(`${file}: email address (${digest(match).slice(0, 12)})`);
      for (const found of body.match(UUID) ?? []) if (!FIXTURE_UUID.test(found) && !allowed(file, found)) offenders.push(`${file}: uuid outside the fixture namespace`);
      const lowered = body.normalize("NFC").toLowerCase();
      for (const term of denyTerms) if (lowered.includes(term.normalize("NFC").toLowerCase())) offenders.push(`${file}: operator deny term`);
    }
    if (ZERO_WIDTH.test(source)) offenders.push(`${file}: zero width character`);
    if (BIDI.test(source)) offenders.push(`${file}: bidirectional control character`);
  }
  if (raw !== raw.normalize("NFC")) offenders.push(`${file}: text is not NFC normalised`);
  return [...new Set(offenders)];
}

// The signed screenshot has no utf8 to read, so what is scanned is the text its pixels carry.
// A picture that cannot be read back is an offence in itself, not a file to skip.
async function scannableText(file) {
  const absolute = path.join(ROOT, file);
  if (file !== SIGNED_IMAGE) return fsp.readFile(absolute, "utf8");
  return readScreen(await fsp.readFile(absolute)).join("\n");
}

async function operatorDenyTerms(listPath = process.env.CLAUDE_PEER_MCP_DENY_TERMS) {
  if (!listPath) return [];
  return (await fsp.readFile(listPath, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean);
}

// Everything a first public commit would carry: tracked files plus untracked files that
// .gitignore does not exclude. This is deliberately wider than the tarball.
function committedFiles() {
  const read = (args) => execFileSync("git", ["-C", ROOT, "ls-files", "-z", ...args], { encoding: "utf8" }).split("\0").filter(Boolean);
  return [...new Set([...read([]), ...read(["--others", "--exclude-standard"])])].sort();
}

let packed = null;
async function pack() {
  if (packed) return packed;
  packed = await new Promise((resolve, reject) => {
    execFile("npm", ["pack", "--dry-run", "--json"], {
      cwd: ROOT, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" }
    }, (error, stdout) => {
      if (error) return reject(error);
      const start = stdout.indexOf("[");
      try { resolve(JSON.parse(stdout.slice(start))[0]); } catch (parseError) { reject(parseError); }
    });
  });
  return packed;
}

async function packedFiles() { return (await pack()).files.map((file) => file.path); }

test("pack manifest matches the publish allowlist", async () => {
  const files = await packedFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(file.startsWith("/")).toBe(false);
    expect(file.split("/").includes("..")).toBe(false);
    expect(file.includes("\\")).toBe(false);
    const allowedPath = ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) || (!file.includes("/") && ALLOWED_ROOT_FILES.has(file));
    if (!allowedPath) throw new Error(`file outside the publish allowlist: ${file}`);
  }
  for (const required of REQUIRED) expect(files).toContain(required);
}, 60_000);

test("pack manifest carries no test, fixture, design record or .claude trace", async () => {
  const files = await packedFiles();
  const offenders = files.filter((file) => DENY_PATH.some((pattern) => pattern.test(file)));
  expect(offenders).toEqual([]);
}, 60_000);

test("every packed path is a regular non-symlink file with a scannable extension", async () => {
  const files = await packedFiles();
  const bad = [];
  for (const file of files) {
    const stat = await fsp.lstat(path.join(ROOT, file));
    if (!stat.isFile() || stat.isSymbolicLink()) bad.push(`${file}: not a regular file`);
    if (!TEXT.test(file) && !ALLOWED_ROOT_FILES.has(file) && file !== SIGNED_IMAGE) bad.push(`${file}: unscannable file type in the tarball`);
  }
  expect(bad).toEqual([]);
}, 60_000);

test("packed content leaks no home path, live identifier, secret or internal name", async () => {
  const files = await packedFiles();
  const denyTerms = await operatorDenyTerms();
  const offenders = [];
  for (const file of files) offenders.push(...scanBody(file, await scannableText(file), { denyTerms }));
  expect(offenders).toEqual([]);
}, 60_000);

test("every committed file is scanned, not only the packed ones", async () => {
  const files = committedFiles();
  const packedSet = new Set(await packedFiles());
  expect(files.length).toBeGreaterThan(packedSet.size);
  const denyTerms = await operatorDenyTerms();
  const offenders = [];
  const outsideTarball = [];
  for (const file of files) {
    if (!packedSet.has(file)) outsideTarball.push(file);
    let raw;
    try { raw = await scannableText(file); } catch (error) { offenders.push(`${file}: unreadable (${error.code ?? error.message})`); continue; }
    offenders.push(...scanBody(file, raw, { denyTerms }));
  }
  expect(offenders).toEqual([]);
  // The point of this test is the delta: files that ship in git but not in the tarball.
  expect(outsideTarball.length).toBeGreaterThan(0);
  for (const packedPath of packedSet) expect(files).toContain(packedPath);
}, 60_000);

test("the leak scanner detects every class it claims to detect", () => {
  const home = os.homedir();
  const cases = [
    ["literal home path", `state lives in ${home}/Library`],
    ["another account home", ["", "Users", "someone-else", "notes.txt"].join("/")],
    ["non ascii account home", ["", "Users", "\uD64D\uAE38\uB3D9", "notes.txt"].join("/")],
    ["openai key", `sk-${"A".repeat(24)}`],
    ["github classic token", `ghp_${"A".repeat(24)}`],
    ["github fine grained token", `github_pat_${"A".repeat(30)}`],
    ["github oauth token", `gho_${"A".repeat(24)}`],
    ["gitlab token", `glpat-${"A".repeat(20)}`],
    ["npm token", `npm_${"A".repeat(36)}`],
    ["google api key", `AIza${"A".repeat(35)}`],
    ["slack token", `xoxb-${"1".repeat(16)}`],
    ["aws access key", `AKIA${"A".repeat(16)}`],
    ["private key header", `-----BEGIN RSA ${"PRIVATE"} KEY-----`],
    ["json web token", `eyJ${"a".repeat(24)}.${"b".repeat(16)}`],
    ["bearer credential", `Bearer ${"a".repeat(24)}`],
    ["email address", ["someone", "example.invalid"].join("@")],
    ["uuid outside the fixture band", ["20000000", "0000", "4000", "8000", "000000000001"].join("-")],
    ["internal product name", "JW" + "A"],
    // Split so this file does not itself carry a string an operator deny list would flag.
    ["worktree trace", [".claude", ["work", "trees"].join(""), "somewhere"].join("/")],
    ["zero width character", `a${"\u200B"}b`],
    ["bidirectional control", `a${"\u202E"}b`],
    ["decomposed hangul", "\uAC00".normalize("NFD")],
    // the same classes again, written as character references. Every literal here is split so
    // that decoding this file does not produce the thing it bans.
    ["email behind a decimal reference", ["someone", "&#64;", "example.invalid"].join("")],
    ["secret behind a hex reference", ["sk", "&#x2D;", "A".repeat(24)].join("")],
    ["uuid behind decimal references", ["20000000", "&#45;", "0000", "&#45;", "4000", "&#45;", "8000", "&#45;", "000000000001"].join("")],
    ["home path behind a named reference", ["", "Users", "someone-else", "notes.txt"].join("&sol;")],
    ["zero width character behind a named reference", ["a", "&", "ZeroWidthSpace;b"].join("")],
    ["internal name behind a decimal reference", ["JW", "&#65;"].join("")],
    // a reference has no length limit, so a digit counter is not a gate
    ["email behind a padded decimal reference", ["someone", "&#00000064;", "example.invalid"].join("")]
  ];
  const missed = cases.filter(([, body]) => scanBody("probe.txt", body).length === 0).map(([label]) => label);
  expect(missed).toEqual([]);
  expect(scanBody("probe.txt", "a neutral line with /path/to/project and /Users/example/project\n")).toEqual([]);
});

test("an operator deny list is read from a file and changes the outcome", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-deny-"));
  try {
    const listPath = path.join(dir, "deny.txt");
    await fsp.writeFile(listPath, "\nNorthwind Traders\n\n  Contoso  \n");
    const terms = await operatorDenyTerms(listPath);
    expect(terms).toEqual(["Northwind Traders", "Contoso"]);
    const body = "the customer is northwind traders";
    expect(scanBody("probe.txt", body, { denyTerms: [] })).toEqual([]);
    expect(scanBody("probe.txt", body, { denyTerms: terms })).not.toEqual([]);
    expect(scanBody("probe.txt", "no customer named here", { denyTerms: terms })).toEqual([]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("an operator deny list, when supplied, is not empty", async () => {
  const terms = await operatorDenyTerms();
  if (process.env.CLAUDE_PEER_MCP_DENY_TERMS) expect(terms.length).toBeGreaterThan(0);
  else expect(terms).toEqual([]);
});

// One picture ships and it is the signed one. Everything else is kept out by name and by
// content, and the signed one is only allowed while its bytes are the bytes that were signed.
test("no image ships anywhere except the signed screenshot", async () => {
  const offenders = [];
  for (const file of committedFiles()) {
    let bytes;
    try { bytes = await fsp.readFile(path.join(ROOT, file)); } catch (error) { offenders.push(`${file}: unreadable (${error.code})`); continue; }
    offenders.push(...imageOffenders(file, bytes));
  }
  expect(offenders).toEqual([]);
}, 60_000);

test("every signed leak exception is still needed", async () => {
  const files = committedFiles();
  const denyTerms = await operatorDenyTerms();
  for (const file of files) {
    try { scanBody(file, await scannableText(file), { denyTerms }); } catch {}
  }
  const declared = [...ALLOWED_LEAK_DIGESTS].flatMap(([file, hashes]) => [...hashes].map((hash) => `${file}:${hash}`));
  const stale = declared.filter((entry) => !usedDigests.has(entry));
  expect(stale).toEqual([]);
}, 60_000);

test("pack reports a stable size and shasum", async () => {
  const report = await pack();
  expect(report.name).toBe("claude-peer-mcp");
  expect(typeof report.shasum).toBe("string");
  expect(report.shasum).toHaveLength(40);
  expect(report.size).toBeGreaterThan(0);
  expect(await Bun.file(path.join(ROOT, report.filename)).exists()).toBe(false);
}, 60_000);

test("a signed exception covers one matched string, not the rest of the file", () => {
  const signed = ["Bearer", "abcdefghijklmnop"].join(" ");
  const later = ["Bearer", "z".repeat(24)].join(" ");
  const other = `sk-${"Q".repeat(24)}`;
  expect(scanBody("test/mcp.test.mjs", signed)).toEqual([]);
  expect(scanBody("test/mcp.test.mjs", `${signed} and then ${later}`)).not.toEqual([]);
  expect(scanBody("test/mcp.test.mjs", `${signed}\nfurther down the same file ${later}`)).not.toEqual([]);
  expect(scanBody("test/mcp.test.mjs", `${signed} and then ${other}`)).not.toEqual([]);
  expect(scanBody("some/other/file.mjs", signed)).not.toEqual([]);
});

// Every literal here is assembled from fragments for the same reason the secret patterns are:
// this file is scanned by the gate it defines, and a gate that flags itself gets switched off.
const PICTURE = {
  header: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]),
  base64Uri: () => `![shot](${["data:image", "png;base64,iVBORw0KGgoAAAANSUhEUg=="].join("/")})`,
  svgTag: () => `<${"svg"} xmlns="http://www.w3.org/2000/svg"></${"svg"}>`,
  encodedUri: () => `![shot](${["data:image", `svg+xml,${"%3"}Csvg%20width%3D%228%22%3E${"%3"}C/svg%3E`].join("/")})`,
  // The same three pictures written the way a renderer reads them and a byte scan does not.
  decimalReference: () => `<${"img"} src="${["data:", "&#105;", "mage/png;base64,iVBORw0KGgoAAAANSUhEUg=="].join("")}">`,
  hexReference: () => `![shot](${["data:", "&#x69;", "mage/gif;base64,R0lGODlhAQABAAAAACw="].join("")})`,
  namedReference: () => `${"&lt;"}${"svg"} xmlns="x"${"&gt;"}${"&lt;"}/${"svg"}${"&gt;"}`,
  doubleEncoded: () => `${["&amp;", "#105;"].join("")}mage/png;base64,iVBORw0KGgo=`,
  // The same picture again, past the two things a one pass decoder still got wrong. A character
  // reference has no length limit, so leading zeros walk a digit counter off the end of what it
  // will look at; and a url parser removes ascii tab and newline before it resolves, so a
  // reference that expands to either of those splits the scheme for a byte scan and for nobody
  // else. Assembled from fragments for the same reason as the rest of this table.
  paddedDecimalReference: () => `<${"img"} src="${["data:", "&#00000105;", "mage/png;base64,iVBORw0KGgoAAAANSUhEUg=="].join("")}">`,
  paddedHexReference: () => `![shot](${["data:", "&#x00000069;", "mage/png;base64,iVBORw0KGgoAAAANSUhEUg=="].join("")})`,
  tabbedReference: () => `<${"img"} src="${["data:im", "&Tab;", "age/png;base64,iVBORw0KGgoAAAANSUhEUg=="].join("")}">`,
  newlineReference: () => `![shot](${["data:im", "&#10;", "age/png;base64,iVBORw0KGgoAAAANSUhEUg=="].join("")})`
};
const FAR_IN = "filler line, and nothing to see\n".repeat(4096);   // ~128 KiB before the payload

test("the image gate looks at bytes, not only at the file extension", () => {
  expect(imageOffenders("docs/notes.txt", PICTURE.header())).not.toEqual([]);
  expect(imageOffenders("docs/round-trip.png", Buffer.from("not a picture at all"))).not.toEqual([]);
  expect(imageOffenders("docs/demo-ack.md", Buffer.from(PICTURE.base64Uri()))).not.toEqual([]);
  expect(imageOffenders("docs/logo.txt", Buffer.from(PICTURE.svgTag()))).not.toEqual([]);
  expect(imageOffenders("docs/demo-ack.md", Buffer.from("a sanitized text transcript\n"))).toEqual([]);
});

// The three ways the gate was got past.
test("the image gate reads past the first 64 KiB and past base64", () => {
  expect(Buffer.byteLength(FAR_IN)).toBeGreaterThan(64 * 1024);
  expect(imageOffenders("docs/long.md", Buffer.from(`${FAR_IN}${PICTURE.base64Uri()}\n`))).toEqual(["docs/long.md: embedded image data uri"]);
  expect(imageOffenders("docs/long.md", Buffer.from(`${FAR_IN}${PICTURE.svgTag()}\n`))).toEqual(["docs/long.md: inline vector image"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.encodedUri()}\n`))).toEqual([
    "docs/short.md: embedded image data uri", "docs/short.md: url encoded vector image"
  ]);
  // and the gate still says nothing about text that only talks about pictures
  expect(imageOffenders("docs/notes.md", Buffer.from(`${FAR_IN}no picture ships with this page\n`))).toEqual([]);
});

// The fourth way past it: a character reference is not decoration. A browser and a markdown
// renderer both resolve &#105; to "i", so the tag is an image by the time anyone sees it while
// the raw bytes say nothing that matches. Decoding is one pass, the way a parser does it, so
// text that renders as "&#105;" is still not a picture.
test("the image gate resolves html character references before it looks", () => {
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.decimalReference()}\n`))).toEqual(["docs/short.md: embedded image data uri"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.hexReference()}\n`))).toEqual(["docs/short.md: embedded image data uri"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.namedReference()}\n`))).toEqual(["docs/short.md: inline vector image"]);
  expect(imageOffenders("docs/long.md", Buffer.from(`${FAR_IN}${PICTURE.decimalReference()}\n`))).toEqual(["docs/long.md: embedded image data uri"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.doubleEncoded()}\n`))).toEqual([]);
  expect(imageOffenders("docs/notes.md", Buffer.from("a page that mentions R&D and A&B and nothing else\n"))).toEqual([]);
});

// The fifth and sixth ways past it, found by re reading the decoder rather than the pictures: a
// digit limit that a padded reference walks off, and a url whose own whitespace is not the
// document's. Both end at the same bytes a browser renders.
test("the image gate reads a padded character reference and a url split by its own whitespace", () => {
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.paddedDecimalReference()}\n`))).toEqual(["docs/short.md: embedded image data uri"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.paddedHexReference()}\n`))).toEqual(["docs/short.md: embedded image data uri"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.tabbedReference()}\n`))).toEqual(["docs/short.md: embedded image data uri"]);
  expect(imageOffenders("docs/short.md", Buffer.from(`${PICTURE.newlineReference()}\n`))).toEqual(["docs/short.md: embedded image data uri"]);
  expect(imageOffenders("docs/long.md", Buffer.from(`${FAR_IN}${PICTURE.tabbedReference()}\n`))).toEqual(["docs/long.md: embedded image data uri"]);
  // and a tab or a newline between ordinary words is still nothing at all
  expect(imageOffenders("docs/notes.md", Buffer.from("a page\twith a tab\nand a newline and no picture\n"))).toEqual([]);
});

test("the signed screenshot is signed for its content, not only for its name", async () => {
  const shipped = await fsp.readFile(path.join(ROOT, SIGNED_IMAGE));
  expect(imageOffenders(SIGNED_IMAGE, shipped)).toEqual([]);
  expect(imageOffenders(SIGNED_IMAGE, Buffer.concat([shipped, Buffer.from("\n")]))).toEqual([`${SIGNED_IMAGE}: the signed screenshot is not the bytes that were signed`]);
  expect(imageOffenders("docs/other.png", shipped)).not.toEqual([]);
  const contributing = await fsp.readFile(path.join(ROOT, "CONTRIBUTING.md"), "utf8");
  expect(contributing).toContain(SIGNED_IMAGE);
});
