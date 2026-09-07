# Troubleshooting

Every failure here is fail-closed by design: when something cannot be proved, nothing is sent and nothing is retried for you. The fix is almost always to make the fact true, not to loosen a check.

Most of what is below can be avoided by checking the target **before** installing anything: the four-point list is under "Before you install" in [../README.md](../README.md). A session that fails one of those checks cannot be repaired in place, and relaunching it changes its session UUID, so the order matters.

## Start here

```sh
universal-peer-mcp doctor
```

```json
{
  "ok": true,
  "platform": "darwin",
  "arch": "arm64",
  "runtime": "Bun 1.3.11",
  "stateDirectory": "~/Library/Application Support/claude-peer-mcp",
  "stateDirectorySource": "default",
  "system": {
    "platform": "darwin",
    "arch": "arm64",
    "release": "25.6.0",
    "supportedPlatforms": ["darwin"],
    "supportedArchitectures": ["arm64"],
    "platformSupported": true,
    "architectureSupported": true
  },
  "runtimes": {
    "bun": "1.3.11",
    "node": "24.3.0",
    "requiresBun": ">=1.3.0",
    "bunSatisfied": true
  },
  "state": { "ok": true, "present": false, "note": "created on first serve" },
  "targets": {
    "ok": true,
    "present": false,
    "count": 0,
    "note": "copy targets.example.json into the state directory to add targets"
  },
  "claudeRegistry": {
    "ok": true,
    "present": true,
    "private": true,
    "directory": "~/.claude/sessions",
    "supportedProtocol": 1,
    "requiredFeatures": ["notify_idle", "reply_across_default_dirs"],
    "entries": 4,
    "compatible": 4,
    "incompatible": 0,
    "unreadable": 0,
    "byProtocol": { "1": 4 },
    "missingRequiredFeatures": {},
    "note": "counts only — doctor never prints session ids, pids, sockets or tokens"
  },
  "codexWake": {
    "ok": true,
    "enabled": false,
    "helpChecked": false,
    "note": "codex wake is off — no codex CLI is invoked"
  },
  "note": "doctor does not print tokens or process arguments",
  "writes": "none — doctor never creates the state directory or any file"
}
```

That is a real run on a machine with no state directory yet and four live Claude Code sessions. Your counts will differ.

How to read it:

- `ok` — `true` only when the platform, the architecture, the Bun version, the state directory, the targets file, the Claude registry, and the codex-wake check are all satisfied. Any one `false` below makes it `false`.
- `system.platformSupported` / `architectureSupported` — compared against `os` and `cpu` in `package.json`, which are `darwin` and `arm64`. On x64 the architecture check is `false`, and that is correct: the permission proof has not been measured there. See [../COMPATIBILITY.md](../COMPATIBILITY.md).
- `runtimes.bun` and `bunSatisfied` — the running Bun version against `engines.bun`. If `bun` is `null`, this is not running under Bun and the package cannot work.
- `runtimes.node` — the Node compatibility version Bun reports, not the `node` binary on your `PATH`. Only `bun run check` uses the real `node`.
- `stateDirectorySource` — which name the state directory was read from: `UNIVERSAL_PEER_MCP_STATE_DIR`, the deprecated `CLAUDE_PEER_MCP_STATE_DIR`, `default`, or `argument`. If it says the deprecated name, the process also wrote one line to stderr; rename the variable where your MCP client sets it.
- `state` — `present: false` before the first `serve` is normal. When present, `ok` requires the directory and every state file to be owned by you with no group or other permission bits.
- `targets` — `present: false` means you have not created `targets.json` yet, and that is a clean install, not an error. If it is present but invalid, `schemaValid` is `false` and `reason` names the problem.
- `claudeRegistry` — counts only, and a compatibility verdict. `ok` is `true` when the directory is private, every entry parsed, and every entry that parsed is compatible: `peerProtocol` equal to `supportedProtocol` and both `requiredFeatures` present. `compatible` and `incompatible` split the entries; `unreadable` counts files that would not parse. `byProtocol` buckets the observed protocol — a whole number appears as itself, a missing field as `"absent"`, and anything else as `"invalid"`, because a value read out of that file is never echoed back to you. `missingRequiredFeatures` counts how many entries lacked each required feature. One old Claude Code session left running is enough to make `ok` false; close it or update it. `entries: 0` is not an error — it means no session is running right now. `private: false` means `~/.claude/sessions` has permissions it should not have.
- Paths in the output — the only path printed in full is one inside your own home, written with a leading `~`. Everything else, including a state directory you pointed somewhere else and any path quoted inside a `reason`, is replaced with `[path]`, and anything shaped like a credential with `[credential]`. If you need the literal path, you already know it: you set it.
- `codexWake` — `enabled: false` is the shipped state. No Codex CLI is invoked and no vendor cost is incurred.
- `doctor` writes nothing and creates nothing. A healthy `doctor` says the environment is sane; it does not say a target is reachable. Use `peer_status` for that.

