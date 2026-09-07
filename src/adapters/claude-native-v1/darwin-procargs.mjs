import { execFileSync } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { provenPermission } from "../../core/target-config.mjs";

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ARGC = 4096;
const WORD_BYTES = 8;
const system = dlopen("/usr/lib/libSystem.B.dylib", {
  sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.usize], returns: FFIType.i32 }
});

// A start time is a kernel fact, but `ps` hands it over as a rendering, and two processes that
// render the same fact differently agree about nothing. Four things decide that rendering and all
// four are nailed down here, because each one was measured breaking a comparison on this machine.
// The program: `ps` off PATH is whatever PATH says it is, so it is named by absolute path — a
// planted `ps` answered "Thu Jan  1 00:00:00 1970" and a uid of 4294967290, and both were
// believed. The zone: `ps` prints lstart through the reader's own zone while Claude Code records
// the UTC one, so every registry row read nine hours away from its recorded value and the product
// had never resolved a session on any machine that is not on UTC; UTC0 is the offset itself and
// needs no zone database entry to resolve, where the name UTC does. The locale: LC_TIME decides
// the month and day names and even their order — de_DE renders "Mo.  7 Sep. 08:16:23 2026" and
// ko_KR renders "2026년  9월  7일 월요일 08시 16분 23초" — so a Korean account compared Korean
// text against Claude Code's English text, forever. The padding: `ps` pads a single digit day to
// two columns, "Mon Sep  7", so the same instant is one character longer on the first nine days of
// every month; that is squeezed on both sides of every comparison by normalizeProcStart, the only
// place the squeeze is written. What comes back is then held against the one shape this build
// knows how to compare. The fact still comes from the kernel by way of ps; only its rendering is
// nailed down, and a rendering this build does not recognise is refused instead of compared.
const PS = "/bin/ps";
const psOptions = () => ({ encoding: "utf8", env: { ...process.env, TZ: "UTC0", LC_ALL: "C" } });
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const UID = /^\d{1,10}$/;

// The name of the rendering above. It travels with every durable identity snapshot, because a
// start time on disk is a string and nothing in the string says which build rendered it.
export const PROC_START_RENDERING = "utc0-c-squeezed";

// The one place a rendered start time is put in the form the comparisons use. A value that is
// not a string is not a rendering and is never coerced into looking like one: an array of one
// string stringifies to that string, and a registry row is a file anyone with the account can
// write.
export function normalizeProcStart(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

// The boundary between "ps printed something" and "this is a start time". Empty output, a
// truncated line, two lines, another locale's spelling: none of those are the rendering the
// comparisons are written against, and comparing them anyway is how a mismatch becomes silent.
export function renderedProcStart(value) {
  const rendering = normalizeProcStart(value);
  if (!LSTART.test(rendering)) throw new Error("process start unavailable");
  return rendering;
}

function renderedUid(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UID.test(text)) throw new Error("process uid unavailable");
  return Number(text);
}

export function processStart(pid = process.pid) {
  assertPid(pid);
  return renderedProcStart(execFileSync(PS, ["-ww", "-p", String(pid), "-o", "lstart="], psOptions()));
}

export function processUid(pid = process.pid) {
  assertPid(pid);
  return renderedUid(execFileSync(PS, ["-ww", "-p", String(pid), "-o", "uid="], psOptions()));
}

// uid and start time of one pid in a single fork. The receiver reads an identity for every
// frame, so the cost of that read is on the path of every message: two ps calls per read
// measured 2.22 ms on this machine and, because execFileSync blocks the loop, that delay is
// paid by every other connection waiting to be handled. One call halves it. The output is
// "  501 Mon Sep  7 13:34:59 2026": the uid, then lstart, which itself carries spaces. It is
// rendered in the same pinned zone as processStart, because the resolver and the receiver
// compare their two reads against one another.
export function processIdentity(pid = process.pid) {
  assertPid(pid);
  const raw = execFileSync(PS, ["-ww", "-p", String(pid), "-o", "uid=,lstart="], psOptions());
  const match = /^(\d{1,10})\s+(\S.*)$/.exec(typeof raw === "string" ? raw.trim() : "");
  if (!match) throw new Error("process identity unavailable");
  return { uid: renderedUid(match[1]), procStart: renderedProcStart(match[2]) };
}

export function readProcessArgv(pid) {
  assertPid(pid);
  const argmax = readKernelInt([CTL_KERN, KERN_ARGMAX]);
  if (!Number.isInteger(argmax) || argmax < 4096 || argmax > MAX_BYTES) throw new Error("target argv unavailable");
  const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
  const bytes = new Uint8Array(argmax);
  const size = new BigUint64Array([BigInt(argmax)]);
  if (system.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(size), null, 0) !== 0) throw new Error("target argv unavailable");
  const used = Number(size[0]);
  if (!Number.isSafeInteger(used) || used < 5 || used > argmax) throw new Error("target argv unavailable");
  return parseProcArgs(bytes.subarray(0, used));
}

