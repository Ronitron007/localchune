# UI design — brutalist direction

Status: agreed in design session, 2026-07-29.

This spec sets the visual language and the page architecture for all UI work.
It refines [`2026-07-28-ui-components.md`](2026-07-28-ui-components.md) (the
parts list stands) and amends
[`../plans/2026-07-28-05-pool-ui.md`](../plans/2026-07-28-05-pool-ui.md) (§6
below lists the deltas). Mockups:
[claude.ai artifact](https://claude.ai/code/artifact/6c11cbc9-4f68-4948-aee1-84faa10437a1).

## 1. Design language

The look is deliberate brutalism — motherfuckingwebsite.com with a data model.
Five rules, none negotiable:

1. **No font.** The app declares no `font-family`. Text renders in the
   browser's default font. One exception: numeric data (BPM, duration,
   sizes, dates, keys) uses the `monospace` keyword. Both resolve locally;
   the app downloads zero font bytes.
2. **Monochrome.** Six tokens, greyscale only:

   | Token | Light | Dark |
   |---|---|---|
   | `--bg` | `#fff` | `#000` |
   | `--fg` | `#000` | `#fff` |
   | `--mid` (secondary text) | `#555` | `#aaa` |
   | `--line` (borders) | `#000` | `#fff` |
   | `--faint` (row rules) | `#ddd` | `#333` |
   | `--zebra` (row stripe) | `#f4f4f4` | `#121212` |

   v1 ships light only. Dark mode is the token swap and nothing else —
   when it ships, it is a `prefers-color-scheme` media query over the same
   six tokens. No second stylesheet, no component-level overrides.
3. **Hard geometry.** Borders are `1px solid var(--line)`. `border-radius: 0`
   and `box-shadow: none`, globally. The dropzone may use `dashed`.
4. **Native controls.** Inputs, selects, checkboxes, buttons and the audio
   player keep browser chrome. They may receive border, padding and
   `accent-color: var(--fg)` — never `appearance`, custom drawing, or a
   replacement widget.
5. **Artwork keeps its colour.** The chrome is monochrome; content is not.
   Album art renders unfiltered.

## 2. Page architecture

### The pool is server-rendered. Zero islands.

- Filters are one `<form method="get">`. Submit reloads the page.
- `src/pages/index.astro` parses its own URL (`parsePoolQuery`) and calls
  `pool_list()` server-side. The table renders on the server.
- Sort is a set of column-header links that rewrite `?sort=`.
- Pagination is one **next ›** link that carries the keyset cursor
  (`?cursor=`). Previous is the browser back button. There are no numbered
  page jumps — a keyset cursor cannot seek to page N, and the pool does not
  need it.
- A filtered URL is the complete filter state. Every view is shareable.
- The `GET /api/pool` JSON route from the M5 plan is **not built**. Nothing
  fetches JSON; the page is the client.

### One script site-wide: the router + player

Astro's `<ClientRouter />` loads in the shell. The player bar is a plain
`<div transition:persist="player">` in the layout with a native
`<audio controls>` element inside. The router swaps the page body around it,
so playback survives navigation, filter submits, sort clicks and pagination.

One vanilla `<script>` (~30 lines, no framework) does all of:

- delegate clicks on `.play[data-track-id]` links,
- fetch the signed stream URL from `GET /api/track/:id/source`,
- set `audio.src`, call `play()`, write the now-playing label.

Without JS the site degrades to plain MPA: every link and form still works;
only cross-page playback is lost. This replaces butternutcrack's
`PersistentPlayer` (345 lines + Solid + custom seek): same survival
property, no store, no custom chrome, no listen counter, no localStorage
resume.

### Progressive enhancement, exactly one

The search box auto-submits its form after a typing pause (`debounce.ts`
from the M5 plan). Without JS the Filter button submits the same form.

### Islands that remain

Solid islands stay only where the browser does real work:
`UploadDropzone` (exists), `FileStateTicker` + `AnalysisFailedRow` (poll
ingest state), `AllowlistForm` / `RevokeButton` (exist, admin). The pool
page mounts none.

## 3. Component triage

Verdict on every component in the inventory spec:

