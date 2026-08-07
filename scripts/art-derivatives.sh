#!/bin/sh
# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
#
# Local art-derivatives backfill AND ongoing sweep.
#
# Every analysed track that carries embedded cover art already has two
# objects: the extracted original `derived/<file_id>/artwork.jpg` in the
# PRIVATE audio bucket, and a 64 px `derived/<file_id>/thumb.jpg` in the
# PUBLIC art bucket. This script adds the two sizes the UI actually wants
# and neither the container nor any migration provides yet:
#
#   derived/<file_id>/medium.jpg    long edge <= 512, aspect preserved
#   derived/<file_id>/thumb-2x.jpg  128 px square cover-crop
#
# Both land in the PUBLIC art bucket beside thumb.jpg. The keys are pure
# convention — deterministic siblings of a key the app already derives
# client-side — so nothing in the database changes and no migration exists.
#
# WHY THIS RUNS ON A LAPTOP. The alternative was a 2 GB container rebuild
# plus a re-analysis of every stored file at ~45 vCPU-s each, which would
# also overwrite the `audio_analysis` rows. This reads the already-extracted
# artwork instead. It never downloads audio, never re-analyses, never writes
# to the database, and never overwrites `artwork.jpg` or `thumb.jpg`.
#
# IDEMPOTENT AND RESUMABLE. The skip test is a HEAD against the public art
# domain, so a re-run costs one cheap request per track and rebuilds only
# what is missing. That is what makes this the sweep for the new-upload gap:
# files analysed after the last run have no derivatives until the container
# learns to write them, and re-running this fills them in.
#
#   scripts/art-derivatives.sh                 # backfill / sweep everything
#   scripts/art-derivatives.sh --limit 5       # first 5 only, for a smoke test
#   scripts/art-derivatives.sh --dry-run       # report what it would do
#   scripts/art-derivatives.sh --force         # rebuild even if present
#
# Reads R2 credentials from .dev.vars, the database password from
# .secrets.env and the art domain from .env. Prints none of them.
set -eu

SIZE_MED=512   # hero long edge; the track page box is 256 CSS px, so 2x DPR
SIZE_2X=128    # 2x of the existing 64 px thumb
Q_MED=5        # ffmpeg -q:v, ~libjpeg 85
Q_2X=7         # EXACTLY worker/app/tags.py make_thumb, so the container can
               # start emitting this key later and produce identical bytes
SRC_BUCKET="${SRC_BUCKET:-localchune-audio}"
DST_BUCKET="${DST_BUCKET:-localchune-art}"
JOBS="${JOBS:-8}"

# ---------------------------------------------------------------- worker
# One track. Invoked by xargs, one process per file id, so a failure here
# kills one track and not the run.
if [ "${1:-}" = "--worker" ]; then
  id="$2"
  src="$WORK/$id.artwork.jpg"
  med="$WORK/$id.medium.jpg"
  t2x="$WORK/$id.thumb-2x.jpg"

  # The skip test HEADs the public domain, and MUST carry a per-run cache
  # buster. Without one it poisons its own answer: the miss is a 404, the
  # edge caches that 404 under the exact URL a real visitor will ask for,
  # and every browser then gets a cached 404 for an object that now exists.
  # Measured on the first run of this script — three uploaded pairs read
  # back 404 from the CDN and 200 from R2. `?probe=` keeps the negative
  # answer on a URL nothing else requests.
  present=0
  if [ "$FORCE" = 0 ]; then
    a=$(curl -s -o /dev/null -w '%{http_code}' -I "$ART_BASE/derived/$id/medium.jpg?probe=$RUN")
    b=$(curl -s -o /dev/null -w '%{http_code}' -I "$ART_BASE/derived/$id/thumb-2x.jpg?probe=$RUN")
    # `if`, not `[ ] && [ ] && x`: under `set -e` the latter's safety depends
    # on the shell's AND-list exemption, which is real but is not something
    # the next editor should have to know.
    if [ "$a" = 200 ] && [ "$b" = 200 ]; then present=1; fi
  fi
  if [ "$present" = 1 ]; then echo "skip $id" >> "$WORK/.log"; exit 0; fi

  # Download the original once; a cached copy survives a re-run.
  if [ ! -s "$src" ]; then
    aws s3api get-object --endpoint-url "$R2_ENDPOINT" --bucket "$SRC_BUCKET" \
      --key "derived/$id/artwork.jpg" "$src" >/dev/null 2>&1 || {
      echo "noart $id" >> "$WORK/.log"; rm -f "$src"; exit 0; }
  fi
  [ -s "$src" ] || { echo "noart $id" >> "$WORK/.log"; exit 0; }

  if [ "$DRY" = 1 ]; then echo "would $id" >> "$WORK/.log"; exit 0; fi

  # medium — never upscale: the target box is capped at the source's own
  # dimensions, so a 480x360 cover stays 480x360 rather than being blown up
  # to 512 and re-compressed into a bigger, softer file.
  ffmpeg -v error -y -i "$src" \
    -vf "scale=w='min($SIZE_MED,iw)':h='min($SIZE_MED,ih)':force_original_aspect_ratio=decrease:flags=lanczos" \
    -frames:v 1 -q:v "$Q_MED" "$med" 2>/dev/null || {
    echo "fail-med $id" >> "$WORK/.log"; exit 0; }

  # Re-encoding an already-small, already-compressed JPEG can produce a
  # LARGER file than the source (measured: 9560 B -> 10023 B). When that
  # happens the derivative is worse on both axes, so ship the original
  # bytes instead. Verbatim, so there is no second generation of loss.
  if [ "$(stat -f%z "$src")" -le "$(stat -f%z "$med")" ]; then cp "$src" "$med"; fi

  # thumb-2x — cover-crop, identical to make_thumb at twice the size.
  ffmpeg -v error -y -i "$src" \
    -vf "scale=$SIZE_2X:$SIZE_2X:force_original_aspect_ratio=increase,crop=$SIZE_2X:$SIZE_2X" \
    -frames:v 1 -q:v "$Q_2X" "$t2x" 2>/dev/null || {
    echo "fail-2x $id" >> "$WORK/.log"; exit 0; }

  for pair in "medium.jpg:$med" "thumb-2x.jpg:$t2x"; do
    name=${pair%%:*}; path=${pair#*:}
    npx --no-install wrangler r2 object put "$DST_BUCKET/derived/$id/$name" \
      --file "$path" --remote --content-type image/jpeg \
      --cache-control 'public, max-age=31536000, immutable' >/dev/null 2>&1 || {
      echo "fail-put $id $name" >> "$WORK/.log"; exit 0; }
  done

  echo "done $id $(stat -f%z "$src") $(stat -f%z "$med") $(stat -f%z "$t2x")" >> "$WORK/.log"
  exit 0
fi

# ------------------------------------------------------------------ main
LIMIT=0; DRY=0; FORCE=0; IDS_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --limit)    LIMIT="$2"; shift 2 ;;
    --ids-file) IDS_FILE="$2"; shift 2 ;;
    --dry-run)  DRY=1; shift ;;
    --force)    FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -f "$root/.dev.vars" ] || { echo '.dev.vars missing (R2 credentials)' >&2; exit 1; }
