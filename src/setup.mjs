import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_STATE_FILE, resolveStateDirEnv, statePaths } from "./core/state-paths.mjs";

// M5: `universal-peer-mcp setup [--state <dir>] [--bin-dir <dir>] [--yes]` — the one step after
// installing. Until now every machine was set up by hand (a state directory, a link on PATH, the
// Codex rule, the state directory remembered by the install), and every step that was missed showed
// up later as a session that could not find the command or talked to an empty daemon.
//
// Without --yes it only prints what it would do. With --yes it does exactly that and nothing else:
//   1. the state directory exists, 0700, with an empty targets.json (0600) if there is none
//   2. the install remembers that directory (<package>/STATE_DIR), so a bare command finds it
//   3. `universal-peer-mcp` is on PATH: if it is not, a link in --bin-dir (default ~/.local/bin)
//   4. the Codex rule is in ~/.codex/AGENTS.md between two markers; a block this tool wrote earlier
//      is replaced, an unmarked copy of an earlier shipped rule is converted, and any other text
//      is never touched — a different hand-written rule is reported and left alone
// It registers no session (that is proved from inside each session) and edits no client config.
export const RULE_BEGIN = "<!-- universal-peer:begin (managed by `universal-peer-mcp setup`) -->";
export const RULE_END = "<!-- universal-peer:end -->";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Earlier shipped rule texts, found unmarked in a user's AGENTS.md: converted to the managed block.
const SHIPPED_RULES_DIR = path.join(PACKAGE_ROOT, "docs", "codex-global-agents.history");

export function ruleText(root = PACKAGE_ROOT) { return fs.readFileSync(path.join(root, "docs", "codex-global-agents.md"), "utf8").trim(); }
function shippedRules() { try { return fs.readdirSync(SHIPPED_RULES_DIR).filter((n) => n.endsWith(".md")).map((n) => fs.readFileSync(path.join(SHIPPED_RULES_DIR, n), "utf8").trim()); } catch { return []; } }

// Lines outside fenced code blocks: a marker or a heading quoted in an example is not one. Fences
// follow CommonMark: an opener is 3+ backticks or tildes after at most three spaces (a backtick
// opener's info string has no backtick); it is closed only by the same character, at least as many,
// with nothing but spaces after; an unclosed fence runs to the end of the file.
export function liveLines(text) {
  const lines = text.split("\n"); let open = null;
  return lines.map((line, index) => {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.length) open = null;
      return { line, index, live: false };
    }
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) { open = { char: opener[1][0], length: opener[1].length }; return { line, index, live: false }; }
    return { line, index, live: true };
  });
}

