import { execFileSync } from "node:child_process";

// The operator path, labelled `operator(interactive-tty)` everywhere — deliberately not "Owner
// authentication". Commands that act on items not the caller's own (link, relink, unregister of
// another alias, dispose of another's body) need all three:
//   - the calling process is inside no Claude or Codex session (daemon: identifyCaller kind null);
//   - it has a controlling terminal (kernel fact via /bin/ps -o tty=; agent tool shells run
//     detached, "??");
//   - the confirmation phrase `CONFIRM <target>` typed at that terminal (the CLI reads it only when
//     stdin and stdout are TTYs).
// Limitation: within one UID this is not a strong boundary — a same-user process that allocates a
// pseudo-terminal and types the phrase passes. It stops agent sessions running ordinary
// non-interactive commands, which is what it is for.
export const OPERATOR_LABEL = "operator(interactive-tty)";
export function operatorPhrase(target) { return `CONFIRM ${target}`; }

export function controllingTty(pid) {
  try {
    const out = execFileSync("/bin/ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim();
    return /^tty[a-z0-9]{1,8}$/.test(out) ? out : null;
  } catch { return null; }
}

// CLI side: ask at the terminal. Returns the typed line, or null when this is not an interactive
// terminal (the daemon then refuses and records the attempt).
export async function askOperator(target, { input = process.stdin, output = process.stderr } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  // M5: the phrase on a line of its own, in the Owner's language, so it can be copied whole. A
  // command pasted together with the next one used to answer this prompt with that next command.
  output.write(`${OPERATOR_LABEL}: 이 작업은 터미널에서 직접 확인해야 합니다. 아래 한 줄을 그대로 입력하고 Enter 를 누르세요.\n  ${operatorPhrase(target)}\n> `);
  return await new Promise((resolve) => {
    let buffer = "";
    // The one line is all this reads: the terminal is let go of at once, so a refusal ends the
    // process now rather than when the terminal next closes.
    const done = (value) => { input.off("data", onData); input.pause(); if (input === process.stdin) { try { input.destroy(); } catch {} } resolve(value); };
    const onData = (chunk) => { buffer += chunk.toString("utf8"); const at = buffer.indexOf("\n"); if (at >= 0) done(buffer.slice(0, at).replace(/\r$/, "")); if (buffer.length > 256) done(null); };
    input.on("data", onData); input.resume();
  });
}

// M5: what to tell the Owner when the typed line is not the phrase — before anything is sent.
export function confirmMismatch(target, typed) {
  const pasted = typeof typed === "string" && /universal-peer-mcp\s/.test(typed);
  return Object.assign(new Error(`확인 문구가 달라 아무것도 바꾸지 않았습니다. 입력해야 할 문구: ${operatorPhrase(target)}${pasted ? " — 다음 명령이 답으로 들어간 것 같습니다. 명령은 한 줄씩 실행하세요." : ""}`), { code: "OPERATOR_CONFIRM_MISMATCH" });
}
