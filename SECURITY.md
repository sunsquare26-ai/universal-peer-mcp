# Security

## Supported versions

Only the most recent released tag is supported. There are no long-term support branches and no backports to older tags. Fixes land on `main` and go out in the next tag.

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** on this repository: open the **Security** tab, then **Report a vulnerability**. That is the only intake channel. Do not open a public issue for a suspected vulnerability, and do not include real tokens, real session UUIDs, or real paths in the report — redact them.

What helps: the version or commit, `sw_vers` and `uname -m` output, `claude-peer-mcp doctor` output, and the smallest sequence of steps that reproduces the problem.

What to expect: an acknowledgement within 7 days and an assessment within 30 days. This is a small project maintained by one person, and those are targets, not a contract. If a report is out of scope you will be told why rather than left waiting.

## Trust boundary

**The real boundary is the uid.** This server is reachable only from the same macOS user account on the same machine. Any process running as that uid can talk to it. There is no network transport and no cross-user authentication.

Access control consists of a same-uid check on the connecting peer, a `0600` control token, a `0600` control socket inside a `0700` directory, and a match on the connecting process's PID and process start time.

## argv is not a kernel-guaranteed identity

The permission mode of a target is proved by reading the target process's exact arguments through macOS `KERN_PROCARGS2`, not by trusting a display name or anything in the message payload.

**A process running under the same uid can launch itself with any arguments it likes.** The argv comparison is therefore used only to *narrow* what may be sent, and never as grounds to widen or escalate a permission. Within one uid, argv forgery is not prevented, and this tool does not claim otherwise.

The `KERN_PROCARGS2` buffer layout used here was measured on 2026-09-03 on macOS/arm64. On any other macOS version or architecture it must be re-measured with a compatibility fixture. Where a cell is unmeasured it stays `unverified` in [COMPATIBILITY.md](COMPATIBILITY.md), and permission proof must not be treated as successful in that environment.

## No privilege escalation

There is no command that changes a permission mode. Whatever permission mode you launched Claude Code with is the ceiling for what can be sent to it. An inbound `from_mode` field is recorded as an observation only and never raises a permission.

Admin mode is read from the daemon's own startup environment. A request, a tool argument, or a config file cannot enable it. When admin mode is off, `daemon_shutdown` is not even listed as a tool.

## Private Claude Code interface

The `claude-native-v1` adapter reads an undocumented local session registry and speaks an undocumented local socket format. This is not a supported Anthropic API. It can change or disappear in any Claude Code update, and when it does, sends fail closed rather than falling back to something less checked. If you cannot accept that, do not deploy this.

The adapter refuses a target whose registry entry, socket, or key file is not a private, same-uid, non-symlink file, and re-verifies the target's identity between resolution and the socket write.

## What is never emitted

Tool results and logs exclude the control token, full socket paths, home directory paths, and real process arguments. Diagnostic identifiers are limited to the minimum needed to correlate one message.

State files are created `0600` inside a `0700` directory, written atomically, and `fsync`ed. Symbolic links, files owned by another uid, any group or other permission bit, and path traversal out of the state directory are all rejected at startup.

## Out of scope

- Attacks by another process running as the same uid. That is inside the trust boundary by design, and is stated as a limitation rather than defended against.
- Anything requiring root, or physical access to an unlocked machine.
- Behaviour of Claude Code, Codex, Bun, or macOS themselves. Report those to their own maintainers.
- Denial of service caused by the operator's own configuration, such as pointing the state directory at a full or unwritable volume.
- Cost incurred by a vendor CLI that you configured and ran yourself.
