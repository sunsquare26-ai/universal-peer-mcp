# Configuration

Everything a user configures lives in one directory outside the package. The package itself ships only `targets.example.json`.

## State directory

Default location:

```text
~/Library/Application Support/claude-peer-mcp/
```

The directory is named after this package's former name, `claude-peer-mcp`, and keeps it. A variable can be read under two names at once and a directory cannot be in two places at once, so moving it would leave an existing event log where nothing looks for it while the new location came up looking like a fresh install.

| Path | Mode | What it is |
|---|---|---|
| the directory itself | `0700` | Refuses to start if it is a symlink, owned by another uid, or has any group/other bit. |
| `targets.json` | `0600` | Your allowlist. You write this file; nothing writes it for you. |
| `events.jsonl` | `0600` | Append-only local event log, for surviving restarts. Not a tamper-proof ledger. |
| `daemon.json` | `0600` | Live daemon identity: pid, process start, socket path, admin flag, enabled extensions, start time. |
| `daemon.lock` | `0600` | Startup lock, held for the daemon's lifetime. |
| `control.sock` | `0600` | Unix domain socket the stdio entry point talks to. Never network-facing. |
| `control.token` | `0600` | Random 32-byte hex token, regenerated on every daemon start. Never printed by any tool. |
| `owner.json` | `0600` | Reserved by the path layout. |

A clean exit, including on `SIGTERM` and `SIGINT`, removes exactly four files: `control.sock`, `control.token`, `daemon.json`, and `daemon.lock` (`src/daemon.mjs:80`). Those are the ones that describe a running process. **`targets.json`, `events.jsonl`, and `owner.json` survive**, and so does the directory itself; removing an installation never deletes them for you. Files left behind by a hard kill are only reclaimed after the next start confirms the recorded process is genuinely gone, by pid and by process start time. If it cannot confirm that, it refuses to start rather than clearing someone else's socket.

## `targets.json`

An object whose keys are your local aliases. At most 128 entries, at most 256 KiB.

```json
{
  "frontend-review": {
    "sessionId": "10000000-0000-4000-8000-000000000001",
    "cwd": "/path/to/project",
    "expectedDisplayName": "Frontend review",
    "permissionMode": "prompting"
  },
  "ops": {
    "sessionId": "10000000-0000-4000-8000-000000000002",
    "cwd": "/Users/example/project",
    "permissionMode": "bypass"
  }
}
```

### Alias

Must match `^[a-z][a-z0-9-]{1,47}$` — lower case, starts with a letter, 2 to 48 characters. The alias is your stable local name. It is not sent as an address and it means nothing outside your own configuration.

### Fields

| Field | Required | Rule |
|---|---|---|
| `sessionId` | yes | The exact Claude Code session UUID. This is the only address used. |
| `cwd` | yes | Absolute literal path. It is resolved through symlinks and must equal the session's own resolved working directory, or the target is rejected. No variable expansion happens: `~` and `${HOME}` are read as literal characters and will not resolve. |
| `permissionMode` | yes | `prompting` or `bypass`. Must equal the mode proved from the target's real process arguments. |
| `expectedDisplayName` | no | Up to 256 bytes. Diagnostic only. |

`cwd` is resolved with `realpath` while the file is read, so a path that does not exist rejects the whole file. The shipped `targets.example.json` carries the placeholder `/path/to/project` and will not validate until you replace it.

Any other key is rejected with `unknown target field for <alias>`. There is no place to configure a model, a timeout, a retry count, or a permission override, and that is intentional.

### Why the display name is not authoritative

`expectedDisplayName` never selects a session, never grants a permission, and never triggers a restart. If the name observed in the registry differs, a `display_name_observed` event is recorded and surfaced in status, and the send proceeds. Screen names are renamed by humans; addresses must not move when they do.

### How permission mode is proved

The mode is read from the target process's exact arguments through macOS `KERN_PROCARGS2` — never from a display name, never from anything in a message payload.

| argv value after `--permission-mode` | Proved mode |
|---|---|
| `bypassPermissions` | `bypass` |
| `default`, `plan`, `acceptEdits`, `auto` | `prompting` |
| flag absent, repeated, or any other value | proof fails; nothing is sent |

