#!/bin/sh
# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
#
# Print every emitted client chunk as "raw gzip name", largest first, then a
# total. Used by the Phase 2 perf tasks so a before/after number comes from a
# command rather than an eyeball. Run after `npm run build`.
set -eu
dir="${1:-dist/client/_astro}"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
for f in "$dir"/*.js "$dir"/*.css; do
  [ -e "$f" ] || continue
  raw=$(wc -c < "$f")
  gz=$(gzip -c "$f" | wc -c)
  printf '%10d %8d  %s\n' "$raw" "$gz" "$(basename "$f")" >> "$tmp"
done
sort -rn "$tmp"
awk '{r+=$1; g+=$2; n++} END {printf "%10d %8d  TOTAL (%d chunks)\n", r, g, n}' "$tmp"
