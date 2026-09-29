#!/usr/bin/env bun
// For named mutants: baseline of the judging test file on the unmutated copy, then each mutant's
// failing test names (bun's "(fail)" lines). Same copy rules as mutation-check.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const src = fs.readFileSync(path.join(process.cwd(), "tools/m1/mutation-check.mjs"), "utf8");
const MUTANTS = eval(src.slice(src.indexOf("const MUTANTS = ") + "const MUTANTS = ".length, src.indexOf("];\n", src.indexOf("const MUTANTS = ")) + 1));
const names = process.argv.slice(2);
const root = process.cwd();
const copyTree = () => { const c = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "upm-detail-")); for (const d of ["src", "test", "tools", "package.json", "node_modules"]) if (fs.existsSync(path.join(root, d))) execFileSync("cp", ["-R", path.join(root, d), c]); return c; };
const run = (cwd, file) => { const r = spawnSync(process.execPath, ["test", file], { cwd, encoding: "utf8", env: { ...process.env, UNIVERSAL_PEER_MAINTENANCE_DELAY_MS: "3600000" } }); const out = r.stdout + r.stderr; return { status: r.status, fails: [...out.matchAll(/^\(fail\) (.+?) \[/gm)].map((m) => m[1]), pass: /(\d+) pass/.exec(out)?.[1], fail: /(\d+) fail/.exec(out)?.[1] }; };
for (const name of names) {
  const m = MUTANTS.find((x) => x[0] === name); if (!m) { console.log(`NO SUCH MUTANT ${name}`); continue; }
  const [, file, find, replace, testFile] = m;
  const base = copyTree(); const b = run(base, testFile); fs.rmSync(base, { recursive: true, force: true });
  const copy = copyTree(); const t = path.join(copy, file); const text = fs.readFileSync(t, "utf8");
  if (text.split(find).length - 1 !== 1) { console.log(`${name}: SETUP pattern count ${text.split(find).length - 1}`); fs.rmSync(copy, { recursive: true, force: true }); continue; }
  fs.writeFileSync(t, text.replace(find, replace)); const r = run(copy, testFile); fs.rmSync(copy, { recursive: true, force: true });
  console.log(JSON.stringify({ mutant: name, testFile, baseline: { status: b.status, pass: b.pass, fail: b.fail }, mutant: { status: r.status, pass: r.pass, fail: r.fail, failing: r.fails } }));
}
