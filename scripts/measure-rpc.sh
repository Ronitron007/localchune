#!/bin/sh
# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
#
# One Supabase round trip, N times, warm. Perf task 2.1's unit of cost: the
# chain the task removes was N of these end to end, so the saving is
# (stages removed) x (this number).
#
# It POSTs an RPC the anon role may not execute. That is deliberate — the
# request still travels the whole path (TLS, PostgREST, function lookup,
# permission check) and comes back 404/401, so it measures the round trip
# without needing a session this script has no way to obtain. Reads
# PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY from .env and prints
# neither.
set -eu
n="${1:-10}"
url=$(grep '^PUBLIC_SUPABASE_URL=' .env | cut -d= -f2-)
key=$(grep '^PUBLIC_SUPABASE_ANON_KEY=' .env | cut -d= -f2-)
[ -n "$url" ] || { echo 'PUBLIC_SUPABASE_URL missing from .env' >&2; exit 1; }

i=0
while [ "$i" -lt "$n" ]; do
  curl -s -o /dev/null -w '%{time_starttransfer}\n' \
    -X POST "$url/rest/v1/rpc/current_member" \
    -H "apikey: $key" -H 'content-type: application/json' -d '{}'
  i=$((i + 1))
done | awk '
  { t[NR] = $1 * 1000; s += $1 * 1000 }
  END {
    n = NR
    for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++)
      if (t[j] < t[i]) { x = t[i]; t[i] = t[j]; t[j] = x }
    printf "samples=%d  min=%.0fms  median=%.0fms  mean=%.0fms  max=%.0fms\n",
      n, t[1], t[int((n + 1) / 2)], s / n, t[n]
  }'
