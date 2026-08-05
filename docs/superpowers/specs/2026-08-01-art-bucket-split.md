# Art bucket split — public thumbs, private audio

*Date: 2026-08-01. Status: approved by owner ("lets build this"), built same day.*

## Why

Every pool page fired ~100 art requests, and each one cost a Worker
invocation plus a `pool_get` round trip to Supabase before a signed
redirect the browser could not cache (the signature rotates). Measured:
`pool_list(100)` itself is 50–75 ms — the art fan-out was the entire
slowdown as the library grew.

Thumbnails are 64 px JPEGs of commercially published artwork. They do not
need session-gated, signed delivery. Audio does, and keeps it.

## The split

| Asset | Bucket | Access | URL |
|---|---|---|---|
| Audio (all formats, previews, peaks) | `localchune-audio` | private, presigned GET only | via `/api/track/[id]/source` etc. — unchanged |
| Full-size artwork | `localchune-audio` | private, presigned via `/api/track/[id]/art?full=1` | unchanged |
| **64 px thumbs** | **`localchune-art`** | **public bucket, custom domain** | `https://art.butternutcrack.com/derived/<file_id>/thumb.jpg` |

- Public means world-readable, not listable. Keys hang off unguessable
  file-id UUIDs. The audio bucket's privacy posture is untouched.
- The custom domain (not `r2.dev` — rate-limited, not for production) gives
  full CDN caching. Thumbs are immutable: browser cache + edge cache both
  hold them forever. A repeat pool visit downloads zero art bytes and makes
  zero art requests.
- Dev uses `localchune-art-dev` with the managed `r2.dev` URL — rate limits
  are irrelevant at dev traffic.

## Upload → analysis → serving pipeline (the part this spec pins down)

1. **Upload**: browser presigned-PUTs the audio file to `localchune-audio`.
   Nothing changes. No client ever writes art.
2. **Analysis** (the only writer of art): the container extracts embedded
   artwork; the Durable Object writes derived artifacts through bindings —
   - `thumb.jpg` → **`ART` binding → `localchune-art`** (new)
   - full `artwork.jpg`, Opus preview, peaks → `AUDIO` binding →
     `localchune-audio` (unchanged)
   `workers/analysis/wrangler.jsonc` gains the `ART` R2 binding (prod +
   dev env). TS-only change: no container image rebuild, no gradual
   rollout concerns.
3. **Serving**: row templates render
   `<img src={PUBLIC_ART_BASE_URL}/derived/${file_id}/thumb.jpg>` directly
   when `has_thumb` — derivable client-side because `thumb_key` is
   `'thumb.jpg'` for all 586 existing rows and the analysis worker names it
   deterministically. No per-thumb Worker request, no DB call, no signing.
   `PUBLIC_ART_BASE_URL` lives in `.env` (baked at build; it is public by
   definition).
4. **`/api/track/[id]/art`** keeps only the `?full=1` path (track page,
   one request, stays signed/private). The thumb branch is deleted.

## Backfill

One-off copy of every existing `derived/<file_id>/thumb.jpg` from
`localchune-audio` to `localchune-art` (586 objects), S3-to-S3 via the
account R2 credentials. Runs BEFORE the app deploy that flips templates to
the public URL — order matters, or rows 404 their thumbs.

## Rollout order

1. Create buckets, attach custom domain (DNS auto-provisioned on the zone),
   enable dev-url on the dev bucket.
2. Backfill 586 thumbs; spot-check a public URL serves 200 image/jpeg.
3. Deploy analysis worker with the `ART` binding (new uploads land in the
   art bucket).
4. Deploy app (templates → public URLs, art route trimmed).

## Out of scope / follow-ups

- Maintenance reconcile does not yet audit the art bucket. Thumbs are
  regenerable from source audio, so drift is cosmetic. Noted, not built.
- Lifecycle/CORS: none needed (no multipart, plain `<img>` fetches).
