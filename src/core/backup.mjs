import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readManifests, verifyArchive, archiveNames } from "./archive.mjs";

// Copies of the closed daily copies to somewhere that is not the Mini's disk: the Air over SSH
// (`user@host:/path`) or a mounted external disk (`/Volumes/...`). Copies are made only of archives
// that verify; a destination file that exists with the same digest is left alone and one that
// exists with a different digest is reported, never overwritten.
const run = promisify(execFile);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const REMOTE = /^[A-Za-z0-9._-]+@?[A-Za-z0-9._-]*:\/[^\s'"`$;&|]*$/;

export async function backupArchives({ directory, destination, exec = run }) {
  if (typeof destination !== "string" || destination === "") return { configured: false };
  const manifests = await readManifests(directory);
  const days = [...manifests.keys()].sort();
  const invalid = [];
  for (const day of days) { const checked = await verifyArchive(directory, day); if (!checked.ok) invalid.push({ day, reason: checked.reason }); }
  const good = days.filter((day) => !invalid.some((x) => x.day === day));
  if (REMOTE.test(destination)) {
    // rsync with a fixed argv, no shell. --ignore-existing: a file already there is never replaced.
    const files = good.flatMap((day) => Object.values(archiveNames(day)));
    if (files.length === 0) return { configured: true, remote: true, copied: 0, invalid };
    try {
      await exec("/usr/bin/rsync", ["-a", "--ignore-existing", "--chmod=F600,D700", "-e", "ssh -o BatchMode=yes", ...files.map((f) => path.join(directory, f)), destination.endsWith("/") ? destination : `${destination}/`], { timeout: 120_000 });
      return { configured: true, remote: true, copied: files.length, invalid };
    } catch (error) {
      return { configured: true, remote: true, copied: 0, invalid, error: typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : "RSYNC_FAILED" };
    }
  }
  if (!path.isAbsolute(destination)) throw new Error("backup destination must be absolute or user@host:/path");
  const stat = await fsp.stat(destination).catch(() => null);
  if (!stat?.isDirectory()) return { configured: true, remote: false, copied: 0, invalid, error: "DESTINATION_MISSING" };
  let copied = 0; const conflicts = [];
  for (const day of good) {
    for (const name of Object.values(archiveNames(day))) {
      const source = await fsp.readFile(path.join(directory, name));
      const target = path.join(destination, name);
      const existing = await fsp.readFile(target).catch(() => null);
      if (existing) { if (sha256(existing) !== sha256(source)) conflicts.push(name); continue; }
      const temp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(temp, source, { mode: 0o600, flag: "wx" });
      await fsp.rename(temp, target);
      if (sha256(await fsp.readFile(target)) !== sha256(source)) conflicts.push(name); else copied += 1;
    }
  }
  return { configured: true, remote: false, copied, invalid, conflicts };
}
