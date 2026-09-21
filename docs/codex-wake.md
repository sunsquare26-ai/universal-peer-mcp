# Wake an existing Codex thread

`universal-peer-mcp serve --enable codex-wake` exposes `codex_status` and
`codex_wake`. Claude targets and Codex targets remain separate: `peer_send`
continues to address Claude sessions. To notify Codex, use `codex_wake`.

The previous codex-wake module was a disabled placeholder. No dispatcher or
transport existed, so polling a peer inbox could not start a Codex turn.

Create an owned mode-0600 `codex-targets.json` in the configured universal-peer
state directory (the same directory as `targets.json`):

```json
{
  "review": {
    "socketPath": "/absolute/private/app-server.sock",
    "threadId": "00000000-0000-4000-8000-000000000001",
    "cwd": "/absolute/project"
  }
}
```

The socket must belong to the current user and have mode 0600. It must be an
**existing Codex app-server listener**, not the universal-peer control socket or
ChatGPT's application IPC socket. The bound thread must already be loaded in
that server, with the configured working directory. The adapter connects using WebSocket over the Unix socket. CLI 0.155.1
`app-server --listen unix://PATH` exposes this transport. Its `app-server proxy`
command was measured to send raw bytes, which the WebSocket listener rejects;
this adapter performs the required upgrade directly.

Call `codex_status({"codexAlias":"review"})` first. It is read-only and free of
model calls. A status of `unavailable` means no wake is possible through that
binding. The adapter does not restart an app or create another server/session.

After authorizing the receiving thread's usual model cost, call:

```json
{"codexAlias":"review","messageId":"00000000-0000-4000-8000-000000000002","body":"The requested implementation is ready to inspect."}
```

An idle thread receives `turn/start`; an active thread receives `turn/steer`
with its observed active turn ID as a precondition. No model, effort, sandbox,
approval, or cwd override is sent. Peer content is labeled as peer input.
`accepted` means the existing server acknowledged the turn request; it does
not mean the task has completed. A concurrent turn-state change is reported
as uncertain, without a fallback that could create a second turn.

Keep the same `messageId` when checking a result again. Completed receipts
replay without sending again. Lost acknowledgements and in-flight duplicates
return `delivery_uncertain` and are never retried automatically. Reusing an ID
with different content fails. Receipts store hashes and turn IDs, not bodies.

## Actual application limitation verified 2026-09-21

The running ChatGPT-bundled Codex app-server on this machine uses stdio, with
no publicly accessible app-server listener. Its `~/.codex/ipc/ipc.sock` belongs
to ChatGPT and is not this protocol. Installing this adapter cannot retrofit
a listener into that process. No app restart or alternative `codex exec resume`
session was used. This running ChatGPT thread therefore remains unavailable
for external wake until the host exposes an app-server transport. Do not report
a new CLI session as having awakened the existing application thread.

Tests cover idle/active dispatch, same-server ownership, cwd mismatch, durable
deduplication, lost acknowledgements, concurrent sends, public MCP output, and
the actual WebSocket-over-UDS transport using a fixture. A separate real
Codex 0.155.1 app-server also passed initialize and thread/loaded/list (0 loaded
threads; 0 model calls); only that temporary verification server was stopped. No paid model call is made by
the tests. Live model-turn execution is not yet verified.

## Remaining integration and unverified behavior

Explicit tools and an opt-in automatic bridge are available. Existing installations
remain unchanged unless their daemon is explicitly started with the bridge enabled.
The current ChatGPT host listener limitation below applies to both paths.

The connection closes after a turn acknowledgement. Whether a particular host
continues that turn after this auxiliary client disconnects, and routes any later
approval request to its UI, has **not** been verified with a real model turn.
The transport deliberately ignores server-originated approval/input requests and
never responds with either approval, denial, or a JSON-RPC error. A fixture verifies
this non-interference; it does not prove every host's request ownership semantics.

The Node helper bridges WebSocket over UDS because Bun 1.3.11's built-in `ws`/HTTP
shims did not implement the required socket upgrade in our checks. Node must be on
PATH. The helper is not a Codex subprocess and makes no model calls itself. The
pinned ws 8.21.3 dependency had 0 npm audit findings at verification time.

For the current stdio-only ChatGPT app, no verified setting was found that exposes
its already-running app-server listener. Merely starting an independent
`codex app-server --listen unix://PATH` does not expose the existing app thread.
A host-provided listener/bridge is required; no app restart or configuration
change is prescribed as a proven fix.

## Automatic peer-event bridge

The daemon can route verified `peer_reply` and `milestone_completion_accepted`
events to an allowlisted Codex thread. No model, effort, or permissions are
changed. Enabling automatic wake can incur the destination thread's normal model
cost; authorize that workload before enabling it.

Create owned mode-0600 `codex-wake-bridge.json` beside `codex-targets.json`:

```json
{
  "routes": [
    {
      "peerAlias": "worker",
      "codexAlias": "review",
      "events": ["peer_reply", "milestone_completion_accepted"]
    }
  ]
}
```

`worker` must already be allowlisted in `targets.json`; `review` resolves through
`codex-targets.json`. The sender alias comes from the original durable request,
not an incoming frame's assertion. Only events correlated to that request and
thread are eligible. No source message body, verdict text, or milestone payload
is copied into the wake notification or its new receipt. The notification carries
only event type, peer alias, and request/response IDs, directing Codex to inspect
its existing ledger.

Start the universal-peer daemon with `serve --enable codex-wake-bridge`; add
`--enable milestone` to produce milestone completion events and optionally
`--enable codex-wake` for the manual tools. An already-running daemon retains its
startup extensions: changing an MCP facade's arguments does not hot-enable the
bridge. Use the installation's normal daemon restart procedure only when existing
work permits it; this patch has not restarted the user's daemon or application.

First enable starts at the current event-log tail. To intentionally process older
events on the **first** enable, add `"afterSeq": 0` (or a chosen existing sequence)
to the configuration. Once created, the durable cursor takes precedence; changing
`afterSeq` later cannot replay processed events. Configuration is read once on
daemon startup.

The private `codex-wake-bridge/` directory contains `cursor.json` and per-event
receipt files. States are `reserved`, `accepted`, `unavailable`, or `uncertain`;
`cursor.json` records the latest delivery outcome. Deterministic message IDs are
bound to the event kind, response/completion ID, source alias, and destination
alias. A duplicate event at a later sequence or a daemon restart therefore does
not dispatch twice. A crash after reservation is treated as uncertain even if no
send can be proven, prioritizing at-most-once dispatch over silent retries.

A missing listener records `unavailable` and advances the cursor. Lost replies and
in-flight reservations record `uncertain`. Neither is automatically retried when
the host returns, a new event arrives, or the daemon restarts. The bridge has no
polling timer: it runs at startup and after inbound frame processing. Distinct new
events are processed normally. Storage corruption stops the bridge and records
`bridge_storage_failure` in the checkpoint when storage is still writable; the
peer receiver continues its own work.

Integration tests feed real `EventStore` records through the bridge and actual
`CodexWake` dispatch with a fixture app-server response layer, covering source
correlation, duplicate events, restart, unavailable listeners, lost acknowledgement,
crash reservation, privacy, and first-enable cursors. Real model turns remain
unverified and no paid model calls were made.
