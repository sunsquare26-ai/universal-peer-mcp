# `onCorrelatedReply` — the return path hook

This is a contract other code is written against. The name and the field names below are the
contract; changing either breaks implementations that are not in this repository.

## What it is for

`frameObserver` (`src/core/peer-core.mjs`) calls its observers for **every** frame that arrives,
whether or not core could correlate it — that is what makes an observer useful for an extension
with its own marker, and useless for a return path. An observer cannot tell "this answers a
message we sent" from "this arrived on the socket", and it is handed a frame whose fields are
claims by the writer.

`onCorrelatedReply` is called **only** for a reply that core authenticated and correlated, after
the ledger row for it is durable. It also carries the one thing the ledger does not keep: the text
the peer wrote.

## The call

```js
onCorrelatedReply({
  requestMessageId,   // string, uuid — the messageId this reply answers; the id you sent under
  responseMessageId,  // string, uuid — the peer's own id for its reply
  threadId,           // string, uuid — the thread both sides carry
  alias,              // string      — the target alias, read off the request (see below)
  verdict,            // "pass" | "fail" for a reply; null for an ack
  body,               // string      — the envelope body exactly as it arrived (see below)
  peer: { pid, procStart },  // the process the kernel named as the writer of that frame
  evidence            // "application_ack"
})
```

The return value is awaited and otherwise ignored.

## When it is called

Both markers, once each, per correlated frame:

- `PEER_ACK` → `verdict: null`, after the `peer_ack` row is written.
- `PEER_REPLY` → `verdict: "pass" | "fail"`, after the `peer_reply` row is written.

The marker may arrive bare or inside a `<cross-session-message>` envelope; the envelope is off
before the hook is reached, and it makes no difference to the call.

## When it is **not** called

This is the half that matters, and it is the reason the hook exists:

- the frame carries no marker on its first line (`no_reply_marker`);
- the marker names a `reply_to` this ledger has no request for, or a `threadId` that is not that
  request's (`unknown_reply_target`);
- the frame's writer is not the process the original message was sent to — the pid or the process
  start time does not match the snapshot taken at send time. That case **throws**; nothing is
  written and the hook is not reached;
- the ledger append fails. The hook follows the row; it does not precede it;
- a control frame — a delivery status or an idle notice — arrives. Those are not replies.

## `alias`

Read from the `send_requested` row this reply correlated to (`targetAlias`), which is the alias
the caller named and the row the identity check was made against. It is **never** read from the
frame. A frame can carry any field a writer chooses, including an `alias`, and that field is not
evidence of anything.

## `body`

The envelope body as it arrived, unwrapped: the marker line, then a newline, then whatever the
peer wrote after it. Split on the first newline to get the text.

It is **not** written to the ledger and must not be. The event log is read back through the
published tool contract, which has no field for a message body, and a body is the caller's
content — it goes to the hook and is dropped. If you need it after the fact, keep it yourself.

## Installing it, and refusing to run without it

The hook is a constructor option on `PeerCore`:

```js
import { CORRELATED_REPLY_HOOK, PeerCore } from "universal-peer-mcp/src/core/peer-core.mjs";

if (!PeerCore.capabilities.includes(CORRELATED_REPLY_HOOK)) throw new Error("build has no return path hook");
const core = new PeerCore({ targets, store, address, onCorrelatedReply: async (reply) => { /* … */ } });
```

Two ways to find out, both fail-closed, and neither of them is reading this page:

- `import { CORRELATED_REPLY_HOOK }` does not link against a build that does not have it — the
  process fails to start rather than running with a hook that is never called;
- `PeerCore.capabilities` is a static, so it can be asked before anything is constructed. It
  contains `"onCorrelatedReply/v1"` in this build.

A value that is not a function is refused when the core is constructed, not at the first reply.

## Failure

A hook that throws does not undo the reply — the row is already durable and already correct — and
does not refuse the frame either: the peer did nothing wrong, and refusing would destroy its
connection for a fault on this side. The throw is caught and recorded as `peer_reply_hook_failed`,
carrying the `messageId`, the `alias`, and the thrower's own `code` under `errorCode`
(`CORRELATED_REPLY_HOOK_FAILED` when it set none).

## What the shipped daemon does with it

Nothing. `src/daemon.mjs` builds its core without a hook and loads no third-party module: the
extension list it accepts is closed, and a daemon that could be pointed at arbitrary code by
configuration is a different security question than the one this package has answered. The hook is
for a process that embeds `PeerCore` itself.

Pinned in `test/correlated-reply.test.mjs`.
