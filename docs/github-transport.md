# GitHub transport (M6) — sessions in different places talk through one pull request

Local sessions on one Mac talk through the daemon's sockets. A Claude Code cloud session (Anthropic
container) and a Codex cloud task (OpenAI container) cannot reach that Mac, and cannot reach each
other. The one place all of them can read and write is the repository they work on. The GitHub
transport makes one issue or pull request of that repository a **room**: a message is a comment,
and the same rules as the local messenger apply — an id per message, answers that name what they
answer, a processed mark, and a notice to the sender when a message is stuck.

## The message line

A message is a comment whose first line is:

```text
UPM v=1 id=<uuid> from=<alias> to=<alias>[,<alias>...] [re=<uuid>] [expect=reply]
```

The body follows on the next lines. Anything that can post a comment can send one — the GitHub
tools of a cloud session, `gh`, or the local bridge — and no package has to be installed in a cloud
container. Fields:

| field | meaning |
|---|---|
| `id` | a new UUID for this message (`uuidgen`, `python3 -c 'import uuid;print(uuid.uuid4())'`) |
| `from` | the sender's alias in this room |
| `to` | one or more recipient aliases |
| `re` | the id of the message this answers (an answer always carries it) |
| `expect=reply` | the sender wants an answer; a notice follows if none comes |

A processed mark is a comment whose first line is `UPM v=1 ack=<uuid> from=<alias>`. Nothing else
in the comment is read.

## Waking the recipient

| recipient | how it is woken | verified |
|---|---|---|
| A local session on the Mac | the bridge mirrors the comment into the local ledger; the ordinary doorbell rings | yes (tests) |
| Codex cloud | `--wake relay` (recommended): no wake line; the owner gets a notification "codex-cloud 에게 GitHub 방 메시지 전달 필요" and tells the Codex cloud session to handle the room. `--wake @codex`: a wake line with one sentence saying it is a message to answer with `re=` (a bare `@codex` is taken as a review request). | relay: yes (2026-10-08, round trip with `re=` and ack). `@codex`: not working on the measured account even with a published environment — the bot only answered "create an environment", and those replies woke every subscriber of the room |
| Claude Code cloud session | the session subscribes to the pull request's activity and is woken by new comments | yes (2026-10-08: answer with `re=` and ack arrived; the Mac's ack was posted back) |

Until a wake is measured for an account, the owner relays: tells the cloud session "a message for you is
in <room URL>", and the session reads and answers it there. Give the room by URL: told only "pull request
#1", a session looked in another repository's #1.

The instructions tell a cloud session to keep doing its own work and to act only on comments addressed
to it (measured: a session subscribed to the room otherwise stopped its work and commented on every
comment it saw).

A cloud session needs network access to `api.github.com` to read and write comments (Codex cloud: add it
to the environment's allowed domains, with POST).

**No answer is guessed.** A comment without a message line — a Codex review, a progress note, a
bot's summary — is recorded as observed (author and id, never the body) and changes nothing: it is not
an answer, not an ack and not a processed mark. Only `re=` links an answer to a question.

## The bridge (on the Mac, inside the daemon)

The owner links a room once (from a terminal; a public repository is refused):

```sh
universal-peer-mcp github link --room egg --repo owner/repo --number 12
universal-peer-mcp github remote --room egg --alias codex-cloud --wake relay
universal-peer-mcp github remote --room egg --alias claude-cloud
universal-peer-mcp github instructions --room egg --as codex-cloud --local dev-claude   # the lines to give that session
```

The daemon polls each room every 30 seconds through the owner's `gh` (one poll per room at a time; a
room whose repository is not private is not read or written, checked before every poll and every
comment). Every comment is decided once by its GitHub id — its own record, never a guess from the
ids around it. The list GitHub returns is not a snapshot (a deletion between two page requests moves
later comments to earlier pages), so besides reading the new tail every poll also re-walks a couple of
pages of the whole room, round and round, and decides any comment it has no record of:

- **inbound message to a local alias**: a `peer_post` in that alias's inbox (sender kind `github`),
  rung by the doorbell. With `re=`, it must answer a message this Mac sent to that remote in that room;
  the answer is bound to the session that asked (even if the alias has moved since). Any other `re=` is
  quarantined.
- **ack**: closes only a message this Mac sent to the remote that acks it, in that room.
- **outbound** (`post --to <remote>` or `--reply-to` a GitHub message): a durable intent, then one
  comment. A comment that may have been written (timeout, lost answer) is `unknown` and is never posted
  again by itself; the next poll reconciles it if the comment is in the room. A posted comment is not a
  read: the remote's ack is.
- **local `inbox-ack`** of a GitHub message posts one ack line, so the remote side sees it was handled.
- our own comments coming back on the next poll are recognised and never become messages.

## Identity

One GitHub account writes for several sessions, so a comment's author cannot tell sessions apart and
`from=` is a claim made inside the owner's private room (weak identity). The bridge keeps what it can:
a remote may not claim an alias a local session holds; an ack closes only deliveries to the remote that
sends it; answers are only accepted for messages actually sent to that remote; a remote's `epoch`
changes when the owner re-points it. Message bodies are peer requests, never the owner's instructions.
If the repository is ever made public, its old comments become public with it — linking refuses a
public repository, but cannot take back what was already written.

## What a cloud session needs to be told

`universal-peer-mcp github instructions --room egg --as <alias>` prints the few lines to give that
session (or to put in the repository's `AGENTS.md` / `CLAUDE.md`): the message line, `re=` for answers,
the ack line, and `@codex` to wake Codex.

Not in this version: notices between two remote sessions, automatic wake of an existing Claude cloud
session, more than one room per remote.
