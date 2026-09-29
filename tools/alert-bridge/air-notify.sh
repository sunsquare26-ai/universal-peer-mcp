#!/bin/bash
# UNIVERSAL_PEER_ALERT_COMMAND bridge (src/core/alerts.mjs runs it as:
#   air-notify.sh universal-peer <kind> <key> <code|->   — no shell, closed-list words only).
#
# (a) appends one line to ~/vision-private/alerts/universal-peer.log (dir 0700, file 0600);
# (b) shows a macOS notification on the Air over SSH (Tailscale network), with the kind and the
#     id part of the key only — never a body.
# The log line is written before the SSH attempt, so a sleeping or unreachable Air loses nothing
# here; the outcome of (b) is a second line. Exit 0 = both done, 2 = logged but not notified.
#
#   air-notify.sh --test     sends 「UniversalPeer 경보 시험」 the same way.
#
# Settings (environment): UNIVERSAL_PEER_AIR_SSH (default hyungseoklee@macbookair.tail72dd63.ts.net),
# UNIVERSAL_PEER_ALERT_LOG_DIR (default ~/vision-private/alerts), UNIVERSAL_PEER_SSH_BIN (tests).
set -uo pipefail
umask 077
air="${UNIVERSAL_PEER_AIR_SSH:-hyungseoklee@macbookair.tail72dd63.ts.net}"
logdir="${UNIVERSAL_PEER_ALERT_LOG_DIR:-$HOME/vision-private/alerts}"
ssh_bin="${UNIVERSAL_PEER_SSH_BIN:-/usr/bin/ssh}"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "${1:-}" = "--test" ]; then
  kind="test"; key="test"; code="-"; text="UniversalPeer 경보 시험"
else
  [ "${1:-}" = "universal-peer" ] && [ $# -eq 4 ] || { echo "usage: air-notify.sh universal-peer <kind> <key> <code>|--test" >&2; exit 64; }
  kind="$2"; key="$3"; code="$4"
  [[ "$kind" =~ ^[a-z_]{1,40}$ ]] || { echo "bad kind" >&2; exit 64; }
  [[ "$key" =~ ^[a-z0-9_:.-]{1,160}$ ]] || { echo "bad key" >&2; exit 64; }
  [[ "$code" =~ ^[A-Za-z0-9_.:-]{1,64}$ ]] || { echo "bad code" >&2; exit 64; }
  id="${key##*:}"
  text="UniversalPeer 경보: ${kind} ${id}"
fi
[[ "$air" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || { echo "bad UNIVERSAL_PEER_AIR_SSH" >&2; exit 64; }

mkdir -p "$logdir" && chmod 700 "$logdir" || exit 1
log="$logdir/universal-peer.log"
printf '%s alert kind=%s key=%s code=%s\n' "$now" "$kind" "$key" "$code" >> "$log" || exit 1
chmod 600 "$log"

# Every character of $text is validated above or fixed here, so it cannot close the quotes.
remote="osascript -e 'display notification \"${text}\" with title \"UniversalPeer\"'"
if "$ssh_bin" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes "$air" "$remote" >/dev/null 2>&1; then
  printf '%s notify key=%s air=ok\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" >> "$log"; exit 0
else
  rc=$?
  printf '%s notify key=%s air=failed rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" "$rc" >> "$log"; exit 2
fi
