# universal-peer-mcp

Claude Code can hand work to another Claude Code session on the same computer. `universal-peer-mcp` lets a local MCP client — Codex, or another Claude Code — join that conversation. It connects only to sessions that are already running and that you have put on an allowlist yourself.

It is a local stdio MCP server plus a per-user daemon. Nothing listens on a network port.

## Trust boundary

Read these four before installing. They are properties of the design, not settings.

1. **Same Mac, same user account.** Access is gated by a same-uid check and a `0600` control token. Any other program running as the same uid can use this server.
2. **Admin mode is decided when the daemon starts.** It comes from the daemon's own startup environment (`CLAUDE_PEER_MCP_ADMIN=1`). No later request, tool argument, or config file can turn it on.
3. **`SIGTERM` cleans up.** On `SIGTERM` or `SIGINT` the daemon removes its socket, identity file, lock, and control token before exiting.
4. **Changing target config requires restarting the daemon.** Targets are read once at startup and are not reloaded while the daemon runs.

## What it is not

- Not an official Anthropic or OpenAI project. See [TRADEMARKS.md](TRADEMARKS.md).
- Not a permission escalator. The permission mode you launched Claude Code with is the ceiling; this server has no command that changes it.
- Not a retry queue. A failed send is never retried automatically.
- Not a tamper-proof ledger. The event file is an append-only local file for surviving restarts, nothing more.
- Not a session launcher. It never starts, stops, or focuses a Claude Code window.
- Not a remote or multi-user tool. There is no network transport.

## Requirements

| Item | Requirement |
|---|---|
| OS | macOS. The package declares `"os": ["darwin"]`. |
| Architecture | arm64. The package declares `"cpu": ["arm64"]`, so x64 is refused at install time. It is untested, not merely unsupported — see [COMPATIBILITY.md](COMPATIBILITY.md). |
| Runtime | Bun >= 1.3.0 (`engines.bun`). The `bin` runs under `#!/usr/bin/env bun`. |
| Peer session | A running Claude Code session that publishes its local peer registry under `~/.claude/sessions/`, with `peerProtocol` 1 and the features `notify_idle` and `reply_across_default_dirs`. |
| Target launch | The target session must have been started with an explicit `--permission-mode` flag. Without it the permission proof fails closed rather than assuming a default. |
| MCP client | A client speaking MCP `2026-07-28` or `2025-06-18` over stdio. |

## Before you install

Four facts have to be true of the session you intend to talk to. Every one of them is enforced
fail-closed, so none can be loosened in configuration, and a session that fails one cannot be
repaired in place — relaunching it gives it a new session UUID. Check all four **before** you
install anything.

```sh
PID=<the target session's pid>

ps -p "$PID" -o args=                                  # 1 and 2, read the line yourself
cat ~/.claude/sessions/"$PID".json                     # 3 and 4
```

1. **`argv[0]` is a path, not a bare name.** The first token of `ps -o args=` must be the same
   string the kernel recorded for the exec. A session started as `claude --resume ...` through
   `PATH` fails; one started as `/some/path/claude --resume ...` passes. A symbolic link is fine:
   what is compared is the string handed to `execve`, and it is not resolved. Do not run
   `readlink -f` to "fix" this — the resolved path can differ from what the kernel recorded.
   Details and the measurement: [docs/troubleshooting.md](docs/troubleshooting.md).
