#!/bin/bash
# Keep a private copy of the daemon's inbound body spool before retention is switched on.
# Idempotent: new files are added, existing copies are never replaced, and every file in the copy
# is re-hashed into MANIFEST.sha256 (two-column `shasum -a 256` format, so `shasum -c` works).
# Usage: snapshot-inbound.sh <state-dir>/inbound <destination-dir>
set -euo pipefail
src="${1:?source inbound dir}"; dest="${2:?destination dir}"
[ -d "$src" ] || { echo "no source: $src" >&2; exit 2; }
umask 077
mkdir -p "$dest/inbound"; chmod 700 "$dest" "$dest/inbound"
/usr/bin/rsync -a --ignore-existing "$src/" "$dest/inbound/"
find "$dest/inbound" -type f -exec chmod 600 {} +
# Every source file must be in the copy with the same bytes.
missing=0; differ=0
while IFS= read -r -d '' f; do
  name="${f#"$src"/}"
  if [ ! -f "$dest/inbound/$name" ]; then missing=$((missing+1));
  elif ! cmp -s "$f" "$dest/inbound/$name"; then differ=$((differ+1)); fi
done < <(find "$src" -type f -print0)
(cd "$dest" && find inbound -type f | LC_ALL=C sort | xargs shasum -a 256) > "$dest/MANIFEST.sha256"
chmod 600 "$dest/MANIFEST.sha256"
files=$(wc -l < "$dest/MANIFEST.sha256" | tr -d ' ')
bytes=$(find "$dest/inbound" -type f -exec stat -f %z {} + | awk '{s+=$1} END {print s+0}')
manifest_sha=$(shasum -a 256 "$dest/MANIFEST.sha256" | cut -d' ' -f1)
printf '{"schema":"universal-peer.inbound-snapshot/1","at":"%s","files":%s,"bytes":%s,"manifestSha256":"%s","sourceMissingInCopy":%s,"sourceDifferentInCopy":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$files" "$bytes" "$manifest_sha" "$missing" "$differ" > "$dest/snapshot.json"
chmod 600 "$dest/snapshot.json"
cat "$dest/snapshot.json"
[ "$missing" -eq 0 ] && [ "$differ" -eq 0 ]
