# Contributing

Small project, narrow scope. Before writing code, open an issue describing the problem — a change that widens the trust boundary described in [SECURITY.md](SECURITY.md) will be declined no matter how well it is written.

## Getting set up

Requires macOS and Bun >= 1.3.0. There are no runtime dependencies to install; `package.json` declares none, and nothing is fetched at install time.

```sh
git clone https://github.com/sunsquare26-ai/universal-peer-mcp.git
cd universal-peer-mcp
bun --version
```

## Running the tests

The full suite:

```sh
bun test test/*.test.mjs
```

**Run the stdio files separately.** `test/stdio.test.mjs` and `test/code-review-stdio.test.mjs` each spawn real `bun src/server.mjs` and `bun src/daemon.mjs` subprocesses against per-test temporary state directories. Running them alongside everything else multiplies the number of live daemons at once and makes a failure hard to read.

```sh
bun test test/stdio.test.mjs
bun test test/code-review-stdio.test.mjs
bun test $(ls test/*.test.mjs | grep -v stdio)
```

`test/install.test.mjs` is in the second group and is slower than the rest: it runs `npm pack` twice, installs the tarball into a temporary prefix, runs the installed `bin`, and uninstalls. It runs with an empty cache and a registry pointed at a closed port, so it passes only if nothing needs the network. It writes nothing inside the repository — no `.tgz` is left behind, and the test asserts that.

Syntax check without running anything:

```sh
bun run check
```

Tests must never touch your real state directory. Every test creates its own directory with `fs.mkdtemp` under the system temporary directory, `chmod 0700`s it, and passes it through `UNIVERSAL_PEER_MCP_STATE_DIR`. A test that writes to `~/Library/Application Support/claude-peer-mcp/` is a bug in the test.

## Fixtures: what must never appear

Fixtures and test data are published. They must contain nothing that came from a real machine.

- **UUIDs: use the `10000000-0000-4000-8000-*` band only.** Every literal UUID in `test/`, `fixtures/`, `docs/`, and `targets.example.json` is in that band today, and that is checkable:

  ```sh
  grep -rhoE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' test fixtures docs targets.example.json \
    | sort -u | grep -v '^10000000-0000-4000-8000-'
  ```

  That command must print nothing. Never paste a UUID produced by a real session, even an expired one.
- **No home directory paths.** Use `/path/to/project`, `/Users/example/project`, or `${HOME}/project`.
- **No tokens, keys, or socket paths** copied from a running system, and no real session display names. Use neutral names such as `frontend-review`.
- **No emails, and no UUID, token, or path pasted from a running machine.** `test/pack.test.mjs` scans every committed file, not just the ones that ship, and it carries a negative control: a table of one planted example per detected class, which must all be caught. Add a case there before you add a detector.
- **One picture ships, and it was never on a screen.** [docs/round-trip.png](docs/round-trip.png) is *drawn* from `fixtures/demo-ack/session.json` by `test/screen.mjs`, not captured, so the menu bar, account name, window title, other session names and home path that a real capture carries were never in it to crop. It is reproduced byte for byte by `test/screenshot.test.mjs`, which also reads the text back out of the pixels, redraws that text and compares every pixel — a mark the text does not account for is refused — and checks that the chunk list is exactly `IHDR, PLTE, IDAT, IEND`, so there is no `tEXt`, `iTXt`, `zTXt`, `eXIf` or `tIME` to strip. The recovered text is then scanned by the same detectors as the source in `test/pack.test.mjs`. Its SHA-256 is pinned there; change the picture and the pin must change with it, in the same commit.

  Beside it, and saying the same thing in a form you can diff, is the text transcript: [docs/demo-ack.md](docs/demo-ack.md), built from the same fixture and re-derived from the shipped code by `test/demo-ack.test.mjs`.

  **Every other image is refused**, and not by recognising it. What may ship is a list — `.mjs`, `.md`, `.json`, `.toml`, `LICENSE`, `NOTICE`, and that one picture by name — so an unknown file type is refused for being unknown, and renaming nothing past it. Everything except the signed picture must be text: valid UTF-8 with no control byte but tab, carriage return and line feed, which no PNG, JPEG, GIF, BMP, WebP or PDF is under any name. And text may not carry a run of 128 or more base64 characters, over the whole file rather than its first page — the longest legitimate run in this tree is 103 and a SHA-256 is 64, while the picture that does ship is 39,028. That last rule reads no media type, no scheme and no markup, so how those are spelled does not change the answer. If you need a second picture, draw it the same way and give it the same gate; do not add a captured one.

- **Extra strings that must never ship** — a customer name, a project code name — go in a file of your own, one per line, and you point the scan at it:

  ```sh
  CLAUDE_PEER_MCP_DENY_TERMS=/path/to/deny.txt bun test test/pack.test.mjs
  ```

  The list is never committed. `test/pack.test.mjs` proves the mechanism works on synthetic input whether or not you supply one.

## Code style

- ESM only, `.mjs`, `"type": "module"`. Import Node built-ins with the `node:` prefix.
- No runtime dependencies. A pull request that adds one needs to justify it against the alternative of a few lines of code, and it must be declined by default.
- Double quotes, semicolons, two-space indent. Match the surrounding density instead of reformatting a file you are editing.
- Fail closed. On anything unexpected — a size, a NUL structure, an owner, a permission bit, an identity that changed — throw before the socket write rather than continuing with a guess.
- Never widen a permission. A permission mode asserted on the wire — inbound or outbound — is not a fact this package can check, so it is neither acted on nor written.
- Keep company-specific rules, model names, and internal procedures out of the tree entirely. Those belong in caller-supplied arguments or user configuration.

## Changing the layout

- The adapter under `src/adapters/claude-native-v1/` is the only place that knows Claude Code's private local formats. When a format changes, fix the adapter, not `src/core/`.
- `src/core/` must not learn anything about an optional extension. Extensions attach through the interfaces that already exist.
- Adding, removing, or renaming a public MCP tool changes a published contract. Say so in the pull request.

## Releasing

Do **not** use `npm version` or `bun pm version`. Both write a commit and a tag on your behalf, and this repository requires the version bump to be a reviewed change like any other.

1. Edit `"version"` in `package.json` by hand.
2. Update [COMPATIBILITY.md](COMPATIBILITY.md) with the versions you actually measured, each row dated. Never write a version you did not run.
3. Run the tests, including the stdio files.
4. Check what would ship, and read the file list: `npm pack --dry-run`
5. Confirm nothing personal is in the tarball — `bun test test/pack.test.mjs`, with `CLAUDE_PEER_MCP_DENY_TERMS` set if you have a list.
6. Install what you are about to publish, from a temporary prefix, and run the installed `bin`: `bun test test/install.test.mjs`
7. Commit, then tag explicitly: `git tag -a v<version> -m "v<version>"`

## Pull requests

Describe what changed, what you ran, and what you did not check. Paste the test counts rather than "tests pass". If a review finds something wrong, argue it with a file and line number or fix it — do not paper over it.
