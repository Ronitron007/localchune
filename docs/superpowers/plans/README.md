# localchune — plan index

Spec: [`docs/PRD.md`](../../PRD.md)

The PRD covers eight subsystems. Each gets its own plan, and each produces working, testable software on its own. Plans are written **just in time** — writing task-level detail for Milestone 7 today would be guesswork, because Milestones 1–3 will teach us things.

| # | Milestone | Status | Plan | Depends on | Ships when |
|---|---|---|---|---|---|
| 1 | **Foundations** — allowlist auth, core schema, RLS, admin page | **Shipped** — deployed to [`localchune.butternutcrack.com`](https://localchune.butternutcrack.com) | [`01-foundations.md`](2026-07-27-01-foundations.md) | — | You can log in, a non-allowlisted Google account cannot |
| 2 | **Upload** — presigned PUT/multipart, duration pre-flight, batch UI, server re-verify | Planned — plan complete (Tasks 1–8), not yet implemented | [`02-upload.md`](2026-07-27-02-upload.md) | 1 | 200 files land in R2 with `files` rows and correct byte counts |
| 3 | **Analysis worker** — the container on Cloudflare Containers, Queues, all DSP | **In progress** — Tasks 1–8 done, Task 9 remaining | [`03-analysis-worker.md`](2026-07-27-03-analysis-worker.md) | 2 | Every uploaded file gets key, BPM, loudness, peaks, fingerprint, forensics |
| 4 | **Dedup** — fingerprint index, BER matching, merge/undo, review queue | Not started | *not yet written* | 3 | Duplicate uploads resolve to one `track_id`, reversibly |
| 5 | **Pool UI** — track list, filters, player, download | Planned — plan complete | [`05-pool-ui.md`](2026-07-28-05-pool-ui.md) | 3 (Task 9) | The pool is usable |
| 6 | **Crates** | Not started | *not yet written* | 5 | — |
| 7 | **Catalogue matching** — AcoustID → MB → Apple → artwork | Not started | *not yet written* | 3 | Tracks carry canonical metadata and art |
| 8 | **Genre** — Discogs dump ingest, MB join, normalisation, facet | Not started | *not yet written* | 7 | Genre facet works |

Then: **calibration pass** at ~2k tracks (PRD §6), and v2 (credits enforcement, crate sharing).

## Blocking unknowns to resolve before the milestone that needs them

These are carried explicitly rather than assumed away. Each is a first-class task in its plan, not a footnote.

| Unknown | Blocks | Resolution |
|---|---|---|
| **Apple `genreNames` shape** — does it return the same leaf plus ancestors, or finer resolution? Inferred during research, never verified with an authenticated call. | 7, 8 | One live call. We hold the Developer Program membership. Task 7.1. |
| **Apple PDLA metadata-retention clause** — research found no caching prohibition *and could not read the authoritative text* (behind account auth). We persist Apple metadata in Postgres. | 7 | Read the MusicKit attachment of the Developer Program License Agreement. Task 7.2. |
| **ONNX vs PyTorch for Beat This!** — 65% of the compute budget rides on this. | 3 | Benchmark both. Task 3.2 — deliberately the *first* worker task. |
| **Dedup thresholds** — 0.90/0.70/0.40 are AcoustID's constants adjusted by judgement, not measured against this library. | 4 | Calibration pass at ~2k tracks, using known-duplicate pairs and 200 deliberate transcodes. |
| **GIN `query_items` mask width** — guessed at 12. Too small and transcodes share nothing; too large and everything matches. | 4 | Measure: require `median(|items_a ∩ items_b|) / |items_a| ≥ 0.35` across 200 files transcoded to 128 kbps. |

## Conventions

- Branch per milestone: `rohan/m<N>-<slug>`.
- Every plan is TDD: failing test → run it → minimal implementation → run it → commit.
- Migrations are numbered `supabase/migrations/<timestamp>_<name>.sql` and are never edited after being applied to the hosted project — write a new one.
- Auth hook registration lives in `supabase/config.toml`, not only the dashboard. A dashboard-only hook is a front door that a project restore silently opens.
