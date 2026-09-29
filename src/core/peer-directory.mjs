import fsp from "node:fs/promises";
import path from "node:path";
import { assertPrivateFile, atomicPrivateWrite } from "./state-paths.mjs";
import { sha256 } from "./dedupe.mjs";
import { plainObject, requireUuid, sameUuid } from "./limits.mjs";
import { serializeByFile } from "./target-config.mjs";

// M4: one directory of peers, two tables.
//
//   targets.json       Claude sessions (the operator's table every build reads; rows keep exactly
//                      the four fields older builds accept, so registering never makes the table
//                      unreadable to a build that is rolled back to).
//   codex-peers.json   Codex threads: { alias: { threadId, registeredAt } }. A separate file for the
//                      same reason — a `kind` field in targets.json would be refused by every
//                      earlier build and would unpublish every alias at once.
//
// An alias names exactly one session across both tables, and a session holds at most one alias,
// so routing is a lookup and never a choice. Both files are rewritten only here (and by the Claude
// succession, which changes one sessionId in place) under one queue, so two registrations cannot
// interleave their read-modify-write.
export const CODEX_PEERS_FILENAME = "codex-peers.json";
export const ALIAS = /^[a-z][a-z0-9-]{1,47}$/;
const MAX_PEERS = 128;
const refuse = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export function codexPeersPath(root) { return path.join(root, CODEX_PEERS_FILENAME); }

export async function loadCodexPeers(file) {
  await assertPrivateFile(file, { maxBytes: 256 * 1024 });
  const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
  if (!plainObject(parsed) || Object.keys(parsed).length > MAX_PEERS) throw new Error("codex peers must be a small object");
  const result = {};
  for (const [alias, raw] of Object.entries(parsed)) {
    if (!ALIAS.test(alias) || !plainObject(raw)) throw new Error("invalid codex peer entry");
    if (Object.keys(raw).some((key) => !["threadId", "registeredAt"].includes(key))) throw new Error(`unknown codex peer field for ${alias}`);
    result[alias] = Object.freeze({ threadId: requireUuid(raw.threadId, "threadId").toLowerCase(), registeredAt: typeof raw.registeredAt === "string" ? raw.registeredAt : null });
  }
  return Object.freeze(result);
}

export function codexPeersDigest(peers) {
  const table = peers ?? {};
  return sha256(JSON.stringify(Object.keys(table).sort().map((alias) => [alias, table[alias].threadId])));
}

// Deterministic routing: one alias, one answer.
export function resolvePeer(alias, { claude = {}, codex = {} } = {}) {
  if (typeof alias !== "string" || !ALIAS.test(alias)) return null;
  if (Object.hasOwn(claude, alias)) return { alias, kind: "claude", sessionId: claude[alias].sessionId };
  if (Object.hasOwn(codex, alias)) return { alias, kind: "codex", threadId: codex[alias].threadId };
  return null;
}
export function identityKey(peer) { return peer ? `${peer.kind}:${(peer.sessionId ?? peer.threadId).toLowerCase()}` : null; }

export function aliasOfCodexThread(codex, threadId) {
  return Object.keys(codex ?? {}).find((alias) => sameUuid(codex[alias].threadId, threadId ?? "")) ?? null;
}

export function listPeers({ claude = {}, codex = {} } = {}) {
  return [
    ...Object.entries(claude).map(([alias, row]) => ({ alias, kind: "claude", sessionId: row.sessionId, permissionMode: row.permissionMode })),
    ...Object.entries(codex).map(([alias, row]) => ({ alias, kind: "codex", threadId: row.threadId, registeredAt: row.registeredAt }))
  ].sort((a, b) => a.alias.localeCompare(b.alias));
}

async function readRaw(file) {
  try { await assertPrivateFile(file, { maxBytes: 256 * 1024 }); }
  catch (error) { if (error?.code === "ENOENT") return { table: {}, mode: 0o600 }; throw error; }
  const stat = await fsp.lstat(file);
  const table = JSON.parse(await fsp.readFile(file, "utf8"));
  if (!plainObject(table)) throw new Error("peer table must be an object");
  return { table, mode: stat.mode & 0o777 };
}