## When you must restart the daemon

Targets are read once at daemon startup (`src/daemon.mjs:21`) and once at stdio entry point startup (`src/server.mjs:7`). Nothing watches the file. Restart after any of these:

- you added, removed, or edited an entry in `targets.json`
- you want to change which extensions are enabled
- you want to turn admin mode on or off
- you changed `UNIVERSAL_PEER_MCP_STATE_DIR`

Stop it:

```sh
kill "$(plutil -extract pid raw -- ~/Library/Application\ Support/claude-peer-mcp/daemon.json)"
```

`SIGTERM` is the supported path: the daemon removes its socket, identity file, lock, and control token on the way out. The next tool call starts a fresh daemon. Restart the MCP client too — the tool list embeds the alias set that was known when the entry point started, so a new alias will not appear until the client relaunches it.

If `daemon.json` is missing, no daemon is recorded as running and there is nothing to stop.

## `targetTableMismatch: true` in `daemon_status`, and every alias is refused

The daemon read `targets.json` once, when it started, and the file has changed since. Not "there are more rows now" — different rows: an alias that points at another session, another cwd or another permission mode counts, and so does one that was added or removed. While the two readings disagree, **every call that names an alias is refused with `target_unavailable`** before it reaches the daemon. Nothing is reserved and nothing is written.

It is refused rather than sent because the alias is a name for a row, and the daemon would send it to the row it is holding — a session you have just taken that name off. `targetCountMismatch` sits next to it and compares the number of rows only; it can be `false` while this one is `true`, which is exactly the case that used to go unnoticed.

Fix: stop the daemon as above and let your client start it again. It will read the current file. Or put the file back to what the daemon is holding, and the refusal lifts on the next call.

## `extensionMismatch: true` in `daemon_status`

The daemon that is actually running was started with a different extension set than the one this stdio entry point asked for. The daemon wins; a running daemon never loads an extension on request. `daemon_status` then reports both `enabledExtensions` and `requestedExtensions` alongside the flag.

Usual cause: a daemon is already running from an earlier client that had different `--enable` flags. Fix by stopping the daemon as above and letting your client start it again with the flags you want.

## The daemon will not start

| Message | What it means | What to do |
|---|---|---|
| `state directory must be an owned 0700 directory` | The state directory has a group or other permission bit, or belongs to another uid. | `chmod 700` it, and check who owns it. |
| `state directory must not traverse a symbolic link` | Some component of the path is a symlink. | Use a real directory. |
| `state file must be an owned private regular file` | A state file is a symlink, is owned by another uid, has group/other bits, or is over its size limit. | Inspect with `ls -l@`; delete the file only if you are sure it is yours. |
| `recorded daemon is alive but could not be authenticated` | A daemon is recorded, still running, and its identity did not verify. | Do not delete state. Find that process first; something is not what it claims to be. |
| `recorded daemon lock is owned by a live process` | Another daemon holds the lock. | Only one daemon per state directory. Stop the other one. |
| `stale daemon identity is malformed` / `daemon lock is malformed` | Leftover file with an unusable pid or start time. | Remove that single file from the state directory and retry. |
| `stale daemon artifact is not owned` | Leftover socket, token, or identity file owned by another uid. | Investigate before removing anything. |
| `unsupported extension` | `CLAUDE_PEER_MCP_EXTENSIONS` contains something other than `milestone` or `code-review`. | Fix the variable or use `--enable`. |
| `daemon readiness timed out` | The daemon did not publish an authenticated socket within 10 seconds. | Check that `bun` is on `PATH` for the client's environment. |
| `CLAUDE_PEER_MCP_STATE_DIR is the old name of UNIVERSAL_PEER_MCP_STATE_DIR` | Written to stderr, once per process. The old variable is still read, so nothing is broken. | Rename it where your MCP client sets it. |
| `UNIVERSAL_PEER_MCP_STATE_DIR and CLAUDE_PEER_MCP_STATE_DIR name two different state directories` | Both names are set, to two different directories. Nothing is chosen: half the installation would be on the one that was not chosen. | Unset `CLAUDE_PEER_MCP_STATE_DIR`, or set both to the same directory. |
| `control authentication failed` | The control token, connecting pid, uid, or process start did not match. | Almost always a stale client talking to a new daemon. Restart the client. |

