import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This constant identifies the loaded release metadata, not every byte loaded by the runtime.
// Startup/current digests are observations of disk, never proof of loaded module bytes.
export const BUILD_ID = "20260930-m3-candidate-search";
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function sourceDigest(root = SOURCE_ROOT) {
  const rows = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error("source tree contains symbolic link");
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && item.name.endsWith(".mjs")) rows.push([path.relative(root, file).split(path.sep).join("/"), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
    }
  }
  walk(root); rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return crypto.createHash("sha256").update(rows.map(([file, hash]) => `${hash}  ${file}\n`).join("")).digest("hex");
}
export function observeBuild({ root = SOURCE_ROOT, buildId = BUILD_ID } = {}) {
  const startedAt = new Date().toISOString();
  const digest = () => { try { return sourceDigest(root); } catch { return null; } };
  const startupSourceDigest = digest();
  return () => {
    const currentSourceDigest = digest();
    return { buildId, startedAt, startupSourceDigest, currentSourceDigest,
      sourceChangedSinceStart: startupSourceDigest === null || currentSourceDigest === null ? null : startupSourceDigest !== currentSourceDigest };
  };
}
export function compareBuilds(server, daemon) {
  if (!server?.buildId || !daemon?.buildId || !server.startupSourceDigest || !daemon.startupSourceDigest) return null;
  return server.buildId !== daemon.buildId || server.startupSourceDigest !== daemon.startupSourceDigest;
}