[ -f "$root/.env" ]      || { echo '.env missing (PUBLIC_ART_BASE_URL)' >&2; exit 1; }

AWS_ACCESS_KEY_ID=$(grep '^R2_ACCESS_KEY_ID=' "$root/.dev.vars" | cut -d= -f2-)
AWS_SECRET_ACCESS_KEY=$(grep '^R2_SECRET_ACCESS_KEY=' "$root/.dev.vars" | cut -d= -f2-)
account=$(grep '^R2_ACCOUNT_ID=' "$root/.dev.vars" | cut -d= -f2-)
ART_BASE=$(grep '^PUBLIC_ART_BASE_URL=' "$root/.env" | cut -d= -f2- | sed 's|/*$||')
R2_ENDPOINT="https://$account.r2.cloudflarestorage.com"
AWS_DEFAULT_REGION=auto
AWS_EC2_METADATA_DISABLED=true
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION AWS_EC2_METADATA_DISABLED
RUN=$$-$(date +%s)   # cache buster for the skip test; see the worker above
export R2_ENDPOINT ART_BASE SRC_BUCKET DST_BUCKET DRY FORCE RUN

WORK="${WORK:-${TMPDIR:-/tmp}}/localchune-art-derivatives"
mkdir -p "$WORK"; : > "$WORK/.log"
export WORK

# The inventory. Every analysis row that claims artwork; the worker skips
# any whose object has since gone missing. Read-only, one statement.
if [ -n "$IDS_FILE" ]; then
  cp "$IDS_FILE" "$WORK/.ids"
else
  [ -f "$root/.secrets.env" ] || { echo '.secrets.env missing (db password)' >&2; exit 1; }
  PGPASSWORD=$(grep '^SUPABASE_DB_PASSWORD=' "$root/.secrets.env" | cut -d= -f2-)
  export PGPASSWORD
  psql "postgresql://postgres.espiyvmjpmjobovmtslx@aws-1-ap-south-1.pooler.supabase.com:5432/postgres" \
    -At -c 'select file_id from public.audio_analysis where artwork_key is not null order by file_id;' \
    > "$WORK/.ids"
  unset PGPASSWORD
fi
if [ "$LIMIT" -gt 0 ]; then
  head -n "$LIMIT" "$WORK/.ids" > "$WORK/.ids.n"; mv "$WORK/.ids.n" "$WORK/.ids"
fi

total=$(wc -l < "$WORK/.ids" | tr -d ' ')
echo "tracks with artwork: $total   jobs: $JOBS   dest: $DST_BUCKET"
if [ "$DRY" = 1 ]; then echo '(dry run — generates nothing, uploads nothing)'; fi

xargs -P "$JOBS" -n 1 -I{} "$0" --worker {} < "$WORK/.ids" || true

awk '
  $1=="done"  { d++; srcb += $3; medb += $4; t2b += $5 }
  $1=="skip"  { s++ }
  $1=="noart" { n++ }
  $1=="would" { w++ }
  /^fail/     { f++; print "  FAILED: " $0 > "/dev/stderr" }
  END {
    printf "built %d   skipped %d   no-object %d   would-build %d   failed %d\n", d, s, n, w, f
    if (d > 0) printf "bytes  originals read %.1f MB   medium %.1f MB   thumb-2x %.1f MB   derivatives %.1f MB\n",
      srcb/1048576, medb/1048576, t2b/1048576, (medb+t2b)/1048576
  }' "$WORK/.log"
