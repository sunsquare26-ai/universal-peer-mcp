import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STATE_DIR_ENV = "UNIVERSAL_PEER_MCP_STATE_DIR";
// The name this variable had before the package was renamed. It is still read, and it has to be:
// the installs that carry it are configuration files on other machines, and a variable that
// stops being read does not fail loudly. The process comes up on the default directory, finds no
// target table there, advertises no alias and answers `daemon_status` exactly as a clean install
// does — the whole installation looks healthy and is pointed somewhere else. Reading the old name
// is the entire compatibility: nothing else in this package answers to it.
export const LEGACY_STATE_DIR_ENV = "CLAUDE_PEER_MCP_STATE_DIR";
export const LEGACY_STATE_DIR_WARNING = `${LEGACY_STATE_DIR_ENV} is the old name of ${STATE_DIR_ENV}; it is still read, and will stop being read in a later version — rename it where your MCP client sets it`;

// The default directory keeps the old package's name, deliberately. A variable can be read under
// two names at once; a directory cannot be in two places at once. Moving this one would leave an
// existing append-only ledger where nothing looks for it while the new location comes up looking
// exactly like a fresh install — the same silent miss the variable above is read to prevent, with
// no second name to catch it. Renaming it is a separate change with a migration attached.
const DEFAULT_ROOT = path.join(os.homedir(), "Library", "Application Support", "claude-peer-mcp");

// An empty value is an unset value, not an override: `??` would resolve "" to the process
// working directory and put state, and a 0700 chmod, inside whatever folder the caller is in.
function configured(value) { return typeof value === "string" && value !== "" ? value : null; }

// Which name the state directory was read from, and only that: it reads no file and writes
// nothing, so `doctor` can ask the same question the daemon asked without answering it twice.
export function resolveStateDirEnv(environment = process.env) {
  const current = configured(environment[STATE_DIR_ENV]);
  const legacy = configured(environment[LEGACY_STATE_DIR_ENV]);
  // Two names for one directory is nothing to report. Two names for two directories is not a
  // choice to make quietly: whichever this process picked, the rest of the installation is on the
  // one it did not pick, and a ledger that ends up split across two directories cannot be put
  // back together afterwards. Comparison is on the resolved path, because that is the value that
  // decides where the state actually lands.
  if (current !== null && legacy !== null && path.resolve(current) !== path.resolve(legacy)) {
    throw new Error(`${STATE_DIR_ENV} and ${LEGACY_STATE_DIR_ENV} name two different state directories; unset ${LEGACY_STATE_DIR_ENV}`);
  }
  if (current !== null) return { root: current, source: STATE_DIR_ENV, deprecated: false, warning: null };
  if (legacy !== null) return { root: legacy, source: LEGACY_STATE_DIR_ENV, deprecated: true, warning: LEGACY_STATE_DIR_WARNING };
  return { root: null, source: "default", deprecated: false, warning: null };
}

// Once per process. `statePaths` is called per control request, and a deprecation notice repeated
// on every one of them is a notice nobody reads.
let warned = false;
function warnOnce(message) { if (warned) return; warned = true; process.stderr.write(`${message}\n`); }

export function stateRootFromEnvironment(environment = process.env, warn = warnOnce) {
  const resolution = resolveStateDirEnv(environment);
  if (resolution.warning !== null) warn(resolution.warning);
  return resolution.root ?? undefined;
}

export function statePaths(root = stateRootFromEnvironment()) {
  const absolute = path.resolve(root || DEFAULT_ROOT);
  return {
    root: absolute,
    events: path.join(absolute, "events.jsonl"),
    owner: path.join(absolute, "owner.json"),
    controlSocket: path.join(absolute, "control.sock"),
    controlToken: path.join(absolute, "control.token"),
    daemon: path.join(absolute, "daemon.json"),
    daemonLock: path.join(absolute, "daemon.lock"),
    targets: path.join(absolute, "targets.json")
  };
}

export async function ensurePrivateDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("state directory must be an owned 0700 directory");
  }
  const real = await fsp.realpath(directory);
  if (real !== path.resolve(directory)) throw new Error("state directory must not traverse a symbolic link");
}

export async function assertPrivateFile(file, { maxBytes = 1024 * 1024 } = {}) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
    throw new Error("state file must be an owned private regular file");
  }
  return stat;
}

export async function atomicPrivateWrite(file, content) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temp, file);
  const directory = await fsp.open(path.dirname(file), fs.constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
