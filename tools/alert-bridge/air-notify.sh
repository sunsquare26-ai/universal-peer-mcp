#!/bin/bash
# UNIVERSAL_PEER_ALERT_COMMAND bridge (src/core/alerts.mjs runs it as:
#   air-notify.sh universal-peer <kind> <key> <code|->   — no shell, closed-list words only).
#
# (a) appends one line to <log dir>/universal-peer.log (dir 0700, file 0600);
# (b) shows a macOS notification on a second Mac over SSH, with the kind and the id part of the key
#     only — never a body. Without a configured host only (a) happens.
# The log line is written before the SSH attempt, so a sleeping or unreachable Air loses nothing
# here; the outcome of (b) is a second line. Exit 0 = both done, 2 = logged but not notified.
#
#   air-notify.sh --test     sends 「UniversalPeer 경보 시험」 the same way.
#
# Settings: the environment first (UNIVERSAL_PEER_AIR_SSH=user@host, UNIVERSAL_PEER_ALERT_LOG_DIR,
# UNIVERSAL_PEER_SSH_BIN for tests), then ~/.config/universal-peer/alert-bridge.conf — KEY=VALUE
# lines for the same two keys, a file this user owns and nobody else can write; it is read, never
# sourced. No host anywhere: the alert is logged and not sent. Log dir default:
# ~/Library/Logs/universal-peer.
set -uo pipefail
umask 077
conf="$HOME/.config/universal-peer/alert-bridge.conf"
conf_value() {
  [ -f "$conf" ] && [ ! -L "$conf" ] && [ "$(stat -f %u "$conf")" = "$(id -u)" ] && [ $(( 0$(stat -f %Lp "$conf") & 022 )) -eq 0 ] || return 0
  sed -n "s/^$1=//p" "$conf" | head -1
}
air="${UNIVERSAL_PEER_AIR_SSH:-$(conf_value UNIVERSAL_PEER_AIR_SSH)}"
logdir="${UNIVERSAL_PEER_ALERT_LOG_DIR:-$(conf_value UNIVERSAL_PEER_ALERT_LOG_DIR)}"
logdir="${logdir:-$HOME/Library/Logs/universal-peer}"
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
  # A message waits in a GitHub room for a remote session nobody can wake: the owner passes it on.
  [ "$kind" = "github_relay_needed" ] && text="UniversalPeer: ${code} 에게 GitHub 방 메시지 전달 필요"
fi
[ -z "$air" ] || [[ "$air" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || { echo "bad UNIVERSAL_PEER_AIR_SSH" >&2; exit 64; }

mkdir -p "$logdir" && chmod 700 "$logdir" || exit 1
log="$logdir/universal-peer.log"
printf '%s alert kind=%s key=%s code=%s\n' "$now" "$kind" "$key" "$code" >> "$log" || exit 1
chmod 600 "$log"

if [ -z "$air" ]; then printf '%s notify key=%s air=not_configured\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" >> "$log"; exit 2; fi

# Every character of $text is validated above or fixed here, so it cannot close the quotes.
# Method 3 (default): ask System Events, which runs in the Air's GUI session, to post it.
# Method 1 (fallback): osascript's own notification from the SSH session.
# Measured 2026-09-29: both arrive in the Air's Notification Center (under 스크립트 편집기, 16:23
# and 16:26 KST); while a Focus mode (업무) is on, the banner itself is not shown.
remote_events="osascript -e 'tell application \"System Events\" to display notification \"${text}\" with title \"UniversalPeer\"'"
remote_plain="osascript -e 'display notification \"${text}\" with title \"UniversalPeer\"'"
ssh_air() { "$ssh_bin" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes "$air" "$1" >/dev/null 2>&1; }
ssh_air "$remote_events"; rc=$?
if [ "$rc" -eq 0 ]; then
  printf '%s notify key=%s air=ok method=system_events\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" >> "$log"; exit 0
fi
# 255 is ssh's own failure (Air asleep, unreachable): the fallback would fail the same way.
if [ "$rc" -ne 255 ]; then
  ssh_air "$remote_plain"; rc2=$?
  if [ "$rc2" -eq 0 ]; then
    printf '%s notify key=%s air=ok method=osascript_fallback rc_events=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" "$rc" >> "$log"; exit 0
  fi
  rc="$rc2"
fi
printf '%s notify key=%s air=failed rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" "$rc" >> "$log"; exit 2
