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
  output.write(`${OPERATOR_LABEL}: type ${operatorPhrase(target)} to continue: `);
  return await new Promise((resolve) => {
    let buffer = "";
    const done = (value) => { input.off("data", onData); input.pause(); resolve(value); };
    const onData = (chunk) => { buffer += chunk.toString("utf8"); const at = buffer.indexOf("\n"); if (at >= 0) done(buffer.slice(0, at).replace(/\r$/, "")); if (buffer.length > 256) done(null); };
    input.on("data", onData); input.resume();
  });
}
