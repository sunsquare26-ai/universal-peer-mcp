import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const VERSION = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8")).version;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, failed: Boolean(error) });
    });
  });
}

// Offline on purpose: the cache is empty and the registry points at a closed port, so any
// attempt to reach the network fails loudly instead of quietly succeeding.
function npmArgs(work, extra) {
  return [...extra, "--offline", "--no-audit", "--no-fund", "--ignore-scripts",
    "--cache", path.join(work, "cache"), "--logs-dir", path.join(work, "logs"), "--registry", "http://127.0.0.1:9/"];
}

async function sha256(file) { return crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex"); }
async function missing(file) { try { await fsp.lstat(file); return false; } catch { return true; } }

test("the packed tarball installs into an empty prefix and the installed bin runs doctor", async () => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-install-"));
  try {
    const tarDir = path.join(work, "tarball");
    const prefix = path.join(work, "prefix");
    await fsp.mkdir(tarDir); await fsp.mkdir(prefix);

    // 1. pack twice: the artifact must be byte for byte the same, and the report must
    //    describe the file that was actually written.
    const first = await run("npm", npmArgs(work, ["pack", "--pack-destination", tarDir, "--json"]), { cwd: ROOT });
    expect(first.code).toBe(0);
    const report = JSON.parse(first.stdout.slice(first.stdout.indexOf("[")))[0];
    expect(report.name).toBe("claude-peer-mcp");
    const tarball = path.join(tarDir, `claude-peer-mcp-${VERSION}.tgz`);
    expect(report.filename).toBe(`claude-peer-mcp-${VERSION}.tgz`);
    const bytes = await fsp.readFile(tarball);
    expect(bytes.length).toBe(report.size);
    expect(crypto.createHash("sha1").update(bytes).digest("hex")).toBe(report.shasum);
    const firstDigest = await sha256(tarball);
    await fsp.rename(tarball, path.join(tarDir, "first.tgz"));
    const second = await run("npm", npmArgs(work, ["pack", "--pack-destination", tarDir, "--json"]), { cwd: ROOT });
    expect(second.code).toBe(0);
    expect(await sha256(tarball)).toBe(firstDigest);
    expect(await missing(path.join(ROOT, report.filename))).toBe(true);

    // 2. install that exact tarball into an empty prefix
    const install = await run("npm", npmArgs(work, ["install", "-g", "--prefix", prefix, tarball]), { cwd: work });
    expect(install.code).toBe(0);
    const home = path.join(prefix, "lib", "node_modules", "claude-peer-mcp");
    const bin = path.join(prefix, "bin", "claude-peer-mcp");
    expect((await fsp.lstat(bin)).isSymbolicLink() || (await fsp.stat(bin)).isFile()).toBe(true);
    expect(await missing(path.join(home, "node_modules"))).toBe(true);
    for (const shipped of ["targets.example.json", "README.md", "LICENSE", "docs/demo-ack.md", "docs/configuration.md", "examples/claude-mcp.json", "examples/codex-config.toml", "src/doctor.mjs"]) {
      expect((await fsp.stat(path.join(home, shipped))).isFile()).toBe(true);
    }
    for (const absent of ["test", "fixtures", "package-lock.json", ".gitignore"]) expect(await missing(path.join(home, absent))).toBe(true);

    // 3. the installed bin runs, reports zero targets, and creates nothing
    const state = path.join(work, "state");
    let doctor = await run(bin, ["doctor"], { env: { ...process.env, CLAUDE_PEER_MCP_STATE_DIR: state } });
    expect(doctor.stderr).toBe("");
    expect(doctor.code).toBe(0);
    let document = JSON.parse(doctor.stdout);
    expect(document.platform).toBe("darwin");
    expect(document.state.present).toBe(false);
    expect(document.targets).toMatchObject({ ok: true, present: false, count: 0 });
    expect(JSON.stringify(document)).not.toContain(work);
    expect(await missing(state)).toBe(true);

    // 4. the default state directory lives outside the installed package
    const bareEnv = { ...process.env }; delete bareEnv.CLAUDE_PEER_MCP_STATE_DIR;
    const bare = await run(bin, ["doctor"], { env: bareEnv });
    expect(bare.code).toBe(0);
    expect(JSON.parse(bare.stdout).stateDirectory).toBe("~/Library/Application Support/claude-peer-mcp");

    // 5. the documented copy step, run against the installed example
    await fsp.mkdir(state, { mode: 0o700 });
    const project = path.join(work, "project"); await fsp.mkdir(project);
    const example = JSON.parse(await fsp.readFile(path.join(home, "targets.example.json"), "utf8"));
    example["frontend-review"].cwd = await fsp.realpath(project);
    await fsp.writeFile(path.join(state, "targets.json"), JSON.stringify(example, null, 2), { mode: 0o600 });
    doctor = await run(bin, ["doctor"], { env: { ...process.env, CLAUDE_PEER_MCP_STATE_DIR: state } });
    expect(doctor.code).toBe(0);
    document = JSON.parse(doctor.stdout);
    expect(document.targets).toMatchObject({ ok: true, present: true, schemaValid: true, count: 1 });
    expect(document.targets.aliases).toEqual(["frontend-review"]);
    expect(document.state).toMatchObject({ present: true, private: true, mode: "0700" });
    expect(JSON.stringify(document)).not.toContain(work);

    // 6. an unknown subcommand exits 2 without touching anything
    const usage = await run(bin, ["not-a-command"], { env: { ...process.env, CLAUDE_PEER_MCP_STATE_DIR: state } });
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toContain("usage: claude-peer-mcp");

    // 7. uninstalling removes the package and leaves the user's state alone
    const uninstall = await run("npm", npmArgs(work, ["uninstall", "-g", "--prefix", prefix, "claude-peer-mcp"]), { cwd: work });
    expect(uninstall.code).toBe(0);
    expect(await missing(home)).toBe(true);
    expect(await missing(bin)).toBe(true);
    expect((await fsp.stat(path.join(state, "targets.json"))).isFile()).toBe(true);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}, 300_000);
