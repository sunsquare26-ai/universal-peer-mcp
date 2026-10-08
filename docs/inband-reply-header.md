# The in-band reply header

A second way to correlate a reply, for a sender that has no field to put a correlation id in.

## Why there is a second one

`parseMarker` (`src/adapters/claude-native-v1/protocol.mjs`) reads the strict marker:

```
PEER_REPLY v=1 message_id=<uuid> thread_id=<uuid> reply_to=<uuid> verdict=pass
```

Three full uuids, a version, and a verdict from a closed list. A caller driving this package can
state all of them, because it chose the ids before it sent.

A Claude Code session answering over its own transport cannot. Its reply tool takes the recipient,
the text and a summary and nothing else — measured on 2026-09-11 over 508 calls in one session, the
input key set was `["content","message","recipient","summary","to","type"]` every time — so there
is no parameter for a correlation id, and no id of its own to state either: the transport mints the
message id after the body is written. The only channel it has is the text.

On 2026-09-11 that session wrote a first line on every reply and none of them parsed. The lines it
wrote were, verbatim:

```
PEER_REPLY thread=a4000000 replyTo=a2000000-0000-4000-8000-000000000002 roundtrip=OK
PEER_REPLY thread=a4000000 re=a2000000-0000-4000-8000-000000000002 verdict=delivery-OK-correlation-impossible
PEER_ACK thread=a4000000 review=in-progress board=queued
```

Against the strict grammar each is missing `v=1` and `message_id=`, spells `thread_id` as `thread`
and `reply_to` as `replyTo` or `re`, abbreviates the thread to eight hex digits, and puts a label
where a `pass`/`fail` verdict belongs. Thirty-seven frames were read and dropped under
`no_reply_marker` that day against one that correlated.

## The grammar

```
PEER_ACK   <token> [<token> ...]
PEER_REPLY <token> [<token> ...]
```

on the **first line**, then a newline, then the message. One to twelve `key=value` tokens separated
by spaces or tabs, in any order. Recognised keys:

| key | aliases | value | required |
| --- | --- | --- | --- |
| `re` | `replyTo`, `reply_to` | the id being answered, or its leading hex (8–32 digits, dashes optional) | **yes** |
| `thread` | `threadId`, `thread_id` | the thread, or its leading hex | no |
| `message_id` | `messageId`, `mid` | the sender's own id for this reply, a full uuid | no |
| `verdict` | — | `pass` or `fail` | no |
| `v` | — | `1` | no |

Keys are matched case-insensitively and `-` reads as `_`. **Any token that is not on this list is
ignored**, so `kind=diagnosis`, `roundtrip=OK` and `board=queued` are labels and not errors. A
`verdict` that is not `pass` or `fail` is read as no verdict rather than as a failure.

A duplicate of a recognised key, an unparsable value for one, `v` other than `1`, or a line with no
`re` at all leaves the frame uncorrelated. A line naming only a thread is uncorrelated on purpose:
a thread holds many messages and picking one of them would bind the answer to a message nobody
chose.

## What it is not

- It does not replace the strict marker. `parseMarker` is tried first and is unchanged, so every
  line that parses today parses identically.
- It is not authentication. The writer of the frame is still the process the kernel named, checked
  against the snapshot taken when the message went out (`#assertPeer`). A header that correlates to
  a request sent to another process still refuses the frame.
- A frame correlated this way is recorded with `evidence: "inband_header"`, never
  `"application_ack"`, so the ledger does not claim the stricter proof for the weaker line.
- A reference is matched as a prefix against ids this ledger already holds. It narrows; it does not
  name. A prefix matching more than one request is refused as `ambiguous_reply_reference` rather
  than resolved.

## The body

Correlation and the body are separate problems and the body is the one that comes first.

Every inbound frame's body is written to `<state dir>/inbound/<file>.txt`, 0600, **before** the
frame's fate is decided, and the ledger row names the file:

```
"bodyFile":"inbound/20260911T055803627Z-1f0c…​.txt","bodyBytes":1840,
"bodySha256":"…"
```

That holds for `peer_reply`, `peer_ack` and `peer_frame_uncorrelated` alike, so a frame nobody was
waiting for still leaves its text behind. The body is not in the ledger and must not be — the
published event contract has no field for one (`docs/correlated-reply-hook.md`) — and a file name
with a digest is not a body.

A body over 1 MiB is cut back to a UTF-8 character boundary and the row says `bodyTruncated: true`.
Nothing prunes this directory: it is evidence, and deleting evidence is an operator's decision.
Rotate it by hand or from outside this package.

### The text is in the answer as well, not only in the file

A file name is only reachable by a reader that opens files, and the reader on the other end of these
tools is a session that reads the answer. The daemon cannot push — it has no channel to wake anybody
— so the answer is the channel: `peer_wait`, `peer_list_events` and a `peer_send` replay carry the
row already, and the text is carried beside the name (`src/core/inbound-hydrate.mjs`).

```
"bodyFile":"inbound/20260911T100745159Z-90bd…​.txt","bodyBytes":4047,"bodySha256":"…",
"body":"PEER_REPLY re=a3000000… verdict=pass\n\n**본문…**","bodyInlineBytes":4047
```

| field | meaning |
| --- | --- |
| `body` | the text, read back out of the spooled file for this one answer |
| `bodyInlineBytes` | how many bytes of that file this answer carries, before redaction |
| `bodyInlineTruncated` | `true` when the text was cut; `bodyFile` still names the whole of it |
| `bodyInlineOmitted` | `"response_budget"` or `"unreadable"`, when a row with a file carries no text |

Two bounds, both stated: a single body is inlined up to **8 KiB**, and one response carries at most
**64 KiB** of body text across all of its rows, spent newest row first. A body that is cut says so;
a row that was left without text says why. Neither ever replaces `bodyFile` or `bodySha256`, which
remain the record of the whole body, so a truncated or omitted row is still one `cat` away from all
of it.

There is a third number and it is a guard, not a policy. `controlCall` refuses a control response
over 1 MiB (`src/core/control.mjs`), and `peer_list_events` with no cursor answers with the whole
ledger — 941,796 bytes measured on 2026-09-11, already within 107 KiB of that refusal. So bodies are
inlined only out of what is left under 896 KiB once the rows themselves are counted: a listing that
is already large inlines less, or nothing, and says so per row rather than failing as a whole. Read
with a cursor (`afterSeq`) or a `messageId` and the budget is there.

The inline copy is **not byte-exact and is not meant to be**. It goes through the same public
redaction every published string goes through (`src/mcp/redact.mjs`), so an absolute path inside a
message becomes `[path]` and the home directory becomes `[home]`. Measured over the eleven bodies
this daemon had spooled by 2026-09-11 19:23 KST: 215 lines, 22 of them rewritten — 7 where a real
path was collapsed, 15 where a `/` used as a separator in prose was read as the start of one, and 0
credential or socket matches. `bodySha256` is the digest of the bytes in the file, so comparing it
against a digest of `body` is expected to differ; the file is what holds the bytes.

The ledger and the spool are unchanged by any of this. The rows carrying text are copies made for
one response, the spooled files are opened read-only with `O_NOFOLLOW`, and a recorded `bodyFile`
is read as a name — `inbound/<name>.txt`, no separator, no leading dot — rather than trusted as a
path.

`onCorrelatedReply` is still not installed by the shipped daemon and this does not change that. The
hook sees the correlated half of the traffic only, and the half that was being lost is the other
one.
