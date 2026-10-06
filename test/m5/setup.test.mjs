import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planRule, RULE_BEGIN, RULE_END, ruleText } from "../../src/setup.mjs";

const rule = "## UniversalPeer 피어 통신\n- new rule";
const old = fs.readFileSync(path.join(import.meta.dir, "../../docs/codex-global-agents.history/2026-09-29.md"), "utf8").trim();
const block = `${RULE_BEGIN}\n${rule}\n${RULE_END}`;

test("empty or missing → the managed block", () => {
  expect(planRule(null, rule)).toEqual({ action: "create", text: `${block}\n` });
  expect(planRule("", rule).action).toBe("create");
});
test("a managed block is replaced in place, other text kept; same text is unchanged", () => {
  const cur = `# mine\n\n${RULE_BEGIN}\nold\n${RULE_END}\n\n# after\n`;
  expect(planRule(cur, rule)).toEqual({ action: "update", text: `# mine\n\n${block}\n\n# after\n` });
  expect(planRule(`x\n${block}\n`, rule)).toEqual({ action: "unchanged" });
});
test("an unmarked earlier shipped rule is converted; a different hand-written one is left alone", () => {
  expect(planRule(`${old}\n`, rule, [old])).toEqual({ action: "convert", text: `${block}\n` });
  expect(planRule(`# top\n\n${old}\n\n## Other\n- keep\n`, rule, [old])).toEqual({ action: "convert", text: `# top\n\n${block}\n\n## Other\n- keep\n` });
  expect(planRule("## UniversalPeer 피어 통신\n- my own words\n", rule, [old]).action).toBe("conflict");
  expect(planRule("# other rules\n", rule)).toEqual({ action: "append", text: `# other rules\n\n${block}\n` });
});
test("review of 8fdb05f: never guesses — extra user bullets, quoted examples, odd markers are conflicts", () => {
  expect(planRule(`${old}\n- 내가 덧붙인 지시\n`, rule, [old]).action).toBe("conflict");
  expect(planRule(`# notes\n\n\`\`\`\n${old}\n\`\`\`\n`, rule, [old]).action).toBe("append");
  expect(planRule(`${RULE_BEGIN}\n- 개인 지시\n${RULE_BEGIN}\nx\n${RULE_END}\n`, rule).action).toBe("conflict");
  expect(planRule(`${RULE_END}\nx\n${RULE_BEGIN}\n`, rule).action).toBe("conflict");
  expect(planRule(`${RULE_BEGIN}\nx\n`, rule).action).toBe("conflict");
  expect(planRule(`\`\`\`\n${RULE_BEGIN}\nx\n${RULE_END}\n\`\`\`\n`, rule).action).toBe("conflict");
  expect(planRule(`${old}\n\n${old}\n`, rule, [old]).action).toBe("conflict");
  // Review of 2a04310: a longer fence is not closed by a shorter one, nor backticks by tildes.
  expect(planRule(`\`\`\`\`markdown\n\`\`\`\n${RULE_BEGIN}\nEXAMPLE PERSONAL INSTRUCTION\n${RULE_END}\n\`\`\`\`\n`, rule).action).toBe("conflict");
  expect(planRule(`\`\`\`markdown\n~~~\n${RULE_BEGIN}\nEXAMPLE PERSONAL INSTRUCTION\n${RULE_END}\n\`\`\`\n`, rule).action).toBe("conflict");
  expect(planRule(`\`\`\`\nx\n\`\`\` not a close\n${RULE_BEGIN}\nx\n${RULE_END}\n`, rule).action).toBe("conflict");
  // Review of d6ac605: an unclosed fence at the end of the file is never appended into.
  const unclosed = planRule("# Personal instructions\n\n```sh\necho example\n", rule);
  expect(unclosed.action).toBe("conflict"); expect(unclosed.text).toBeUndefined();
  expect(planRule("# Personal\n\n```sh\necho ok\n```\n", rule).action).toBe("append");
});
test("two applies in the same instant keep two backups and the original", async () => {
  const { applySetup } = await import("../../src/setup.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upm-setup-")); const file = path.join(dir, "AGENTS.md");
  try {
    fs.writeFileSync(file, "ORIGINAL");
    applySetup({ root: dir, steps: [{ step: "codex_rule", action: "update", detail: file, text: "FIRST" }] });
    applySetup({ root: dir, steps: [{ step: "codex_rule", action: "update", detail: file, text: "SECOND" }] });
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith("AGENTS.md.before-universal-peer-")).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).sort();
    expect(backups).toEqual(["FIRST", "ORIGINAL"]);
    expect(fs.readFileSync(file, "utf8")).toBe("SECOND");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("the CLI refuses unknown options and a missing value instead of guessing", () => {
  const run = (...a) => Bun.spawnSync([process.execPath, path.join(import.meta.dir, "../../src/cli.mjs"), "setup", ...a]);
  expect(run("--state", "--yes").exitCode).toBe(1);
  expect(run("--frobnicate").exitCode).toBe(1);
});
test("the shipped rule teaches --reply-to, receipts and status", () => {
  const text = ruleText();
  for (const word of ["--reply-to", "--expect-reply", "universal-peer` 인 메시지", "status"]) expect(text).toContain(word);
});

test("fences: same character, at least as long, nothing after the close", async () => {
  const { liveLines } = await import("../../src/setup.mjs");
  const live = (t) => liveLines(t).filter((r) => r.live).map((r) => r.line);
  expect(live("a\n````\nb\n```\nc\n````\nd")).toEqual(["a", "d"]);
  expect(live("a\n```\nb\n~~~\nc\n```\nd")).toEqual(["a", "d"]);
  expect(live("a\n```\nb\n``` x\nc")).toEqual(["a"]);
  expect(live("a\n    ```\nb")).toEqual(["a", "    ```", "b"]);
});
