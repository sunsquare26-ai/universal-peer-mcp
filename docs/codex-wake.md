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

This patch adds an explicit callable wake transport. It does **not** automatically
subscribe to existing `peer_reply`/milestone ledger events and wake a Codex thread.
A caller must invoke `codex_wake` for now. Automatic event routing remains separate
work and must bind the receiving thread and deduplication IDs explicitly.

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