Measured on 2026-09-07 against Claude Code 2.1.260, whose `--permission-mode` accepts `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, and `plan`. Three consequences, none of them guesses:

- `acceptEdits`, `auto`, `plan` prove `prompting`. `bypassPermissions` proves `bypass`. These are the usable values today.
- `manual` and `dontAsk` are valid for Claude Code but are **not** mapped here, so a target launched with either fails closed with `permission mode argv cannot be proven`.
- `default` is still mapped here but is not offered by Claude Code 2.1.260.

Do not add a mapping to make an error go away. A mapping asserts what a mode permits, and that has to be checked against the Claude Code release it claims to describe.

The proved mode must equal `permissionMode` in your config or the send fails with `permission mode mismatch`. The process identity is re-checked immediately before and after reading argv.

This narrows what may be sent. It never widens anything: a process running as your uid can choose its own arguments, so argv is a ceiling, not an identity. See [../SECURITY.md](../SECURITY.md).

### Finding a session UUID

Each running Claude Code session publishes a private `0600` registry file under `~/.claude/sessions/<pid>.json` containing its `sessionId`, `pid`, `procStart`, `cwd`, `peerProtocol`, and `peerFeatures`. Read the one belonging to the session you want. A target is accepted only when `peerProtocol` is `1` and `peerFeatures` includes both `notify_idle` and `reply_across_default_dirs`. If exactly one live candidate does not match your `sessionId`, resolution fails with `target resolved to 0 live candidates` or `... 2 live candidates`.

This registry is a private Claude Code interface, not a documented API. It can change in any release.

### Changes are not picked up until you restart

`targets.json` is read once when the daemon starts (`src/daemon.mjs:21`) and once when the stdio entry point starts (`src/server.mjs:7`). Nothing watches the file. After editing it, stop the daemon and restart the MCP client — see [troubleshooting.md](troubleshooting.md).

## Environment variables

These are read from the environment of the process being started. Nothing in a request, a tool argument, or a config file can set them.

| Variable | Read by | Effect |
|---|---|---|
| `UNIVERSAL_PEER_MCP_STATE_DIR` | daemon, stdio entry point, tests | Overrides the state directory. The same `0700`/`0600`, owner, and symlink checks apply to the new location. Setting it to an empty string is treated as not setting it, so the default is used rather than the working directory. |
| `CLAUDE_PEER_MCP_STATE_DIR` | the same, as the former name of the variable above | **Deprecated.** Still read, so that a configuration written before this package was renamed keeps working; a process that reads it writes one line to stderr saying so. If both names are set to the same directory, nothing is said. If both are set to **different** directories the process refuses to start rather than pick one — half the installation would be on the directory that was not picked. It will stop being read in a later version. |
| `CLAUDE_PEER_MCP_ADMIN` | daemon only, at startup | `1` enables admin mode, which is the only way `daemon_shutdown` is exposed. Any other value, or absence, leaves it off. |
| `CLAUDE_PEER_MCP_EXTENSIONS` | daemon and stdio entry point, at startup | Comma-separated list. Only `milestone` and `code-review` are accepted; anything else makes the daemon refuse to start with `unsupported extension`. The CLI sets this for you from `--enable`. |

Those are all the variables the daemon and the stdio entry point read; the three still spelled `CLAUDE_PEER_MCP_*` keep that spelling for now. One more exists for the release checks only: `CLAUDE_PEER_MCP_DENY_TERMS` points `test/pack.test.mjs` at a file of extra strings that must not appear in anything this repository publishes. It is read by a test, never by the server.

## Command line

```text
universal-peer-mcp [serve [--enable milestone] [--enable code-review] | doctor]
```

- `serve` — run the stdio MCP server. This is what your MCP client should launch. It starts the daemon on demand if one is not already running.
- `doctor` — report platform, architecture, runtime, state directory, targets file, Claude session registry, and codex-wake status. Reads only: it never creates the state directory or any file. Its output goes through the same public projection the MCP tools use (`src/mcp/redact.mjs`), so it prints no token, session id, socket, or process argument, and the only path it prints in full is one under your own home, shortened to `~`. Anything else, including a state directory you pointed elsewhere and a path quoted inside an error message, comes out as `[path]`. The Claude registry check is a compatibility check, not just a permission check: an entry whose `peerProtocol` is not `1`, an entry missing `notify_idle` or `reply_across_default_dirs`, and an entry that will not parse each make `claudeRegistry.ok` false. Field by field: [troubleshooting.md](troubleshooting.md).
- Anything else, or an unknown `--enable` value, prints usage and exits `2`.

Extensions are off unless named. `milestone` and `code-review` add their own tools to the list; a `codex-wake` module exists in the tree but is disabled and exposes nothing.

## MCP client configuration

See [../examples/codex-config.toml](../examples/codex-config.toml) and [../examples/claude-mcp.json](../examples/claude-mcp.json). Both point at the installed `universal-peer-mcp` bin, or `npx -y universal-peer-mcp`, and neither contains a user-specific path. Immediately after installation there are zero targets, and the send tools stay closed until you write `targets.json` yourself.
