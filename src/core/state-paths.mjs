import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function statePaths(root = process.env.CLAUDE_PEER_MCP_STATE_DIR) {
  // An empty value is an unset value, not an override: `??` would resolve "" to the process
  // working directory and put state, and a 0700 chmod, inside whatever folder the caller is in.
  const absolute = path.resolve(root || path.join(os.homedir(), "Library", "Application Support", "claude-peer-mcp"));
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
