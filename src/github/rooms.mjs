import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertPrivateFile, atomicPrivateWrite } from "../core/state-paths.mjs";

// M6: the owner's room table, <state>/github-rooms.json (0600). Written by `universal-peer-mcp github
// link|remote` from the owner's terminal, read by the daemon before every poll. Nothing in a comment
// can add a room, an endpoint or an API path: the bridge reads and writes only what this names.
//
// {
//   "rooms":   { "<room>": { "host": "github.com", "repo": "owner/name", "repoId": 123, "number": 5, "kind": "pull"|"issue", "epoch": 1 } },
//   "remotes": { "<alias>": { "room": "<room>", "epoch": 1, "wake": "@codex"|"relay"|null } }
// }
//
// A remote is a logical endpoint in one room, not a session: GitHub cannot tell two sessions of one
// account apart, so `from=<remote>` is a claim the room's members can make (weak identity, stated in
// docs/github-transport.md). `epoch` changes when the owner re-points a room or a remote; mail bound
// to an older epoch is not routed to the new one.
export const ROOMS_FILE = "github-rooms.json";
const NAME = /^[a-z][a-z0-9-]{1,47}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
// "@codex": a wake line in the comment. "relay": no wake line; the owner is alerted that a message
// waits for that remote, and passes it on by hand (measured 2026-10-08: @codex did not start a task
// on the owner's account, and its "create an environment" replies woke every subscriber of the room).
const WAKES = new Set(["@codex", "relay"]);
const fail = (code, message) => Object.assign(new Error(message), { code });

export function roomsPath(root) { return path.join(root, ROOMS_FILE); }

export function validateRooms(table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) throw fail("INVALID_ROOMS", "the room table must be an object");
  const rooms = table.rooms ?? {}; const remotes = table.remotes ?? {};
  for (const [name, r] of Object.entries(rooms)) {
    if (!NAME.test(name) || r?.host !== "github.com" || !REPO.test(r?.repo ?? "") || !Number.isInteger(r?.repoId) || !Number.isInteger(r?.number) || r.number < 1 || !["pull", "issue"].includes(r?.kind) || !Number.isInteger(r?.epoch) || r.epoch < 1) throw fail("INVALID_ROOMS", `room ${name} is malformed`);
  }
  for (const [alias, e] of Object.entries(remotes)) {
    if (!NAME.test(alias) || !Object.hasOwn(rooms, e?.room ?? "") || !Number.isInteger(e?.epoch) || e.epoch < 1 || (e?.wake !== null && e?.wake !== undefined && !WAKES.has(e.wake))) throw fail("INVALID_ROOMS", `remote ${alias} is malformed`);
  }
  return { rooms, remotes };
}

export async function loadRooms(root) {
  const file = roomsPath(root);
  try { await assertPrivateFile(file, { maxBytes: 64 * 1024 }); }
  catch (error) { if (error?.code === "ENOENT") return { rooms: {}, remotes: {} }; throw error; }
  return validateRooms(JSON.parse(await fsp.readFile(file, "utf8")));
}
export function loadRoomsSync(root) {
  const file = roomsPath(root);
  try { const st = fs.lstatSync(file); if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw fail("INVALID_ROOMS", "github-rooms.json must be a private file"); }
  catch (error) { if (error?.code === "ENOENT") return { rooms: {}, remotes: {} }; throw error; }
  return validateRooms(JSON.parse(fs.readFileSync(file, "utf8")));
}
export async function saveRooms(root, table) { validateRooms(table); await atomicPrivateWrite(roomsPath(root), `${JSON.stringify(table, null, 2)}\n`); }

// The routing answer for an alias: a remote endpoint of a linked room, or null.
// A room instance: the repository's numeric id, the issue/PR number and the room's epoch. Every
// durable row of the bridge carries it, so re-linking a room name to another repository or PR (or the
// same one again) never carries old mail, acks, answers or cursors into the new one.
export function roomInstance(room) { return `${room.repoId}:${room.number}:${room.epoch}`; }
export function remoteOf(table, alias) {
  const e = table?.remotes?.[alias]; if (!e) return null;
  const room = table.rooms[e.room];
  return { alias, room: e.room, instance: roomInstance(room), epoch: e.epoch, roomEpoch: room.epoch, wake: e.wake ?? null, repo: room.repo, repoId: room.repoId, number: room.number, kind: room.kind };
}
