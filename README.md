# localchune

A private, invite-only track pool for a small DJ circle.

Everyone uploads the tracks they've bought; everyone can search, audition and
download the whole pool. Before anything is added it's fingerprinted against
what's already there, so the pool stays one-copy-per-recording instead of
decaying into eleven versions of the same file with different ID3 tags.

Not a store, not a social network, not public.

## Status

Design complete, implementation not started.

- **[docs/PRD.md](docs/PRD.md)** — the spec
- **[docs/superpowers/plans/](docs/superpowers/plans/)** — task-by-task implementation plans

## Shape

| | |
|---|---|
| App | Astro 7 (SSR) + Solid islands on Cloudflare Workers |
| Auth | Supabase + Google OAuth, gated by an owner-maintained allowlist |
| Data | Supabase Postgres, RLS-enforced |
| Objects | Cloudflare R2 |
| Analysis | Python container on Google Cloud Run, driven by Cloudflare Queues |
| Catalogue | AcoustID → MusicBrainz → Apple Music API → Cover Art Archive |
| Genre | Discogs styles, from the CC0 monthly dumps |

Running cost at ~2,000 tracks: **≈$10-15/month**, of which $5 is Cloudflare Workers
Paid. See PRD §10.

## Maintenance you run by hand

`scripts/art-derivatives.sh` builds the two art sizes the analysis container
does not write yet — `derived/<file_id>/thumb-2x.jpg` (128 px, retina rows)
and `derived/<file_id>/medium.jpg` (≤512 px, the track hero) — from the
cover art R2 already holds. It downloads no audio and re-analyses nothing.

**Run it after a batch of uploads.** A file analysed since the last run has
only the 64 px thumb, and the pages fall back to it until the sweep fills the
gap. Re-running is cheap and safe: the skip test is one HEAD per track, so a
sweep over an already-complete library builds nothing.

```
scripts/art-derivatives.sh --dry-run   # what it would build
scripts/art-derivatives.sh             # build the missing ones
```

## Core model

- **track** — a canonical, format-agnostic recording identity. One `track_id`
  is one specific recording: Radio Edit, Extended Mix and any Remix are
  *separate* tracks. Only re-encodes and re-rips of the same master collapse.
- **file** — one audio file under a track. A track can have several formats.
- **crate** — a member's curated collection, referencing `track_id`, so it's
  format-agnostic and survives merges.

## Licence

This project's own source is MIT. **The distributed combination is AGPL-3.0**,
because the analysis worker includes Essentia. See [LICENSE](LICENSE).