## The target cannot be reached

| Message | Cause |
|---|---|
| `target resolved to 0 live candidates` | No running session matches that `sessionId`, or its registry file is not a private same-uid file. The session probably closed. |
| `target resolved to 2 live candidates` | More than one live registry entry claims that `sessionId`. Resolution refuses to guess. |
| `target cwd mismatch` | The session's resolved working directory is not the `cwd` in your config. Update the config; do not remove the check. |
| `unsupported Claude peer protocol` | The session's `peerProtocol` is not `1`, or it lacks `notify_idle` or `reply_across_default_dirs`. Usually a Claude Code version change — see [../COMPATIBILITY.md](../COMPATIBILITY.md). `universal-peer-mcp doctor` counts the same condition as `claudeRegistry.incompatible`. |
| `target process identity changed` | The pid is now a different process. This is exactly the pid reuse case the process start time exists to catch. Re-run `peer_status`. |
| `target socket is not private` / `target key is not private` / `target key identity mismatch` | The session's socket or key file is not a private same-uid file, or the key does not match the session's process start. Restart that Claude Code session. |
| `Claude sessions directory is not private` | `~/.claude/sessions` is not a `0700` directory you own. |

A session that was closed and reopened gets a new session UUID. Update `targets.json` and restart the daemon; there is no way to keep an alias pointed at "whatever session is there now", and adding one would defeat the addressing rule.

## Permission errors

| Message | Cause and fix |
|---|---|
| `permission mode argv cannot be proven` | The target was launched with no `--permission-mode` flag, or with a value that is not `bypassPermissions`, `default`, `plan`, `acceptEdits`, or `auto`. Relaunch it with an explicit flag. No default is assumed. Note that Claude Code 2.1.260 also accepts `manual` and `dontAsk`, which this adapter cannot map — use `acceptEdits`, `auto`, or `plan` for `prompting`. |
| `ambiguous permission mode argv` | `--permission-mode` appears more than once, or appears with no value after it. |
| `permission mode mismatch` | The proved mode is not the `permissionMode` in your config. Change the config to match reality, or relaunch the session. |
| `target argv executable mismatch` | `argv[0]` is not the same string as the executable path in the same kernel buffer — for example a process started by bare name through `PATH`. See "How a session has to be launched" below for the measurement and for what is *not* the cause. |
| `target argv unavailable` | The kernel buffer could not be read or its size, NUL structure, `argc`, or alignment was not what was measured. Nothing is sent. |
| `target identity changed before argv proof` / `during argv proof` | The process changed between checks. Retry `peer_status`. |

## How a session has to be launched

Two properties of the target's command line are checked, and neither can be set afterwards.

**The permission mode has to be on the command line.** No default is assumed. The mapping is in
[../README.md](../README.md) under "Register one target"; `auto` maps to `prompting` and is
enough for everything this package does.

**`argv[0]` has to equal the exec path the kernel recorded**, as a string
(`src/adapters/claude-native-v1/darwin-procargs.mjs:77`). Read the first token of the command line:

```sh
ps -p "$PID" -o args=
```

A path passes. A bare name does not. Measured on this machine, 2026-09-07, with `/bin/sleep`:

| launched as | kernel exec path | `argv[0]` | verdict |
|---|---|---|---|
| `/bin/sleep 25` | `/bin/sleep` | `/bin/sleep` | passes |
| `<dir>/sleeplink 25`, a symlink to `/bin/sleep` | `<dir>/sleeplink` | `<dir>/sleeplink` | **passes** |
| `sleep 25`, resolved through `PATH` | `/bin/sleep` | `sleep` | **fails** |

