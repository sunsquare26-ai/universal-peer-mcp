import path from "node:path";
import { execFileSync } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ARGC = 4096;
const WORD_BYTES = 8;
const system = dlopen("/usr/lib/libSystem.B.dylib", {
  sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.usize], returns: FFIType.i32 }
});

export function processStart(pid = process.pid) {
  assertPid(pid);
  const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  if (!value) throw new Error("process start unavailable");
  return value.replace(/\s+/g, " ");
}

export function processUid(pid = process.pid) {
  assertPid(pid);
  const value = Number(execFileSync("ps", ["-p", String(pid), "-o", "uid="], { encoding: "utf8" }).trim());
  if (!Number.isInteger(value)) throw new Error("process uid unavailable");
  return value;
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
  if (argv[0] !== executable) throw new Error("target argv executable mismatch");
  return argv;
}

export function provePermissionMode(expected, pid, procStart, reader = readProcessArgv, startReader = processStart) {
  if (!["prompting", "bypass"].includes(expected)) throw new Error("unsupported expected permission mode");
  if (startReader(pid) !== procStart) throw new Error("target identity changed before argv proof");
  const argv = reader(pid);
  if (startReader(pid) !== procStart) throw new Error("target identity changed during argv proof");
  const positions = [];
  argv.forEach((value, index) => { if (value === "--permission-mode") positions.push(index); });
  if (positions.length > 1 || (positions.length === 1 && positions[0] + 1 >= argv.length)) throw new Error("ambiguous permission mode argv");
  const raw = positions.length ? argv[positions[0] + 1] : null;
  const mapped = raw === "bypassPermissions" ? "bypass" : ["default", "plan", "acceptEdits", "auto"].includes(raw) ? "prompting" : null;
  if (mapped === null) throw new Error("permission mode argv cannot be proven");
  if (mapped !== expected) throw new Error("permission mode mismatch");
  return { mode: mapped, verifiedBy: "kern_procargs2" };
}

export function redactArgv() { return "[argv redacted]"; }

function readKernelInt(values) {
  const mib = new Int32Array(values); const output = new Int32Array(1); const size = new BigUint64Array([4n]);
  if (system.symbols.sysctl(ptr(mib), mib.length, ptr(output), ptr(size), null, 0) !== 0 || size[0] !== 4n) throw new Error("kernel query unavailable");
  return output[0];
}
function assertPid(pid) { if (!Number.isInteger(pid) || pid <= 1 || pid > 0x7fffffff) throw new Error("invalid pid"); }