// Pure: the new AGENTS.md text, or why it is left alone. Only a file this tool can read without
// guessing is changed:
//   - managed: exactly one BEGIN line and one END line, each alone on its line, outside any code
//     fence, BEGIN first, and no marker text anywhere else — the block between them is replaced;
//   - unmarked: exactly one "## UniversalPeer" section outside fences whose whole text equals the
//     current or an earlier shipped rule — that section becomes the managed block;
//   - no UniversalPeer section and no marker text at all: the block is appended.
// Everything else (a hand-edited section, markers out of shape, a marker or rule quoted in an
// example) is a conflict and the file is not touched.
export function planRule(current, rule, earlier = []) {
  const block = `${RULE_BEGIN}\n${rule}\n${RULE_END}`;
  if (current === null || current.trim() === "") return { action: "create", text: `${block}\n` };
  const rows = liveLines(current);
  const mentions = (rows.filter((r) => r.line.includes("universal-peer:begin") || r.line.includes("universal-peer:end"))).length;
  const begins = rows.filter((r) => r.live && r.line === RULE_BEGIN); const ends = rows.filter((r) => r.live && r.line === RULE_END);
  if (mentions > 0) {
    if (begins.length !== 1 || ends.length !== 1 || mentions !== 2 || begins[0].index > ends[0].index) return { action: "conflict", reason: "the universal-peer markers are not one clean pair; nothing changed" };
    const lines = current.split("\n");
    const next = [...lines.slice(0, begins[0].index), ...block.split("\n"), ...lines.slice(ends[0].index + 1)].join("\n");
    return next === current ? { action: "unchanged" } : { action: "update", text: next };
  }
  const headings = rows.filter((r) => r.live && /^##\s*UniversalPeer\b/.test(r.line));
  if (headings.length > 1) return { action: "conflict", reason: "more than one UniversalPeer section; nothing changed" };
  if (headings.length === 1) {
    const start = headings[0].index;
    const after = rows.find((r) => r.live && r.index > start && /^#{1,2}\s/.test(r.line));
    const lines = current.split("\n"); const stop = after ? after.index : lines.length;
    const section = lines.slice(start, stop).join("\n").trim();
    if (![rule, ...earlier].includes(section)) return { action: "conflict", reason: "the UniversalPeer section differs from every shipped rule (edited by hand?); nothing changed" };
    // The blank lines that ended the section (and the file's final newline) stay where they were.
    const sectionLines = lines.slice(start, stop); let blanks = 0; while (blanks < sectionLines.length && sectionLines[sectionLines.length - 1 - blanks] === "") blanks += 1;
    return { action: "convert", text: [...lines.slice(0, start), ...block.split("\n"), ...Array(blanks).fill(""), ...lines.slice(stop)].join("\n") };
  }
  // The end of the file must be outside any fence, or the block would land inside a code example
  // (and the next run could not manage it). An open fence is the user's; it is not closed for them.
  if (!liveLines(`${current.replace(/\s*$/, "")}\n\nprobe`).at(-1).live) return { action: "conflict", reason: "the file ends inside an unclosed code fence; nothing changed" };
  return { action: "append", text: `${current.replace(/\s*$/, "")}\n\n${block}\n` };
}

function onPath(name) { try { return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null; } catch { return null; } }
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

export function planSetup({ state = null, binDir = path.join(os.homedir(), ".local", "bin"), codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  const steps = [];
  const resolved = resolveStateDirEnv();
  const root = path.resolve(state ?? resolved.root ?? statePaths().root);
  const paths = statePaths(root);
  if (!fs.existsSync(root)) steps.push({ step: "state", action: "create", detail: root });
  else steps.push({ step: "state", action: "exists", detail: root });
  if (!fs.existsSync(paths.targets)) steps.push({ step: "targets", action: "create", detail: paths.targets });
  const pin = path.join(PACKAGE_ROOT, INSTALL_STATE_FILE);
  const pinned = fs.existsSync(pin) ? fs.readFileSync(pin, "utf8").trim() : null;
  if (pinned !== root) steps.push({ step: "pin", action: pinned ? "update" : "create", detail: `${pin} -> ${root}` });
  const cli = path.join(PACKAGE_ROOT, "src", "cli.mjs");
  const found = onPath("universal-peer-mcp");
  if (found && realOrNull(found) === realOrNull(cli)) steps.push({ step: "command", action: "on_path", detail: found });
  else {
    const link = path.join(binDir, "universal-peer-mcp");
    const binOnPath = (process.env.PATH ?? "").split(":").map((d) => path.resolve(d)).includes(path.resolve(binDir));
    steps.push({ step: "command", action: found ? "shadowed" : "link", detail: `${link} -> ${cli}`, ...(found ? { note: `another universal-peer-mcp is first on PATH: ${found}` } : {}), ...(binOnPath ? {} : { note: `${binDir} is not on PATH; add it` }) });
  }
  const agents = path.join(codexHome, "AGENTS.md");
  if (fs.existsSync(codexHome)) {
    const current = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : null;
    const plan = planRule(current, ruleText(), shippedRules());
    steps.push({ step: "codex_rule", action: plan.action, detail: agents, ...(plan.reason ? { note: plan.reason } : {}), ...(plan.text ? { text: plan.text } : {}) });
  } else steps.push({ step: "codex_rule", action: "skip", detail: `${codexHome} not found (no Codex on this account)` });
  return { root, steps };
}

export function applySetup(plan) {
  const done = [];
  for (const s of plan.steps) {
    if (s.step === "state" && s.action === "create") { fs.mkdirSync(plan.root, { recursive: true, mode: 0o700 }); fs.chmodSync(plan.root, 0o700); done.push(s.step); }
    if (s.step === "targets" && s.action === "create") { fs.writeFileSync(statePaths(plan.root).targets, "{}\n", { mode: 0o600, flag: "wx" }); done.push(s.step); }
    if (s.step === "pin") { fs.writeFileSync(path.join(PACKAGE_ROOT, INSTALL_STATE_FILE), `${plan.root}\n`, { mode: 0o600 }); fs.chmodSync(path.join(PACKAGE_ROOT, INSTALL_STATE_FILE), 0o600); done.push(s.step); }
    if (s.step === "command" && s.action === "link") {
      const [link, target] = s.detail.split(" -> ");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try { const st = fs.lstatSync(link); if (!st.isSymbolicLink()) throw new Error(`${link} exists and is not a link; left alone`); fs.unlinkSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
      fs.symlinkSync(target, link); done.push(s.step);
    }
    if (s.step === "codex_rule" && ["create", "update", "convert", "append"].includes(s.action)) {
      // The original is kept under a name no other run can take (exclusive copy), then the new text
      // replaces it atomically.
      if (fs.existsSync(s.detail)) fs.copyFileSync(s.detail, `${s.detail}.before-universal-peer-${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`, fs.constants.COPYFILE_EXCL);
      const tmp = `${s.detail}.universal-peer-tmp-${process.pid}`;
      fs.writeFileSync(tmp, s.text, { mode: fs.existsSync(s.detail) ? fs.statSync(s.detail).mode & 0o777 : 0o644 }); fs.renameSync(tmp, s.detail); done.push(s.step);
    }
  }
  return done;
}

const LABEL = { state: "상태 폴더", targets: "대상 표", pin: "설치본이 기억할 상태 폴더", command: "PATH 의 universal-peer-mcp", codex_rule: "Codex 전역 규칙" };
const quote = (v) => (/^[A-Za-z0-9_\/.,:=+@%-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);
export function renderSetup(plan, { applied = null, argv = [] } = {}) {
  const lines = [`상태 폴더: ${plan.root}`, ""];
  for (const s of plan.steps) lines.push(`- ${LABEL[s.step]}: ${s.action}  ${s.detail}${s.note ? `  (${s.note})` : ""}`);
  lines.push("");
  const command = plan.steps.find((s) => s.step === "command");
  const ready = command?.action === "on_path" || (applied !== null && command?.action === "link" && !command.note);
  const exe = ready ? "universal-peer-mcp" : quote(path.join(PACKAGE_ROOT, "src", "cli.mjs"));
  if (applied === null) lines.push(`아직 아무것도 바꾸지 않았습니다. 위대로 적용하려면: ${[exe, "setup", ...argv.map(quote), "--yes"].join(" ")}`);
  else lines.push(`적용함: ${applied.length ? applied.join(", ") : "바꿀 것 없음"}`);
  if (!ready && command?.note) lines.push("", `PATH 에 아직 universal-peer-mcp 가 없습니다: ${command.note}. PATH 를 고친 뒤 새 터미널에서 setup 을 다시 실행하면 on_path 로 바뀝니다. 그 전에는 아래 명령에 절대경로를 쓰세요.`);
  lines.push("", "다음: 대화할 각 세션 안에서 한 번씩 실행하세요 (Claude 는 Bash 도구나 !, Codex 는 셸):", `  ${exe} register --alias <이름>`, `Claude 세션은 절대경로와 --permission-mode 를 붙여 시작한 세션만 등록됩니다. 확인: ${exe} status`);
  return `${lines.join("\n")}\n`;
}