**A symbolic link is not the problem.** The kernel records the path given to `execve` without
resolving symlinks, so launching through a link produces the same string on both sides and passes.
What fails is letting the shell resolve a bare name through `PATH`: the shell hands `execve` the
resolved path and sets `argv[0]` to the name you typed. Do not run `readlink -f` to obtain a "real"
path for this — the resolved path can differ from what the kernel recorded, and using it as the
expected value would be wrong.

Relaunching a Claude Code session gives it a new session UUID, so `targets.json` has to be updated
and the daemon restarted afterwards.

An interactive session needs a controlling terminal. Started as a plain background job it has none
and exits. `tmux` supplies one, and the session stays addressable after the launching shell is gone:

```sh
tmux new-session -d -s peer-target '<path-to-claude> --permission-mode auto'
```

Measured 2026-09-07: the child of `tmux new-session -d` reports a tty from `ps -o tty=`, while the
same command backgrounded from a script reports `??`.

## Send and delivery

| Code | Meaning |
|---|---|
| `MESSAGE_ID_CONFLICT` | The same `messageId` was reused with different content. Use a new `messageId`; do not edit the body under the old one. |
| `DELIVERY_UNCERTAIN` | The socket write failed. Delivery is genuinely unknown and was not retried. Read `peer_list_events` for that `messageId` before deciding anything. |
| `RECOVERY_FORBIDDEN` | The message reached a terminal failure. It cannot be recovered. |
| `INVALID_CONTROL_ARGUMENTS` | `peer_send` received a field outside `alias`, `messageId`, `threadId`, `replyTo`, `kind`, `body`. |
| `unknown or unavailable daemon method` | The tool belongs to an extension that is not enabled, or to admin mode when admin mode is off. |

`peer_wait` returning `timedOut: true` is not a failure and not a reason to send again. It means no `ack`, `reply`, or `idle` marker had arrived yet. Sending again with a new `messageId` delivers a second message to a human.

Recovery is always explicit and always at most once. With the `milestone` extension, `milestone_recover_ack` opens one new transport attempt for an exact `completionMessageId` and `payloadHash`. There is no background retry loop anywhere in this codebase, and a crash never re-sends anything by itself.

## `peer_list_events` failed and the ledger did not

A `peer_list_events` response that carries a refusal event can be rejected in its entirety, so a
query fails while the events themselves are safely on disk. This is a known defect, not a broken
install, and not a reason to reinstall or to send anything again — see
[known-issues.md](known-issues.md) §4 for why the public event contract cannot carry the
diagnostic fields today.

Read the file. It is append-only and is fsynced before a connection ends.

```sh
LEDGER="${UNIVERSAL_PEER_MCP_STATE_DIR:-$HOME/Library/Application Support/claude-peer-mcp}/events.jsonl"

grep '<messageId>' "$LEDGER"                                  # everything about one message
grep -E '"peer_frame_(refused|uncorrelated)"' "$LEDGER"       # why a frame was turned away
```

For the same reason, make the file the **first** check when confirming a round trip and
`peer_list_events` the second. Bytes written is not delivery either: to confirm arrival, look for
the `messageId` in the receiving session's own transcript under
`~/.claude/projects/<cwd slug>/<sessionId>.jsonl`.

An older state directory can fail the same query for an unrelated reason: `connectionId` changed
from a uuid to an integer, so events written by an earlier receiver do not satisfy the current
public shape. A fresh state directory has none of them.

## Display name changed

Nothing is broken. A name mismatch records a `display_name_observed` event and shows up in status; it never blocks a send, because names are not addresses. Update `expectedDisplayName` when you want the diagnostic to go quiet.

## Version drift

The `claude-native-v1` adapter reads a private Claude Code interface. After a Claude Code update, target resolution can start failing with `unsupported Claude peer protocol` or a socket check. That is the design working: it fails closed instead of guessing. Record what you measured in [../COMPATIBILITY.md](../COMPATIBILITY.md) and open an issue with the version numbers.

## Which "known issues" document

There are two, they are different documents, and neither replaces the other.

| Where | File | What is in it |
|---|---|---|
| this repository | `docs/known-issues.md` | what the design does not close, and why |
| a handoff package | `KNOWN-ISSUES.md` at the package root | the measurements, error table and review residue for that one handoff |

If a handoff told you to read `KNOWN-ISSUES.md` and you are looking at this repository, the file
you want is [known-issues.md](known-issues.md) — and it is not the same text.