export function parseProcArgs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > MAX_BYTES) throw new Error("target argv unavailable");
  const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
  if (!Number.isInteger(argc) || argc < 1 || argc > MAX_ARGC) throw new Error("target argv unavailable");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const execEnd = bytes.indexOf(0, 4);
  if (execEnd <= 4) throw new Error("target argv unavailable");
  const executable = decoder.decode(bytes.subarray(4, execEnd));
  const usedForExec = execEnd - 4 + 1;
  const argvStart = 4 + Math.ceil(usedForExec / WORD_BYTES) * WORD_BYTES;
  if (argvStart >= bytes.length) throw new Error("target argv unavailable");
  for (let index = execEnd + 1; index < argvStart; index += 1) if (bytes[index] !== 0) throw new Error("target argv unavailable");
  let cursor = argvStart;
  const argv = [];
  for (let index = 0; index < argc; index += 1) {
    const end = bytes.indexOf(0, cursor);
    if (end < cursor || end - cursor > 256 * 1024) throw new Error("target argv unavailable");
    argv.push(decoder.decode(bytes.subarray(cursor, end)));
    cursor = end + 1;
  }
  // Two strings come out of KERN_PROCARGS2 and this build requires them to be the same string.
  // The kernel writes the path handed to execve at the head of the buffer and whoever called
  // exec writes argv[0], so the equality is two things at once. It is an identity check — a
  // process that renamed itself is refused — and it is a layout check: the measured layout puts
  // argv[0] at the first eight-byte boundary after the exec path and its zero padding, and when
  // this build's idea of that boundary is wrong the read starts inside the padding and the first
  // string comes back empty, which no exec path ever equals. An attempt to drop the equality on
  // 2026-09-07 removed the second job with the first and is not in this build; the price of
  // keeping it is that a session started off PATH — argv ["claude", ...] against exec path
  // ~/.local/bin/claude — cannot be a target, which is recorded in docs/known-issues.md.
  if (argv[0] !== executable) throw new Error("target argv executable mismatch");
  return argv;
}

// The mode comes from one place: the kernel's copy of the arguments the process was executed
// with. There is no second source and no default — a session whose argv does not carry
// --permission-mode does not resolve, which is what a session resumed with `claude --resume`
// hits, and that is recorded in docs/known-issues.md rather than answered with a guess. The
// start time is read on both sides of the argv read so a pid that was recycled mid-proof is
// caught, and both sides are squeezed by normalizeProcStart because the caller's copy came off
// disk and this one came off ps.
export function provePermissionMode(expected, pid, procStart, reader = readProcessArgv, startReader = processStart) {
  if (!["prompting", "bypass"].includes(expected)) throw new Error("unsupported expected permission mode");
  const held = normalizeProcStart(procStart);
  if (!held) throw new Error("target identity is unrenderable");
  if (normalizeProcStart(startReader(pid)) !== held) throw new Error("target identity changed before argv proof");
  const argv = reader(pid);
  if (!Array.isArray(argv) || argv.length < 1 || argv.some((value) => typeof value !== "string")) throw new Error("target argv unavailable");
  if (normalizeProcStart(startReader(pid)) !== held) throw new Error("target identity changed during argv proof");
  const positions = [];
  argv.forEach((value, index) => { if (value === "--permission-mode") positions.push(index); });
  if (positions.length > 1 || (positions.length === 1 && positions[0] + 1 >= argv.length)) throw new Error("ambiguous permission mode argv");
  const raw = positions.length ? argv[positions[0] + 1] : null;
  const mapped = raw === "bypassPermissions" ? "bypass" : ["default", "plan", "acceptEdits", "auto"].includes(raw) ? "prompting" : null;
  if (mapped === null) throw new Error("permission mode argv cannot be proven");
  if (mapped !== expected) throw new Error("permission mode mismatch");
  return provenPermission(mapped);
}

export function redactArgv() { return "[argv redacted]"; }

function readKernelInt(values) {
  const mib = new Int32Array(values); const output = new Int32Array(1); const size = new BigUint64Array([4n]);
  if (system.symbols.sysctl(ptr(mib), mib.length, ptr(output), ptr(size), null, 0) !== 0 || size[0] !== 4n) throw new Error("kernel query unavailable");
  return output[0];
}
function assertPid(pid) { if (!Number.isInteger(pid) || pid <= 1 || pid > 0x7fffffff) throw new Error("invalid pid"); }