| Component | Verdict | Form |
|---|---|---|
| `AppNav`, `StorageChip`, `SourceLink` | **must** | `.astro`, as planned |
| `StatusRegion` extraction | **must** | `.tsx`, used by remaining islands only |
| `TrackTable`, `TrackRow`, `EmptyState` | **must** | `.astro` templates, not islands |
| `KeyChip`, `QualityBadge` | **must** | `.astro`; tooltips via `title=` |
| `FilterBar` + `SearchBox`, `BpmRangeFilter`, `KeyFilter`, `QualityFilter`, `UploaderFilter` | **must** | one GET form, native controls |
| Art thumbnail (new, this session) | **must** | `<img>` per row, §4 |
| `PlayerBar`, `PlayButton` | **must** | persisted div + native audio + links |
| `DownloadButton` | **must** | plain link to the 302 route |
| `FileStateTicker`, `AnalysisFailedRow` | **must** | islands, as planned |
| Track detail page | **must** | `.astro`, as planned |
| `WaveformScrubber` | **cut from v1** | native seek bar instead; peaks JSON still produced, so it can land later without pipeline work |
| Virtualised rows | **cut** (plan already cut it) | 100-row pages |
| `GenreFacet` | **deferred M8** | empty slot, as planned |
| Crates set (§7), dedup review (§8), match cards (§10) | **deferred** M6/M4/M7 | reuse the pool table template |
| Circle-of-fifths colour chips (cue-tracks salvage) | **dead** | violates monochrome; key chips are inverted black/white |

BPM filter is min/max plus the half/double toggle, matching `pool_list()`.
The inventory's "±3%" expansion is dropped: a range input already expresses
tolerance, and the RPC has no parameter for it.

## 4. Artwork thumbnails

- Every pool row shows a 28px square thumb; the detail page shows a larger
  copy. Missing art renders a bordered empty box, never a broken image.
- Source order: embedded art → fetched art (M7) → empty box. The analysis
  worker already extracts embedded art (`worker/app/main.py:246`,
  `artwork.jpg`), so thumbs work from M5 day one.
- **New worker task:** emit `thumb.jpg` (64px, quality ~70) next to
  `artwork.jpg` in `derived/<file_id>/`. Rows must never load full-size art.
  Backfill note: files analysed before this task lands have no `thumb.jpg`;
  fall back to the empty box (or `artwork.jpg` on the detail page only).
- Thumbs are served through the same signed-GET path as other derived
  artifacts, with immutable cache-control.
- **Apple-sourced art never appears in the table.** Its badge obligation
  (PRD §8.1) is honoured on the detail page only, where the badge fits.

## 5. Amendments to the M5 plan

The plan's Tasks 1–5 and 8, and Task 7's backend half (`presignGet`,
derived-key validation, source/download routes), stand unchanged. Deltas:

1. Task 6: `TrackTable`, `FilterBar`, `TrackRow`, `KeyChip`,
   `QualityBadge`, `EmptyState` become `.astro` server templates. Same
   names, same data, no `client:` directive. `GenreFacet` stays an empty
   slot. `debounce.ts` survives for the search enhancement.
2. Task 6: drop `src/pages/api/pool.ts`. Keep `src/lib/pool-api.ts` and its
   tests; `index.astro` is its only consumer.
3. Task 7: drop `player-store.ts`, `PlayerBar.tsx`, `PlayButton.tsx`,
   `WaveformScrubber.tsx`, `peaks.ts` and the peaks API route. Add: shell
   `<ClientRouter />`, the persisted player div, the ~30-line script.
4. Task 5 (shell): the shell owns the player div and the script, so every
   page keeps the bar.
5. Plan deferral overruled: cross-page player persistence is **v1** (the
   plan's line put it in v2). The ClientRouter approach makes it ~free.
6. New task (worker repo): the 64px `thumb.jpg` variant, §4.
7. The plan's manual checklist gains: playback continues across a filter
   submit, a sort click, a pagination click and a detail-page navigation;
   with JS disabled, filters, sort, pagination and download still work.

## 6. What "done" looks like

The M5 plan's "Done when" list stands, minus the waveform items, plus:

- View-source on `/` shows the full table content — no client fetch renders
  rows.
- The only `<script>` on the pool page is the router + player + search
  debounce.
- No `@font-face`, no `font-family` beyond `monospace`, anywhere.
- Lighthouse on `/` over 2k tracks: no render-blocking request beyond the
  one stylesheet.
- Dark mode inverts every surface with no component-level overrides.

## Unresolved questions

1. Art thumbs: colour (current spec) or CSS-grayscale to match the chrome?
2. Keep butternutcrack's localStorage resume-position in v1, or cut? (Spec
   currently cuts it.)
3. `thumb.jpg` at 64px — confirm size/format before the worker task lands.
