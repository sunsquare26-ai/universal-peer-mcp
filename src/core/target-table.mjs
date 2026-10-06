import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { loadTargets, targetTableDigest } from "./target-config.mjs";

const ABSENT = "absent";

// The operator's table, read at the moment it is needed rather than at the moment this process
// started.
//
// It used to be read once, at startup, and reduced to a digest that never moved again. Every call
// that can reach a target is refused unless the digest the caller checked equals the daemon's, and
// the caller — the server — reads the file per request. So the instant `targets.json` changed, the
// two digests disagreed and every send was refused until the daemon was restarted. That is the
// intended behaviour of the check and the wrong fixed point for it: what the check is for is that a
// message goes to the row the caller read, and the daemon's copy being older than the file serves
// nothing. Measured 2026-09-11: repairing an alias by hand took a restart, and the restart is what
// made repairing it expensive enough to leave broken.
//
// So the reading moves forward and the check keeps its meaning: the caller's digest is held against
// the table as it is now.
//
// Invalidation is a content hash, with the inode, size and mtime beside it. Size alone is a trap
// this file is written to avoid — a session id replaced by another session id is the same number of
// bytes, rewritten in place, and a cache that watched the size would have served the old table for
// ever while the file on disk said something else.
export class TargetTableWatch {
  constructor({ file, load = loadTargets, digest = targetTableDigest }) {
    this.file = file; this.load = load; this.digestOf = digest;
    this.fingerprint = null; this.table = {}; this.digest = digest({}); this.unreadable = null;
  }

  // One reading. `changed` says the bytes moved, `digestChanged` says the routing did — a table
  // reformatted or given a comment is the first without the second — and `unreadable` is a table
  // that is there and cannot be parsed, which is not the same as a table that is not there. When a
  // reading fails the last good table is kept and reported, because dropping to an empty table would
  // silently unpublish every alias; the caller's digest will not match it, so calls are refused
  // rather than misrouted.
  async read() {
    const observed = await this.#fingerprint();
    if (observed === this.fingerprint) {
      return { changed: false, digestChanged: false, table: this.table, digest: this.digest, previousDigest: this.digest, changedAliases: 0, unreadable: this.unreadable };
    }
    const previousTable = this.table; const previousDigest = this.digest;
    this.fingerprint = observed;
    if (observed !== ABSENT) {
      try { this.unreadable = null; this.table = await this.load(this.file); }
      catch (error) {
        this.unreadable = error;
        return { changed: true, digestChanged: false, table: previousTable, digest: previousDigest, previousDigest, changedAliases: 0, unreadable: error };
      }
    } else { this.unreadable = null; this.table = {}; }
    this.digest = this.digestOf(this.table);
    return {
      changed: true, digestChanged: this.digest !== previousDigest, table: this.table, digest: this.digest,
      previousDigest, changedAliases: countChangedAliases(previousTable, this.table), unreadable: null
    };
  }

  async #fingerprint() {
    try {
      const stat = await fsp.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) return `irregular:${stat.mode}:${stat.ino}`;
      // Hashed over the bytes, not over a string decoded from them: a decode replaces what it cannot
      // read with one replacement character, and two different files that both fail to decode would
      // hash alike.
      const bytes = await fsp.readFile(this.file);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    } catch (error) {
      // A table that is not there is a table with nothing in it — a fresh install, and the order
      // every install runs in. Any other failure to even look at it is a different absence and is
      // kept apart from it, because a daemon that answers "no targets" to both looks healthy while
      // pointed at nothing.
      if (error?.code === "ENOENT") return ABSENT;
      return `unreadable:${error?.code ?? "unknown"}:${Date.now()}`;
    }
  }
}

// How many aliases route somewhere else than they did. An alias added or removed counts, and so
// does one whose row moved; a row rewritten to the same five fields does not.
export function countChangedAliases(before, after) {
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  let changed = 0;
  for (const name of names) if (rowKey(before?.[name]) !== rowKey(after?.[name])) changed += 1;
  return changed;
}
function rowKey(row) {
  return row ? JSON.stringify([row.sessionId, row.cwd, row.expectedDisplayName ?? null, row.permissionMode]) : null;
}
