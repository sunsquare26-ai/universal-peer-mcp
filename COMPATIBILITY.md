# Compatibility

Only measured combinations appear as supported. A row that was not run on real hardware says `unverified`, and in an unverified environment the permission proof must not be treated as successful.

## Measured

One machine, one date. Everything below was read from the running system, not copied from a changelog.

| Item | Measured value | How it was read | Date |
|---|---|---|---|
| OS | macOS 26.6.2, build 25G83 | `sw_vers` | 2026-09-07 |
| Kernel | Darwin 25.6.0 | `uname -r` | 2026-09-07 |
| Architecture | arm64 | `uname -m` | 2026-09-07 |
| Runtime | Bun 1.3.11 | `bun --version` | 2026-09-07 |
| Codex CLI | codex-cli 0.153.2 | `codex --version` | 2026-09-07 |
| Claude Code | 2.1.260 | `claude --version` | 2026-09-07 |
| Node (dev only, `bun run check`) | v25.6.0 | `node --version` | 2026-09-07 |
| Node compatibility version Bun reports | 24.3.0 | `universal-peer-mcp doctor` -> `runtimes.node` | 2026-09-07 |
| npm (packaging only) | 11.8.0 | `npm --version` | 2026-09-07 |

## Behaviour verified on that machine

| Check | Result | Date |
|---|---|---|
| `universal-peer-mcp doctor` reports `ok: true`, `platform: darwin`, `arch: arm64` | pass | 2026-09-07 |
| `doctor` platform, architecture, Bun-version, state, targets, Claude registry, and codex-wake checks | all pass, `codexWake.enabled: false` | 2026-09-07 |
| Live `KERN_PROCARGS2` read through `bun:ffi` on `/usr/lib/libSystem.B.dylib` | pass — `argc` parsed, `argv[0]` equal to the exec path | 2026-09-07 |
| `ps -p <pid> -o lstart=` returns a usable process start string | pass | 2026-09-07 |
| `KERN_PROCARGS2` parser fixtures, all zero-padding widths | 8 pass, 0 fail | 2026-09-07 |
| `codex exec resume [SESSION_ID] [PROMPT]` present in `codex exec resume --help` | pass on codex-cli 0.153.2 | 2026-09-07 |
| `npm pack --dry-run` completes and lists the file set | pass | 2026-09-07 |
| Codex config key `mcp_servers` accepted by the installed CLI | pass | 2026-09-07 |
| `KERN_PROCARGS2` buffer layout first measured | macOS/arm64 | 2026-09-03 |
| `claude --help` `--permission-mode` choices on 2.1.260 | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` | 2026-09-07 |

### Permission mode values, cross-checked against Claude Code 2.1.260

| Value | Accepted by Claude Code 2.1.260 | Proved by this adapter |
|---|---|---|
| `bypassPermissions` | yes | `bypass` |
| `acceptEdits` | yes | `prompting` |
| `auto` | yes | `prompting` |
| `plan` | yes | `prompting` |
| `manual` | yes | **no mapping** — fails closed |
| `dontAsk` | yes | **no mapping** — fails closed |
| `default` | no, not offered on 2.1.260 | `prompting` |

A target launched with `manual` or `dontAsk` cannot be used until a mapping is added and measured against a specific Claude Code release.

## Requirements that follow from the measurement

- **Bun, not Node.** `src/adapters/claude-native-v1/darwin-procargs.mjs` uses `bun:ffi` `dlopen` on `/usr/lib/libSystem.B.dylib`. Node cannot run this package. Node appears above only because `bun run check` shells out to `node --check`.
- **macOS only.** `sysctl` with `KERN_PROCARGS2`, `ps -o lstart=`, and the `0700`/`0600` state checks are all Darwin-specific. `package.json` declares `"os": ["darwin"]`.
- **The target must have been launched with an explicit `--permission-mode` flag.** With no such flag the proof fails closed with `permission mode argv cannot be proven`. This is deliberate: the alternative would be assuming a default that was never measured.

## MCP protocol versions

| Version | Status |
|---|---|
| `2026-07-28` | supported — per-request metadata, no initialize handshake |
| `2025-06-18` | supported — legacy `initialize` handshake, kept in a separate adapter |
| anything else | rejected. The two eras are never mixed on one connection. |

## Unverified

Nothing below has been run. Do not read absence of a report as a report of success.

| Combination | Status | Note |
|---|---|---|
| macOS on x64 (Intel, or Rosetta) | unverified | `package.json` declares `"cpu": ["arm64"]`, so npm refuses to install there, and `doctor` would report `architectureSupported: false`. The `KERN_PROCARGS2` layout must be re-measured before the permission proof could be trusted. |
| macOS 25 and earlier | unverified | — |
| Bun 1.3.0 to 1.3.10 | unverified | 1.3.0 is the declared floor in `engines.bun`; only 1.3.11 was run. |
| Bun 2.x | unverified | — |
| Claude Code other than 2.1.260 | unverified | The local session registry is a private interface and can change in any release. |
| Codex CLI other than 0.153.2 | unverified | — |
| MCP hosts other than Codex CLI and Claude Code | unverified | — |
| Linux, Windows, WSL | not supported | No Darwin syscalls, no `ps -o lstart=`. |

## How to add a row

Run the command, paste the value you actually saw, and date the row. Never fill a cell from a release note, a package manager listing, or another machine. If a check fails on your combination, record the failure rather than deleting the row — a known-bad cell is more useful than an empty one.