// identity: { kind: "claude", sessionId, cwd, permissionMode } | { kind: "codex", threadId }
// Returns { state: "registered" | "unchanged", alias, kind, replaced: [{alias, kind}] }.
export async function registerPeer({ targetsFile, codexFile, alias, identity, replace = false, now = () => new Date().toISOString() }) {
  if (!ALIAS.test(alias ?? "")) throw refuse("INVALID_ALIAS", "alias must be 2-48 characters: lowercase letters, digits and '-', starting with a letter");
  if (!identity || !["claude", "codex"].includes(identity.kind)) throw refuse("INVALID_CONTROL_ARGUMENTS", "identity is required");
  return serializeByFile(targetsFile, async () => {
    const targets = await readRaw(targetsFile); const codex = await readRaw(codexFile);
    const id = identity.kind === "claude" ? requireUuid(identity.sessionId, "sessionId") : requireUuid(identity.threadId, "threadId").toLowerCase();
    const sameIdentity = (kind, row) => kind === identity.kind && sameUuid(kind === "claude" ? row?.sessionId ?? "" : row?.threadId ?? "", id);
    const holder = Object.hasOwn(targets.table, alias) ? ["claude", targets.table[alias]] : Object.hasOwn(codex.table, alias) ? ["codex", codex.table[alias]] : null;
    if (holder && sameIdentity(holder[0], holder[1])) return { state: "unchanged", alias, kind: identity.kind, replaced: [] };
    const others = [
      ...Object.keys(targets.table).filter((name) => name !== alias && sameIdentity("claude", targets.table[name])).map((name) => ({ alias: name, kind: "claude" })),
      ...Object.keys(codex.table).filter((name) => name !== alias && sameIdentity("codex", codex.table[name])).map((name) => ({ alias: name, kind: "codex" }))
    ];
    if (!replace && holder) throw refuse("ALIAS_TAKEN", `alias ${alias} already names another ${holder[0]} session; add --replace to point it at this one`, { holderKind: holder[0] });
    if (!replace && others.length) throw refuse("SESSION_ALREADY_REGISTERED", `this session is already registered as ${others.map((o) => o.alias).join(", ")}; add --replace to move it to ${alias}`, { aliases: others.map((o) => o.alias) });
    const replaced = [...(holder ? [{ alias, kind: holder[0] }] : []), ...others];
    const nextTargets = { ...targets.table }; const nextCodex = { ...codex.table };
    for (const r of replaced) { if (r.kind === "claude") delete nextTargets[r.alias]; else delete nextCodex[r.alias]; }
    if (identity.kind === "claude") nextTargets[alias] = { sessionId: id, cwd: identity.cwd, permissionMode: identity.permissionMode };
    else nextCodex[alias] = { threadId: id, registeredAt: now() };
    if (Object.keys(nextTargets).length + Object.keys(nextCodex).length > MAX_PEERS) throw refuse("PEER_TABLE_FULL", `at most ${MAX_PEERS} peers`);
    // Removal before addition, so no reader ever sees one alias in both tables.
    const writeTargets = () => atomicPrivateWrite(targetsFile, `${JSON.stringify(nextTargets, null, 2)}\n`, { mode: targets.mode });
    const writeCodex = () => atomicPrivateWrite(codexFile, `${JSON.stringify(nextCodex, null, 2)}\n`, { mode: codex.mode });
    const codexChanged = JSON.stringify(nextCodex) !== JSON.stringify(codex.table);
    const targetsChanged = JSON.stringify(nextTargets) !== JSON.stringify(targets.table);
    if (identity.kind === "claude") { if (codexChanged) await writeCodex(); if (targetsChanged) await writeTargets(); }
    else { if (targetsChanged) await writeTargets(); if (codexChanged) await writeCodex(); }
    return { state: "registered", alias, kind: identity.kind, replaced };
  });
}

export async function removePeer({ targetsFile, codexFile, alias }) {
  if (!ALIAS.test(alias ?? "")) throw refuse("INVALID_ALIAS", "alias is not valid");
  return serializeByFile(targetsFile, async () => {
    const targets = await readRaw(targetsFile); const codex = await readRaw(codexFile);
    if (Object.hasOwn(targets.table, alias)) {
      const next = { ...targets.table }; delete next[alias];
      await atomicPrivateWrite(targetsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: targets.mode });
      return { removed: true, alias, kind: "claude" };
    }
    if (Object.hasOwn(codex.table, alias)) {
      const next = { ...codex.table }; delete next[alias];
      await atomicPrivateWrite(codexFile, `${JSON.stringify(next, null, 2)}\n`, { mode: codex.mode });
      return { removed: true, alias, kind: "codex" };
    }
    throw refuse("UNKNOWN_ALIAS", `no peer is registered as ${alias}`);
  });
}
