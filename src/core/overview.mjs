// M5 F3: `status` — who is there, what is waiting on whom, in one screen.
//
// The question it answers is the one the Owner kept asking a session ("is Codex connected? should I
// wait?"). Every field is something observed, with when it was observed; nothing is inferred into a
// state the ledger cannot back:
//   present      claude: running / not_running / unknown, from the registry reading every resolver
//                uses (pid and its start time). codex: "unknown" — a thread's liveness is not
//                observable from here without starting a turn — and lastSeenAt says when it acted.
//   lastSeenAt   the newest row this alias wrote as an actor: a post it sent or a message it marked
//                processed.
//   unprocessed  messages addressed to it with no processed mark (read-and-working is included: the
//                ledger proves "not processed", not "not read"), and the oldest one's age.
//   undelivered  of those, the ones whose latest doorbell outcome is not_sent; uncertain: unknown.
//                autoRetry: how many of them the next return will ring again (F2 eligibility);
//                the rest are exhausted or not eligible and need a hand.
//   held         messages waiting for a previous session of this alias (only the Owner moves them).
// Aliases no longer registered that still have unprocessed messages are listed under `unregistered`.
export function overview({ events, peers, held = new Map(), presence = new Map(), eligible = () => false, now = Date.now(), daemon = null }) {
  const processed = new Set(); const lastOutcome = new Map(); const lastSeen = new Map();
  const seen = (alias, at) => { if (typeof alias === "string" && (!lastSeen.has(alias) || lastSeen.get(alias) < at)) lastSeen.set(alias, at); };
  for (const e of events) {
    const id = typeof e.messageId === "string" ? e.messageId.toLowerCase() : null;
    if (e.type === "peer_post_processed") { if (id) processed.add(id); seen(e.readerAlias, e.at); }
    else if (e.type === "peer_post") { if (e.source !== "receipt") seen(e.senderAlias, e.at); }
    else if (e.type === "doorbell_outcome" && id) lastOutcome.set(id, e);
  }
  const waiting = new Map();
  for (const e of events) {
    if (e.type !== "peer_post" || typeof e.recipient !== "string" || e.recipient === "*" || processed.has(e.messageId.toLowerCase())) continue;
    const w = waiting.get(e.recipient) ?? { unprocessed: 0, oldestAt: null, undelivered: 0, uncertain: 0, autoRetry: 0 };
    w.unprocessed += 1; if (!w.oldestAt || e.at < w.oldestAt) w.oldestAt = e.at;
    const last = lastOutcome.get(e.messageId.toLowerCase());
    if (last?.state === "not_sent") { w.undelivered += 1; if (eligible(e)) w.autoRetry += 1; }
    else if (last?.state === "unknown") w.uncertain += 1;
    waiting.set(e.recipient, w);
  }
  const empty = { unprocessed: 0, oldestAt: null, undelivered: 0, uncertain: 0, autoRetry: 0 };
  const rows = peers.map((peer) => {
    const w = waiting.get(peer.alias) ?? empty;
    return {
      alias: peer.alias, kind: peer.kind,
      session: (peer.sessionId ?? peer.threadId ?? "").slice(0, 8),
      present: peer.kind === "claude" ? (presence.get(peer.alias) ?? "unknown") : "unknown",
      lastSeenAt: lastSeen.get(peer.alias) ?? null,
      unprocessed: w.unprocessed, oldestUnprocessedAt: w.oldestAt, undelivered: w.undelivered, uncertain: w.uncertain, autoRetry: w.autoRetry,
      held: held.get(peer.alias) ?? 0
    };
  });
  const registered = new Set(peers.map((p) => p.alias));
  const unregistered = [...waiting].filter(([alias]) => !registered.has(alias)).map(([alias, w]) => ({ alias, unprocessed: w.unprocessed, oldestUnprocessedAt: w.oldestAt }));
  return { at: new Date(now).toISOString(), daemon, peers: rows, unregistered };
}

const ago = (iso, now) => {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
};
const PRESENT = { running: "켜져 있음", not_running: "꺼져 있음", unknown: "확인 불가" };

// The human rendering. One line per alias, then what needs a hand, in plain words.
export function renderOverview(view, now = Date.now()) {
  const lines = [];
  const d = view.daemon;
  if (d) lines.push(`중계 데몬: pid ${d.pid}, 빌드 ${d.buildId ?? "?"}, ${ago(d.startedAt, now)} 시작${d.previousEnd === "crashed" ? " (직전 데몬은 오류로 종료)" : d.previousEnd === "unclean" ? " (직전 데몬은 기록 없이 종료)" : ""}`);
  lines.push("");
  const head = ["별칭", "종류", "상태", "마지막 활동", "미처리 메시지", "알림 못 감", "이전 세션 보류"];
  const body = view.peers.map((p) => [p.alias, p.kind, PRESENT[p.present], ago(p.lastSeenAt, now), p.unprocessed ? `${p.unprocessed}건 (가장 오래된 것 ${ago(p.oldestUnprocessedAt, now)})` : "0", p.uncertain ? `${p.undelivered} (+불확실 ${p.uncertain})` : String(p.undelivered), String(p.held)]);
  // Hangul and other wide characters take two terminal columns.
  const cols = (text) => [...text].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
  const width = head.map((h, i) => Math.max(cols(h), ...body.map((r) => cols(r[i]))));
  const fmt = (r) => r.map((c, i) => c + " ".repeat(width[i] - cols(c))).join("  ").trimEnd();
  lines.push(fmt(head), ...body.map(fmt));
  const notes = [];
  for (const p of view.peers) {
    const manual = p.undelivered - p.autoRetry;
    if (p.autoRetry) notes.push(`- ${p.alias}: 알림이 못 간 메시지 ${p.autoRetry}건은 이 세션이 다시 무엇이든 실행하면 자동으로 한 번 더 알립니다.`);
    if (manual > 0 || p.uncertain) notes.push(`- ${p.alias}: 자동 재알림 대상이 아닌 미전달 ${manual}건${p.uncertain ? `, 전달 불확실 ${p.uncertain}건` : ""}. 세션을 열어 inbox 로 확인하세요: universal-peer-mcp open ${p.alias}`);
    else if (!p.autoRetry && p.unprocessed && p.present === "not_running") notes.push(`- ${p.alias}: 꺼져 있고 미처리 메시지 ${p.unprocessed}건. 열려면: universal-peer-mcp open ${p.alias}`);
    if (p.held) notes.push(`- ${p.alias}: 이전 세션 앞으로 온 메시지 ${p.held}건이 보류 중. 새 세션으로 넘기려면 소유자 터미널에서: universal-peer-mcp link --post <messageId>`);
  }
  for (const u of view.unregistered ?? []) notes.push(`- ${u.alias}(등록 없음): 미처리 메시지 ${u.unprocessed}건 (가장 오래된 것 ${ago(u.oldestUnprocessedAt, now)}). 그 별칭을 다시 등록한 뒤, 소유자 터미널에서 universal-peer-mcp link --post <messageId> 로 넘기세요.`);
  if (notes.length) lines.push("", "손볼 것:", ...notes);
  return `${lines.join("\n")}\n`;
}
