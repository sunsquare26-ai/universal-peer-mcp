# Upgrade while preserving the existing conversation

For `0.1.1+20260911-peer-repair-r2`, install immutable program files at a new versioned prefix
and keep the existing state directory. Do not overwrite files imported by a running server.
A new state directory is an isolated diagnostic lane, not a required upgrade step: it creates a
separate ledger and reply address and does not carry existing pending requests with it.

## Verify the artifact

Use the same release tarball for both client prefixes. Compare its published SHA-256 before
unpacking. The package contains `RELEASE-MANIFEST.sha256` and `tools/verify-release.mjs`:

```sh
bun tools/verify-release.mjs PACKAGE_ROOT --manifest-sha256 PINNED_MANIFEST_SHA256
```

Use the manifest SHA from the release result, not a hash calculated from an unverified local
manifest. Verification rejects modified, missing, additional or symbolic-link files. The install
prefix itself must be new; the state directory must remain an owned real `0700` directory.
The manifest describes package files, not installation-manager wrappers outside the package.
Tests and their fixtures are maintained in the review candidate and are excluded from the npm
release package by `package.json.files`.

## Preserve state and pending messages

1. Record the current state root, daemon PID and normalized start identity, current target table
   digest, ledger cursor, and pending message IDs. Copy neither tokens nor message bodies into
   the report. Do not replay a send whose outcome is uncertain.
2. Keep the existing working reply lane alive while the replacement is prepared. Point the MCP
   client at the verified new program prefix with the same state root. A new `serve` process
   alone does not replace a live daemon; it may connect to the old one.
3. Quiesce new sends for that lane. Use `daemon_shutdown` only if that existing daemon exposes
   the admin tool. Otherwise use the already authorized process controller to recheck the
   recorded PID/start identity and send SIGTERM to that process alone. Do not enable admin as a
   shortcut, use a global kill command, or delete a live registry row.
4. The receiver drains accepted frames; shutdown has a bounded deadline and exits nonzero if
   cleanup cannot finish. A failed cleanup is unresolved work, not a clean shutdown. Preserve
   its artifacts and diagnose them before starting another daemon.
5. Restart the MCP server from the verified prefix. The new daemon opens the same ledger.
   Since a pre-0.1.1 reply address contains the old PID, the first transition requires explicitly
   notifying the Claude peer of the new reply address. Subsequent restarts use a stable address
   derived from the same state root. Authentication keys and process identity are still fresh.
6. Read `daemon_status`: compare `serverBuild` and `daemonBuild` build IDs and startup digests.
   `buildMismatch: null` means an older process supplies no comparable observation.
   `sourceChangedSinceStart: true` means disk changed after that process observed startup.
   These digests describe disk observations, not proof of every loaded module byte. Both
   `startedAt` values must match the intended replacement processes.
7. Read `peer_status` for every configured alias, then perform a new correlated hello/ACK and
   reply-body canary. Verify old pending requests by their existing message IDs with `peer_wait`
   and paged event reads; never resend them just because a previous wait timed out.

## Explicit target renewal

Targets remain pinned to a session UUID, cwd and verified process identity. A Claude session
that changes UUID does not silently inherit an alias. Verify the intended live session and its
cwd first; record the old and new UUIDs, explicitly update that one target entry, and restart
that lane as above. `target_table_stale` means the server and daemon saw different tables and
no send was dispatched. A same-name session is not sufficient proof of the intended recipient.

`control.sock` is the local MCP-to-daemon RPC address. Each request connects and closes on its
own; an idle listener is normal. Native peer replies use the separate address included in the
message envelope. The two parties do not need the same state root to exchange native replies.

## Rollback

Keep the old immutable program prefix and the state/ledger. Quiesce, stop only the verified
replacement process, and restore the prior program prefix. Do not restore an older ledger over
new events, delete pending messages, or automatically replay sends. A version without the new
body storage or reply parser may no longer expose all new event fields; assess that compatibility
before rollback. Keep the previously working reply lane until the replacement canary succeeds.

The adapter remains Claude-native only. Launch-path and explicit permission-mode proof are
unchanged; an upgrade does not make arbitrary Codex sessions valid targets.
