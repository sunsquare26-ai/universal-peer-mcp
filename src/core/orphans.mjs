import fsp from "node:fs/promises";
import path from "node:path";
import { INBOUND_DIRNAME } from "./state-paths.mjs";
import { ORPHAN_LIST } from "./posts.mjs";

// Inbound body files no ledger row names (review [중], M2): a spool write whose row was never
// appended. Nothing else — retention, disposal, alerts — can find such a file, because all of them
// start from a row. So they are swept here, at startup and in maintenance.
//
// Swept means moved, not deleted: into `inbound-orphans/`, 0700, beside the spool, with one ledger
// row and one alarm per sweep that found any. A file younger than `graceMs` is left alone, because a
// live write spools first and appends second. The recovery list written by a failed discard is
// consumed here too.
export const ORPHAN_DIRNAME = "inbound-orphans";
const NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}\.txt$/;

export async function sweepOrphanBodies({ root, store, alerts = null, now = Date.now(), graceMs = 10 * 60 * 1000 }) {
  const inbound = path.join(root, INBOUND_DIRNAME);
  let names; try { names = await fsp.readdir(inbound); } catch (error) { if (error?.code === "ENOENT") return { moved: 0 }; throw error; }
  const referenced = new Set(store.events.filter((e) => typeof e.bodyFile === "string").map((e) => e.bodyFile));
  const target = path.join(root, ORPHAN_DIRNAME);
  const listed = new Set();
  try { for (const line of (await fsp.readFile(path.join(root, ORPHAN_LIST), "utf8")).split("\n")) { try { const n = path.basename(JSON.parse(line).bodyFile ?? ""); if (n) listed.add(n); } catch {} } } catch {}
  const moved = [];
  for (const name of names) {
    if (!NAME.test(name) || referenced.has(`${INBOUND_DIRNAME}/${name}`)) continue;
    const file = path.join(inbound, name);
    let stat; try { stat = await fsp.lstat(file); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (!listed.has(name) && graceMs > 0 && now - stat.mtimeMs < graceMs)) continue;
    await fsp.mkdir(target, { recursive: true, mode: 0o700 });
    await fsp.rename(file, path.join(target, name));
    moved.push({ name, bytes: stat.size });
  }
  await fsp.unlink(path.join(root, ORPHAN_LIST)).catch(() => {});
  if (moved.length === 0) return { moved: 0 };
  await store.append("inbound_orphans_moved", { count: moved.length, bytes: moved.reduce((n, m) => n + m.bytes, 0), directory: ORPHAN_DIRNAME }).catch(() => {});
  try { await alerts?.raise({ kind: "inbound_orphans", key: `inbound_orphans:${new Date(now).toISOString().slice(0, 13)}`, code: String(moved.length) }); } catch {}
  return { moved: moved.length };
}
