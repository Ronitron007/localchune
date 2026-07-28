# UI component inventory — spec, not design

What components the product needs, what data each consumes (real column/RPC
names from the shipped schema), and which milestone owns each. **No visual
design here** — this is the parts list.

Architecture constraint carried from M1/M2: Astro server-renders pages;
anything interactive is a **Solid island** (`client:load`). Every island talks
to the server through JSON API routes or RPCs via `Astro.locals.supabase` on
the server side — islands never hold a Supabase session (cookies are
httpOnly). Existing islands (`AllowlistForm`, `RevokeButton`,
`UploadDropzone`) set the idiom: `createSignal`/`createStore`, `aria-live`
status regions, fetch with `content-type: application/json`.

## 1. Shell — every page

| Component | Kind | Consumes | Notes |
|---|---|---|---|
| `AppNav` | server-rendered | `locals.member` (email, role) | Links: Pool, Upload, Crates, Admin (owner only — omit, don't disable). Sign-out form. Credits chip via `creditsRemaining()`. |
| `StorageChip` | server-rendered | `my_storage()` RPC | Occupying + contributed, human-readable. Already partially on /upload; move to shell level when Pool lands. |
| `StatusRegion` | island util | — | The shared `aria-live` toast pattern the three existing islands each reimplement. Extract once, reuse. |
| `SourceLink` | server-rendered | build SHA | Footer "Source" link pinned to deployed commit — **AGPL §13 obligation**, PRD §7.3 rule 5. Must exist before the repo goes public. |

## 2. Pool — the track table (M5, the core surface)

The main query joins `files` (state `stored`, pool-visible) × `audio_analysis`
× uploader attribution. Needs a server-side list endpoint with filter params —
**one API route, all filters server-side**; 2k rows is small enough for
generous pages but not for shipping the whole table to the client.

| Component | Kind | Consumes | Notes |
|---|---|---|---|
| `TrackTable` | island | list endpoint | Virtualised rows (2k+ tracks). Column sort. URL-synced filter state so filtered views are shareable/bookmarkable. |
| `TrackRow` | part of table | per-row fields below | artist/title (from `raw_tags` until M7 canonicalises), `bpm`, `KeyChip`, duration (`formatDuration` — import the existing one), `QualityBadge`, uploader, added date. |
| `KeyChip` | pure | `key_camelot`, `key_open`, `key_musical` | Camelot shown; Open Key + musical in tooltip. **Camelot sort util**: `num*10 + (letter=='B')` — lexicographic sort puts 10A before 2A (cue-tracks `FileList.tsx:120` trick). |
| `QualityBadge` | pure | `quality_tier`, `lossy_ancestor`, `meas_cutoff_hz` | Tier 1–5. Tooltip must say *measured*, e.g. "FLAC container, measured 16.8 kHz — transcode suspected". `abstain` renders neutral, never accusatory. |
| `FilterBar` | island | — | Composes the filters below; emits one query object. |
| `SearchBox` | filter | artist/title/filename text | Debounced, server-side `ilike` (or FTS later). |
| `BpmRangeFilter` | filter | `bpm` | Min/max + a **±3% and half/double-time toggle** — a 174 DnB track matches an 87 query when enabled. This is the cue-parser-style filter the PRD names. |
| `KeyFilter` | filter | `key_camelot` | Two modes: exact key, and **harmonic** (selected ±1 wheel position + relative major/minor) — the reason Camelot exists. |
| `GenreFacet` | filter | `track_style` (M8) | Two-level: family chips → styles, per PRD §9.1. **Renders only when M8 data exists** — design the slot now, ship it empty. |
| `QualityFilter` | filter | `quality_tier` | Min tier / lossless-only. |
| `UploaderFilter` | filter | uploader | By member. |
| `EmptyState` | server | — | No results vs no tracks yet vs everything-filtered-out are three different messages. |

## 3. Player (M5)

Streams the Opus preview (`preview_key`) when the original is lossless,
the original file otherwise — R2 via short-lived signed GET minted by an API
route (same signer as uploads, GET method).

| Component | Kind | Consumes | Notes |
|---|---|---|---|
| `PlayerBar` | island (single instance, persistent) | current track + signed URL | Bottom bar: play/pause, elapsed/total, volume, now-playing. Survives navigation within the pool page (island state), not across pages (acceptable v1). |
| `WaveformScrubber` | part of PlayerBar | `peaks_key` JSON (1000 min/max buckets from R2) | Canvas render, click-to-seek. The 41 KB peaks JSON is fetched per played track, cacheable forever (immutable per file). |
| `PlayButton` | per TrackRow | — | Delegates to the single PlayerBar instance — never N `<audio>` elements. |

## 4. Download (M5)

| Component | Kind | Consumes | Notes |
|---|---|---|---|
| `DownloadButton` | island | `files` rows per track | **Format-aware**: a track can hold multiple files (FLAC + 320 MP3) once dedup lands — menu when >1, direct when 1. Downloads the original via signed GET with `content-disposition` filename. |

## 5. Track detail (M5, grows in M4/M7)

A per-track page or slide-over. Server-rendered (no interactivity beyond
player/download reuse).

Sections, each mapping to shipped columns: identity (tags → M7 canonical),
analysis (`bpm` + `beat_grid` count, all three key profiles from
`key_alt_profiles`, `integrated_lufs`, `lra_lu`, `true_peak_dbtp`,
`replaygain_db`), forensics (tier, ancestor verdict, `meas_cutoff_hz`,
`clipped_pct` — **labelled as suspicion proxy**, per the Field description),
provenance (uploader, batch, date, `file_claims` co-uploaders), artwork
(`artwork_key` fallback chain per PRD §8.1 precedence).

## 6. Upload page (exists — M2; needs two additions when M3 wires up)

| Component | Status | Notes |
|---|---|---|
| `UploadDropzone` + rows | shipped | — |
| `FileStateTicker` | **new** | Post-upload, rows show the ingest state machine: `received → analysing → stored`. Poll a lightweight endpoint (or refetch on focus). This is where "your track is being listened to" becomes visible. Degraded analysis (bpm 0, confidence 0) renders as "no beat detected", not an error. |
| `AnalysisFailedRow` | **new** | `failed`/`rejected_duration` states with the recorded reason and a retry affordance where legal (fresh `file_id` — the journal drop rule from M2 Task 7). |

## 7. Crates (M6)

Schema not yet built; components spec'd against the PRD's decided model
(crate references format-agnostic `track_id`, any pool track, private to
owner in v1).

`CrateSidebar` (list + create), `CrateView` (TrackTable scoped to crate,
reuses all of §2), `AddToCrateMenu` (per TrackRow, needs create-inline),
`CrateHeader` (rename/delete/count). V2 slot: share/publish — design the
data shape now (a `visibility` column), ship no UI.

## 8. Dedup review (M4)

For the 0.70–0.90 confidence band the PRD routes to humans.

`ReviewQueue` (pending pairs, count badge in AppNav for owner),
`ComparePanel` (two tracks side by side: score, duration delta, both
quality profiles, artwork, **A/B audition** — one PlayerBar, hot-swap
source), `MergeAction` (keep-which-file choice per the M2 quota decision —
first uploader keeps bytes; **undoable**, per PRD merge/undo requirement),
`NotDuplicateAction` (records a negative pair so the same pair never
resurfaces).

## 9. Admin (exists — M1; grows)

Shipped: `MemberTable`, `AllowlistForm`, `RevokeButton`, storage columns.
Add later: `OpsPanel` (M3 aftermath — stuck `analysing` rows older than 1 h,
dead-letter queue depth, last sweeper/reconcile run results) and
`ReviewQueue` entry point (M4).

## 10. Catalogue match (M7)

`MatchCard` (proposed AcoustID/Apple match with the ±3 s duration gate
result, accept/correct/reject), `ArtworkPicker` (uploaded vs fetched,
precedence per PRD §8.1), the Apple badge requirement (**"Listen on Apple
Music" badge next to displayed Apple artwork** — terms obligation, PRD §8.1).

## Cross-cutting rules

1. **Every list of tracks is one component.** Pool, crate view, review queue,
   "my uploads" — all `TrackTable` with different query params. If a second
   table component appears, that is drift.
2. **One player instance.** All play buttons delegate.
3. **Formatting utils are single-source**: `formatDuration` (exists),
   `formatBytes` (exists on /upload — extract), `camelotSortKey` (new),
   `formatBpm` (one decimal, `~` prefix rule for estimates).
4. **Degraded analysis is data, not error** — bpm 0/confidence 0 renders as
   "—" with a tooltip, everywhere.
5. **Islands stay leaf-level.** Pages compose server-rendered structure;
   interactivity islands are as small as the existing three.

## Build order (matches milestone dependencies)

1. `FileStateTicker` — the moment M3 Task 9 lands, uploads visibly complete
   their journey. Smallest, highest-feedback.
2. Shell (`AppNav`, `SourceLink`, `StatusRegion` extraction).
3. Pool: `TrackTable` + `FilterBar` (minus GenreFacet) + `KeyChip` +
   `QualityBadge` — the pool becomes *usable*.
4. Player + Download.
5. Track detail.
6. Then milestone-gated: M4 review, M6 crates, M7 match cards, M8 genre facet.