2. **An explicit `--permission-mode` flag is on that line**, with a value this adapter maps. See
   the table under [Register one target](#register-one-target). `auto` is enough; `bypassPermissions`
   is not required and this package never asks for it.
3. **`~/.claude/sessions/<pid>.json` exists** and carries `peerProtocol: 1`, both
   `notify_idle` and `reply_across_default_dirs` in `peerFeatures`, and a `messagingSocketPath`.
4. **Its `cwd` is the absolute path you will write into `targets.json`**, after symlinks.

If a session fails 1 or 2 and you own it, relaunch it. An interactive session needs a terminal:
started from a plain background job it has no controlling tty and exits. `tmux` gives it one.

```sh
tmux new-session -d -s peer-target '<path-to-claude> --permission-mode auto'
```

Measured 2026-09-07: a child of `tmux new-session -d` reports a tty from `ps -o tty=`; the same
command backgrounded from a script reports `??`.

## Install

**Start here: install a tarball you were handed.** That is the shortest path and the only one a
test in this repository exercises — `test/install.test.mjs` installs a tarball into an empty
prefix with the network unavailable, runs the installed bin, and uninstalls. You do not need
this repository, a clone, or `git` to install.

```sh
shasum -a 256 ./universal-peer-mcp-0.1.0.tgz          # compare against the hash you were given
npm install -g "./universal-peer-mcp-0.1.0.tgz"
```

To keep the machine's global npm prefix untouched, install into a prefix of your own. This is
the exact shape the install test runs.

```sh
PREFIX="$HOME/.universal-peer-mcp-local"
mkdir -p "$PREFIX"
npm install -g --prefix "$PREFIX" --no-audit --no-fund --ignore-scripts \
  "./universal-peer-mcp-0.1.0.tgz"
BIN="$PREFIX/bin/universal-peer-mcp"
```

The package has no dependencies; the installed tree contains no `node_modules`.

The other ways in, for when you have repository access or once there is a release:

| Path | Status |
|---|---|
| `npm install -g universal-peer-mcp` | **Not available yet.** There is no registry release, so this command fails today. The same applies to `npx -y universal-peer-mcp`. |
| `npm install -g "github:sunsquare26-ai/universal-peer-mcp#<tag>"` | **Works once the repository is public**, with `<tag>` replaced by a tag from the Releases page. Not verified here, because the repository is not public yet. |
| Pack it yourself from a clone | Needs repository access. `npm pack` from a clean working tree, then install the tarball as above. |

```sh
npm pack
npm install -g "./universal-peer-mcp-$(node -p "require('./package.json').version").tgz"
```

Check the install. `doctor` only reads; it prints no token, no process arguments, and no absolute path other than the `~` shorthand for your own home.

```sh
universal-peer-mcp doctor
```

The summary fields of a healthy result:

```json
{
  "ok": true,
  "platform": "darwin",
  "arch": "arm64",
  "runtime": "Bun 1.3.11",
  "stateDirectory": "~/Library/Application Support/claude-peer-mcp",
  "stateDirectorySource": "default",
  "note": "doctor does not print tokens or process arguments",
  "writes": "none — doctor never creates the state directory or any file"
}
```

The full document also carries `system`, `runtimes`, `state`, `targets`, `claudeRegistry`, and `codexWake`. `ok` is `true` only when every one of those is satisfied. Field by field: [docs/troubleshooting.md](docs/troubleshooting.md).

## Register one target

State lives outside the package, in `~/Library/Application Support/claude-peer-mcp/` — the directory keeps this package's former name, `claude-peer-mcp`, so that an existing event log is not stranded. The directory must be `0700` and the files `0600`; the daemon refuses to start otherwise.

```sh
mkdir -p ~/Library/Application\ Support/claude-peer-mcp
chmod 700 ~/Library/Application\ Support/claude-peer-mcp
```

Copy the shipped example out of the installed package and edit it. `npm root -g` prints where global packages live:

```sh
cp "$(npm root -g)/universal-peer-mcp/targets.example.json" ~/Library/Application\ Support/claude-peer-mcp/targets.json
chmod 600 ~/Library/Application\ Support/claude-peer-mcp/targets.json
```

Working from a clone instead of an install, copy `targets.example.json` out of the checkout.

```json
{
  "frontend-review": {
    "sessionId": "10000000-0000-4000-8000-000000000001",
    "cwd": "/path/to/project",
    "expectedDisplayName": "Frontend review",
    "permissionMode": "prompting"
  }
}
```

- `sessionId` — the exact session UUID of the running Claude Code session. This is the address. The name shown on screen is never used as an address.
- `cwd` — an absolute path that must resolve, after symlinks, to the session's own working directory.
- `permissionMode` — `prompting` or `bypass`. It must match the mode proved from the target process's real arguments, otherwise the send fails. This file holds the **mapped** value, not the flag: a session launched with `--permission-mode auto` is written here as `"prompting"`.
- `expectedDisplayName` — optional, diagnostic only. A mismatch is recorded and shown; it never blocks a send.

The whole mapping, from `src/adapters/claude-native-v1/darwin-procargs.mjs:90`:

| `--permission-mode` on the target | value in `targets.json` |
|---|---|
| `default` | `prompting` |
| `plan` | `prompting` |
| `acceptEdits` | `prompting` |
| `auto` | `prompting` |
| `bypassPermissions` | `bypass` |
| anything else, or the flag absent | not mappable — `permission mode argv cannot be proven` |

`auto` is enough. Nothing in this package needs `bypassPermissions`, and nothing here can raise
the mode a session was launched with. Claude Code 2.1.260 also accepts `manual` and `dontAsk`;
this adapter does not map them, and no mapping is added to make an error go away.

The shipped `cwd` is the placeholder `/path/to/project`, which does not exist. Until you replace it with a real absolute path, `doctor` reports `targets.schemaValid: false` — that is the file being checked, not a broken install.

Full schema, all environment variables, and how to find a session UUID: [docs/configuration.md](docs/configuration.md). Korean walkthrough for opening the session and answering it: [docs/threads-launch-ko.md](docs/threads-launch-ko.md).

**Restart the daemon after any edit to `targets.json`.** The daemon reads targets once at startup (`src/daemon.mjs:21`) and the stdio entry point reads them once as well (`src/server.mjs:7`). Neither watches the file.

```sh
kill "$(plutil -extract pid raw -- ~/Library/Application\ Support/claude-peer-mcp/daemon.json)"
```

The next tool call starts a fresh daemon. Restart your MCP client too, so the tool list picks up the new aliases.

## Register the server with your MCP client

**This changes your client's own configuration, so it is the client owner's decision, not a step
this package requires.** Nothing here writes a client config; the commands below are shown so the
owner can see exactly what would change, and the equivalent config blocks are shown so the change
can be reviewed before it is made. `claude mcp add` defaults to `local` scope — do not reach for
`-s user` unless the owner asked for a machine-wide change.

Codex — add the block from [examples/codex-config.toml](examples/codex-config.toml) to `~/.codex/config.toml`, or:

```sh
codex mcp add claude-peer -- universal-peer-mcp serve
```

Claude Code — use [examples/claude-mcp.json](examples/claude-mcp.json), or:

```sh
claude mcp add claude-peer -- universal-peer-mcp serve
```

Optional extensions are off by default and are enabled only on the daemon's command line:

```sh
universal-peer-mcp serve --enable milestone --enable code-review
```

## Status, send, wait

There is no CLI for messaging. Everything below is an MCP tool your client calls. The tool list order is fixed.

| Tool | What it does |
|---|---|
| `peer_targets` | Lists aliases with their configured permission mode and connection state. |
| `peer_status` | Re-proves one target's identity and permission mode without sending anything. |
| `peer_send` | Sends one message. Requires `alias`, `messageId`, `threadId`, `kind`, `body`. |
| `peer_wait` | Waits for `ack`, `reply`, or `idle` for one `messageId`. |
| `peer_list_events` | Reads durable local events after a sequence cursor. |
| `daemon_status` | Reads redacted daemon health and the event cursor. |

`daemon_shutdown` appears only when the daemon was started in admin mode.

Notes that change how you read the results:

- `messageId` is **yours**, and it is the idempotency key. The same `messageId` with the same content returns the earlier result instead of sending again. The same `messageId` with different content is rejected as a conflict.
- `body` is 1–65,536 **bytes** of UTF-8 (`src/core/limits.mjs:1`). The published JSON Schema says `maxLength: 65536`, which JSON Schema counts in characters, so non-ASCII text reaches the real limit sooner. `kind` is 2–64 characters matching `^[a-z][a-z0-9_-]{1,63}$`.
- `peer_wait` defaults to `require: "reply"` and a 30,000 ms timeout, with a 300,000 ms ceiling. It never resends.
- ACK means a defined marker arrived, not that the other side agreed. The result carries `evidence` distinguishing `message_status`, `idle_notice`, and `application_ack`.
- After a failed send the result is `DELIVERY_UNCERTAIN`. Delivery is unknown and nothing is retried for you.

One call, with the arguments your client sends:

```json
{
  "alias": "frontend-review",
  "messageId": "10000000-0000-4000-8000-000000000021",
  "threadId": "10000000-0000-4000-8000-000000000020",
  "kind": "review_request",
  "body": "Run the test suite in /path/to/project and report pass or fail."
}
```

Then wait for the answer to that exact message:

```json
{ "messageId": "10000000-0000-4000-8000-000000000021", "require": "reply", "timeoutMs": 30000 }
```

The other side answers with a first line of `PEER_ACK v=1 ...` or `PEER_REPLY v=1 ... verdict=pass`. The whole round trip, end to end: [docs/demo-ack.md](docs/demo-ack.md).

### Checking what actually happened

**Read the ledger file first.** It is append-only and fsynced before a connection ends, so it holds
every event including the ones the public contract cannot carry.

```sh
grep '<the messageId you sent>' \
  "${UNIVERSAL_PEER_MCP_STATE_DIR:-$HOME/Library/Application Support/claude-peer-mcp}/events.jsonl"
```

`peer_list_events` is the second look, not the first, and **it can fail where the file does not.**
A response carrying a refusal event can be rejected as a whole — see
[docs/known-issues.md](docs/known-issues.md) §4. That failure is not a broken install and not a
reason to reinstall or resend: it is the known defect being observed, and the events it could not
return are in the file above.

Bytes written is not delivery. To confirm arrival, look for the `messageId` in the receiving
session's own transcript under `~/.claude/projects/<cwd slug>/<sessionId>.jsonl`.

## Uninstall

```sh
kill "$(plutil -extract pid raw -- ~/Library/Application\ Support/claude-peer-mcp/daemon.json)"
codex mcp remove claude-peer
claude mcp remove claude-peer
npm uninstall -g universal-peer-mcp
rm -rf ~/Library/Application\ Support/claude-peer-mcp
```

The last line deletes your targets and the local event history. Nothing outside that directory is touched.

## Documentation

- [docs/configuration.md](docs/configuration.md) — target schema, environment variables, state layout.
- [docs/troubleshooting.md](docs/troubleshooting.md) — restarts, extension mismatch, dead targets, permission errors.
- [docs/known-issues.md](docs/known-issues.md) — what is not closed: refused write-and-close senders, the hold bound, how a refusal reads, and why its reason is on the ledger only. A handoff package ships a separate root-level `KNOWN-ISSUES.md` with the measurements and review residue for that specific handoff; the two are different documents and neither replaces the other.
- [docs/trial-findings.md](docs/trial-findings.md) — what broke when this package was first handed to someone outside the project, and what the install documents were changed to (Korean).
- [docs/demo-ack.md](docs/demo-ack.md) — one sanitized round trip: send, ACK, reply, wait.
- [docs/architecture.md](docs/architecture.md) — how the pieces fit (Korean).
- [docs/threads-launch-ko.md](docs/threads-launch-ko.md) — Korean quick start.
- [SECURITY.md](SECURITY.md) · [COMPATIBILITY.md](COMPATIBILITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [TRADEMARKS.md](TRADEMARKS.md)

## License

Apache-2.0. See [LICENSE](LICENSE). Copyright 이형석 (Hyungseok Lee).

Anthropic, Claude, OpenAI, and Codex are trademarks of their respective owners. This project is not an official Anthropic or OpenAI project and is not affiliated with, endorsed by, or sponsored by either company.
