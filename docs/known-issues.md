# Known issues

Three things this package does not close. They are written down because a residual you can read
is worth more than one you find in production, and because two of them are the price of a
decision that was made on purpose.

## 1. A sender that writes and closes in one breath is refused

The receiver reads who wrote a frame from the kernel, with that frame. On this platform that is
`getsockopt(LOCAL_PEERPID)`, and it answers `ENOTCONN` the moment the writing side is gone. A
frame whose writer cannot be named is refused.

There used to be a fallback: the identity read when the connection was accepted, carried forward
under a weaker label. It was removed. `LOCAL_PEERPID` answers with the peer socket's *last*
writer, so a read taken at accept names the process that opened the connection and not the
process that wrote — measured, a child that inherited the descriptor, wrote and exited was handed
on as its parent, and that parent's identity carried the frame through to a delivered ACK and a
passing review. A label on weak evidence does not stop the evidence from being used. There is now
one rule and no second answer.

The cost falls on senders this package does not own:

```sh
# refused: the frames land, the writer is already gone, nothing can name it
printf '%s\n' "$AUTH" "$FRAME" | socat - UNIX-CONNECT:"$SOCKET"
```

A sender must **keep the connection open and let the receiver close it**. That is what
`src/adapters/claude-native-v1/transport.mjs` does, and `docs/demo-ack.md` shows the same shape
for a session answering by hand. The hold is what keeps the writer nameable; it is not an
exemption. This package's own frames meet the same rule, and are refused the same way, when its
own hold bound ends before the receiver has read them — see below.

This is fail-closed by design, not a defect: the alternative is attributing one process' bytes to
another, which is the whole thing the frame time read exists to prevent.

## 2. The hold on a written connection is bounded, and the bound is not a delivery guarantee

After writing, the sender keeps the connection so the receiver can still name the writer while it
works through the frames. The receiver's own close is the normal end of that hold. The bound is
the abnormal one: it exists so a hold cannot last forever when the other side never closes.

It does not promise the bytes were read. Measured on an M-series Mac under Bun 1.3.11 with a
1000 ms bound and a 250 ms close grace: `end()` fired at 1001.6 ms and the close landed at
1003.9 ms. A receiver that gets to the bytes more than about a second late is reading a socket
whose peer is gone — a receiver delayed by 1500 ms saw `ENOTCONN` and zero delivered frames.
Raising the bound moves the cliff; it does not remove it.

The loss is not silent, and it is not fully attributable either. When the bound is what ends the
hold, the sender records `peer_socket_hold_bounded`. What the receiver on the other end records
depends on where it had got to: a frame it has not read yet is refused with
`identity_unavailable`, and a frame it has already read and handled leaves nothing. A `peer_wait`
then reports `timedOut` rather than a delivery that did not happen.

`peer_socket_hold_bounded` says that our bound ended the hold, and nothing further. It is
recorded on a connection whose frames were all read as well as on one that was never read, so on
its own it is not evidence that the receiving session is slow — read it next to what the receiver
recorded, or did not. Nothing is retried automatically; recovery is `milestone_recover_ack` or a
new send with a new id, both of which stay on the ledger.

## 3. Reading a refusal

`peer_frame_refused` carries the connection it arrived on, the ordinal of the frame within that
connection, and why. The connection number is local to the receiver and counts from one, and the
ordinal is local to the connection: enough to group frames, and it names nothing outside this
machine. A frame refused before it authenticated is recorded with nothing else, because nothing
it claimed about itself had been checked.

| `reason` | what happened |
|---|---|
| `identity_unavailable` | The kernel could not name the writer for that frame. The writer had closed, or the process lookup behind the pid failed. |
| `identity_foreign_uid` | The writer resolved to a different uid. |
| `authentication_failed` | The first frame was not a valid `auth` frame for this receiver's token. |
| `unparsable_frame` | The line was not JSON. |
| `frame_too_large` | The unterminated buffer passed 1 MiB. |
| `inbound_identity_mismatch` | The frame answers one of our messages and was written by a process that is not the one that message was sent to. This one carries that `messageId`, because it is ours and checked, so a `peer_wait` on that message shows it. |
| `frame_handler_failed`, or an enabled extension's own cause | A handler downstream of the identity read rejected the frame. |

A frame that authenticated, was written by a process the kernel could name, and matched nothing
this daemon is waiting for is not refused. It is recorded as `peer_frame_uncorrelated`, with the
same connection and ordinal and one of `unknown_message_status`, `unknown_idle_notice`,
`unknown_reply_target` or `no_reply_marker`. It carries no `messageId`: there is none, and the id
such a frame names is an unverified claim about somebody else's ledger.

Every refusal ends the connection; an uncorrelated frame does not. "Refused", "arrived and
correlated to nothing" and "nothing arrived" are three different readings of the ledger, which is
the point of writing the first two down at all.

## Not on this list

Platform support (`darwin`/`arm64` only) is in [../COMPATIBILITY.md](../COMPATIBILITY.md).
Operational faults with a fix are in [troubleshooting.md](troubleshooting.md). Reporting a
security issue is in [../SECURITY.md](../SECURITY.md).
