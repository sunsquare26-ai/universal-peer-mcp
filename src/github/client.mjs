import { execFile } from "node:child_process";
import { promisify } from "node:util";

// M6: the GitHub calls the bridge makes, through the owner's own `gh` login on this Mac (no token is
// read, stored or passed by this package). Three calls and nothing else: read a room's comments
// after a point, post one comment, read the room's visibility. Every argument is validated before
// `gh` is started; `gh` is run without a shell.
const run = promisify(execFile);
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function createGithubClient({ ghPath = process.env.UNIVERSAL_PEER_GH_PATH || "gh", exec = run, timeoutMs = 20_000 } = {}) {
  const api = async (args, input = null) => {
    try {
      const options = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } };
      const { stdout } = input === null ? await exec(ghPath, ["api", ...args], options) : await execWithInput(ghPath, ["api", ...args, "--input", "-"], input, options);
      return stdout ? JSON.parse(stdout) : null;
    } catch (error) {
      if (error?.code === "ENOENT") throw fail("GH_NOT_FOUND", "gh (GitHub CLI) is not installed or not on PATH");
      throw fail("GH_API_FAILED", String(error?.stderr || error?.message || error).slice(0, 300));
    }
  };
  const check = (repo, issue) => {
    if (!REPO.test(repo ?? "")) throw fail("INVALID_ROOM", "repo must be owner/name");
    if (!Number.isInteger(issue) || issue < 1) throw fail("INVALID_ROOM", "issue must be a positive number");
  };
  return {
    // Comments in creation order, read page by page from `fromPage`, at most `maxPages` pages of 100.
    // No `since` filter: GitHub's `since` is by update time, so an edited old comment would come back
    // and a busy second could starve the rest. The caller keeps the page it reached (`lastPage`) and
    // whether more remain (`more`), and dedupes by comment id.
    async comments({ repo, issue, fromPage = 1, maxPages = 5 }) {
      check(repo, issue);
      const out = []; let page = Math.max(1, fromPage); let more = false; let lastPage = page;
      for (let n = 0; n < maxPages; n += 1, page += 1) {
        const rows = await api([`repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`]);
        if (!Array.isArray(rows)) throw fail("GH_API_FAILED", "unexpected comments answer");
        for (const r of rows) out.push({ id: r.id, author: r.user?.login ?? null, authorType: r.user?.type ?? null, createdAt: r.created_at, body: typeof r.body === "string" ? r.body : "", url: r.html_url ?? null });
        lastPage = page;
        if (rows.length < 100) { more = false; break; }
        more = true;
      }
      return { comments: out, lastPage, more };
    },
    async postComment({ repo, issue, body }) {
      check(repo, issue);
      if (typeof body !== "string" || body.length === 0 || body.length > 60_000) throw fail("INVALID_COMMENT", "comment body is empty or too long");
      const row = await api([`repos/${repo}/issues/${issue}/comments`, "--method", "POST"], JSON.stringify({ body }));
      return { id: row?.id ?? null, url: row?.html_url ?? null, createdAt: row?.created_at ?? null };
    },
    // The room's identity: the repository's numeric id and whether the number is an issue or a PR.
    async room({ repo, number }) {
      check(repo, number);
      const r = await api([`repos/${repo}`]); const i = await api([`repos/${repo}/issues/${number}`]);
      if (!Number.isInteger(r?.id) || !Number.isInteger(i?.number)) throw fail("GH_API_FAILED", "unexpected repository or issue answer");
      return { repoId: r.id, number: i.number, kind: i.pull_request ? "pull" : "issue", title: typeof i.title === "string" ? i.title.slice(0, 200) : null };
    },
    // The repository as GitHub names it now: its numeric id (a name can be reused) and visibility.
    async repoInfo({ repo }) {
      if (!REPO.test(repo ?? "")) throw fail("INVALID_ROOM", "repo must be owner/name");
      const row = await api([`repos/${repo}`]);
      if (!Number.isInteger(row?.id)) throw fail("GH_API_FAILED", "unexpected repository answer");
      return { id: row.id, visibility: row.private === true ? "private" : "public" };
    },
    async visibility({ repo }) {
      if (!REPO.test(repo ?? "")) throw fail("INVALID_ROOM", "repo must be owner/name");
      const row = await api([`repos/${repo}`]);
      return row?.private === true ? "private" : "public";
    }
  };
}

function execWithInput(file, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr })));
    child.stdin.end(input);
  });
}
