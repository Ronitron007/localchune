# M5 as amended — Brutalist Pool UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the pool UI per the brutalist design spec: a fully server-rendered pool page (zero islands), one persistent native `<audio>` player that survives navigation via Astro's ClientRouter, brutalist monochrome chrome, artwork thumbnails, and the signed-GET stream/download/art routes.

**Spec:** [`docs/superpowers/specs/2026-07-29-ui-brutalist-design.md`](../specs/2026-07-29-ui-brutalist-design.md), which amends [`docs/superpowers/plans/2026-07-28-05-pool-ui.md`](2026-07-28-05-pool-ui.md) (hereafter **the M5 plan**). Where this plan says *"execute M5 plan Task N Step M verbatim"*, the complete code is in that file — open it and follow it exactly; the referenced steps are complete, tested content, not sketches. Every delta from the M5 plan is written out in full here.

**Architecture:** All filtering, sorting and paging happens in Postgres behind `pool_list()`. `src/pages/index.astro` parses its own URL and renders the table on the server. Filters are one `<form method="get">`; sort is column-header links; pagination is one **next ›** link carrying the keyset cursor. The single site-wide script does play-link delegation + signed-source fetch + search auto-submit; Astro's `<ClientRouter />` swaps page bodies around a `transition:persist` player div so playback survives navigation. There is **no** `GET /api/pool` JSON route.

**Tech stack:** Astro 7 SSR on `@astrojs/cloudflare`, Solid islands only on upload/admin pages, Supabase (Postgres 15 + Auth), R2 via `aws4fetch`, Vitest (node), pgTAP. Python analysis worker (FastAPI in container) + `workers/analysis` DO.

## Global Constraints

All of the M5 plan's Global Constraints stand (read them before any task — they are hard-won). Plus the five brutalist rules, none negotiable:

1. **No font.** No `font-family` anywhere except the `monospace` keyword on numeric data (BPM, duration, sizes, dates, keys). No `@font-face`, zero font bytes downloaded.
2. **Monochrome, six tokens only:** `--bg` #fff/#000, `--fg` #000/#fff, `--mid` #555/#aaa, `--line` #000/#fff, `--faint` #ddd/#333, `--zebra` #f4f4f4/#121212 (light/dark). Dark mode is a `prefers-color-scheme` media query over the same six tokens and nothing else — no component-level colour overrides, ever.
3. **Hard geometry.** Borders `1px solid var(--line)`. `border-radius: 0` and `box-shadow: none`, globally. Only the dropzone may use `dashed`.
4. **Native controls.** Inputs, selects, checkboxes, buttons, `<audio controls>` keep browser chrome. Allowed: border, padding, `accent-color: var(--fg)`. Forbidden: `appearance`, custom drawing, replacement widgets.
5. **Artwork keeps its colour.** Chrome is monochrome; album art renders unfiltered.

And the architectural rules from the spec:

- **The pool page mounts zero islands.** The only `<script>` on it is the router + player + search debounce.
- The Worker never proxies audio or image bytes — signed R2 GETs only.
- Rows must never load full-size art; rows use `thumb.jpg` (64px) or a bordered empty box.
- Apple-sourced art never appears in the table (M7 concern; badge obligation is detail-page-only).
- MIT header on every hand-authored file (three-line block from `src/lib/email.ts`; `.astro` inside frontmatter fence, `.sql` as `--` comments, `.css` as `/* */`, `.py` as `#`).

---

> **Post-rebase amendment (2026-07-29):** M3 Task 9 landed on `rohan/m3-analysis`
> mid-execution with its own richer `20260728110000_09_analysis.sql` (including
> `analysis_persist()` and the fingerprints table) and took the migration-10 slot
> with `20260729120000_10_close_acls.sql`. This branch rebased onto it: Task 1's
> minimal migration 09 was dropped in favour of M3's; the three M5 migrations
> below landed renumbered as `20260729130000_11_pool_view.sql`,
> `20260729130100_12_pool_rpc.sql`, `20260729130200_13_upload_status.sql`; and a
> new `20260729130300_14_analysis_persist_thumb.sql` re-creates
> `analysis_persist()` with the `thumb_key` write (closing Unresolved question 4).
> `r2.ts` merged onto M3's signed-GET implementation (`readObjectUrl`, stricter
> `DERIVED_KEY_RE`), extended with the response-header overrides and
> `GET_TTL_SECONDS` the routes here need.

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260728110000_09_analysis.sql` | `audio_analysis` table (M3 Task 9's draft DDL — landed here because M5 needs it first) |
| `supabase/migrations/20260728120000_10_pool_view.sql` | as M5 plan + `thumb_key` column |
| `supabase/migrations/20260728120100_11_pool_rpc.sql` | as M5 plan + `has_thumb` / `thumb_key` outputs |
| `supabase/migrations/20260728120200_12_upload_status.sql` | verbatim M5 plan |
| `supabase/tests/pool_view.sql`, `pool_list.sql`, `upload_status.sql` | verbatim M5 plan |
| `src/lib/track-format.ts` + `.test.ts` | verbatim M5 plan |
| `src/lib/pool-api.ts` + `.test.ts` | M5 plan minus `PoolResponse`, plus `has_thumb`, plus `poolHref()` |
| `src/lib/debounce.ts` + `.test.ts` | verbatim M5 plan |
| `src/lib/build-info.ts` + `.test.ts` | verbatim M5 plan |
| `src/styles/global.css` | **new** — the entire brutalist stylesheet, six tokens |
| `src/scripts/site.ts` | **new** — the one script: play delegation + search auto-submit |
| `src/layouts/Shell.astro` | shell + `<ClientRouter />` + persisted player div + the script |
| `src/components/AppNav.astro`, `StorageChip.astro`, `SourceLink.astro`, `StatusRegion.tsx` | verbatim M5 plan |
| `src/components/TrackTable.astro`, `TrackRow.astro`, `KeyChip.astro`, `QualityBadge.astro`, `EmptyState.astro`, `FilterBar.astro`, `GenreFacet.astro` | **`.astro` server templates**, not islands |
| `src/pages/index.astro` | server-rendered pool page, zero islands |
| `src/pages/api/track/[id]/source.ts`, `download.ts` | verbatim M5 plan |
| `src/pages/api/track/[id]/art.ts` | **new** — 302 to signed thumb/artwork |
| `src/pages/api/build-info.ts` | verbatim M5 plan |
| `src/pages/track/[id].astro` | detail page, `.astro` chips, artwork, play/download links |
| `src/lib/upload-batch.ts`, `src/pages/api/upload/status.ts`, `src/components/FileStateTicker.tsx`, `AnalysisFailedRow.tsx` | verbatim M5 plan (islands — they poll) |
| `src/lib/r2.ts` (+ `.test.ts` append) | verbatim M5 plan: `presignGet`, `readableObjectUrl`, `GET_TTL_SECONDS` |
| `worker/app/tags.py`, `worker/app/main.py`, `worker/app/models.py`, `workers/analysis/src/index.ts` | **new worker task** — 64px `thumb.jpg` |

**Not built (M5 plan entries this spec kills):** `src/pages/api/pool.ts`, `src/pages/api/track/[id]/peaks.ts`, `src/lib/peaks.ts`, `src/lib/player-store.ts`, `PlayerBar.tsx`, `PlayButton.tsx`, `WaveformScrubber.tsx`, `DownloadButton.tsx`, `TrackTable.tsx`, `FilterBar.tsx`, `TrackRow.tsx`, `KeyChip.tsx`, `QualityBadge.tsx`, `EmptyState.tsx`, `GenreFacet.tsx`.

---

### Task 1: The `audio_analysis` table (M3 Task 9 prerequisite)

The M5 plan's Prerequisites section is explicit: land M3 Task 9's migration **first** so `db reset` applies it before migrations 10–12. The full consumer (queue handler, cron, `persist()`) is M3's own work and is **not** built here — an empty pool is correct until it lands. Only the DDL moves.

**Files:**
- Create: `supabase/migrations/20260728110000_09_analysis.sql`

**Interfaces:**
- Consumes: `public.files` (migration 06).
- Produces: `public.audio_analysis` — consumed by migrations 10–11 and their pgTAP fixtures. M3 Task 9's `persist()` must later populate it, including the four artifact-key columns migration 10 adds.

- [ ] **Step 1: Write the migration** — the DDL from M3 plan Task 9 Step 1, verbatim, plus the standard header:

```sql
-- supabase/migrations/20260728110000_09_analysis.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- M3 Task 9's table, landed ahead of the consumer because M5's pool view
-- joins it and M5's pgTAP fixtures insert into it. RLS is enabled here;
-- the policy, the base grants and the artifact-key columns are migration
-- 10's job (everything there is idempotent, so whichever milestone lands
-- first wins). The fingerprints table stays with M3 Task 9 proper — the
-- pool does not read it.
create table public.audio_analysis (
  file_id          uuid primary key references public.files(id) on delete cascade,
  analysis_version text not null,
  duration_ms      int,
  bpm              real,
  bpm_median_ibi   real,
  beat_grid        real[],
  downbeat_grid    real[],
  ibi_std_ms       real,
  key_camelot      text,
  key_open         text,
  key_musical      text,
  key_strength     real,
  key_alt_profiles jsonb,
  integrated_lufs  real,
  lra_lu           real,
  true_peak_dbtp   real,
  replaygain_db    real,
  clipped_pct      real,
  meas_cutoff_hz   int,
  meas_cliff_db    real,
  lossy_ancestor   text check (lossy_ancestor in ('none','suspected','confirmed','abstain')),
  quality_tier     smallint,
  quality_score    real,
  raw_tags         jsonb,
  cpu_seconds      real,
  analyzed_at      timestamptz not null default now(),
  unique (file_id, analysis_version)
);
alter table public.audio_analysis enable row level security;
create index audio_analysis_track_idx on public.audio_analysis (quality_score desc);
```

- [ ] **Step 2: Apply it**

Run: `npx supabase db reset`
Expected: all migrations 00–09 apply cleanly.

- [ ] **Step 3: Run the existing pgTAP suite**

Run: `npx supabase test db`
Expected: every pre-existing file still green (this migration adds a table nothing reads yet).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260728110000_09_analysis.sql
git commit -m "feat(analysis): audio_analysis table — m3 task 9 ddl, landed as m5 prerequisite"
```

---

### Task 2: Track-format utilities

**Execute M5 plan Task 1 (Steps 1–5) verbatim.** No deltas. Creates `src/lib/track-format.ts` + `src/lib/track-format.test.ts`.

- [ ] Steps 1–4: write failing test, confirm fail, implement, confirm 21 tests pass (`npx vitest run src/lib/track-format.test.ts`)
- [ ] Step 5: commit as written there

---

### Task 3: The pool view

**Execute M5 plan Task 2 (Steps 1–5) with the three edits below.** The spec adds artwork thumbnails, so the view must say whether a row has one.

**Edits to M5's `supabase/migrations/20260728120000_10_pool_view.sql`:**

1. After the three `add column` statements, add a fourth:

```sql
alter table public.audio_analysis add column if not exists thumb_key text;

comment on column public.audio_analysis.thumb_key is
  'Basename of the 64px cover thumbnail inside derived/<file_id>/. NULL
   means the file was analysed before the thumb task landed (or has no
   embedded art) and the row renders a bordered empty box instead.';
```

2. In the `pool_tracks` view's select list, directly after `a.artwork_key,` add:

```sql
  a.thumb_key,
```

3. No other changes. The pgTAP file `supabase/tests/pool_view.sql` is verbatim from the M5 plan (17 tests).

- [ ] Step 1: write the migration (M5 text + edits 1–2)
- [ ] Step 2: `npx supabase db reset` — applies cleanly (Task 1 already landed migration 09, so the `relation does not exist` failure mode is closed)
- [ ] Step 3: write `supabase/tests/pool_view.sql` verbatim
- [ ] Step 4: `npx supabase test db` — 17 pass here, everything else green
- [ ] Step 5: commit as written in M5

---

### Task 4: The list, detail and facet RPCs

**Execute M5 plan Task 3 (Steps 1–5) with the four edits below.**

**Edits to M5's `supabase/migrations/20260728120100_11_pool_rpc.sql`:**

1. `pool_list` return table: after `has_peaks boolean,` add:

```sql
  has_thumb         boolean,
```

2. `pool_list` body select: after `b.peaks_key is not null,` add:

```sql
         b.thumb_key is not null,
```

3. `pool_get` return table: after `artwork_key text,` add:

```sql
  thumb_key         text,
```

4. `pool_get` body select: after `t.preview_key, t.peaks_key, t.artwork_key,` becomes:

```sql
         t.preview_key, t.peaks_key, t.artwork_key, t.thumb_key,
```

The pgTAP file `supabase/tests/pool_list.sql` is verbatim from the M5 plan (20 tests) — none of its assertions name the new columns, so it passes unchanged.

- [ ] Step 1: write the migration (M5 text + edits 1–4)
- [ ] Step 2: `npx supabase db reset`
- [ ] Step 3: write `supabase/tests/pool_list.sql` verbatim
- [ ] Step 4: `npx supabase test db` — 20 pass here, 17 in pool_view, rest green
- [ ] Step 5: commit as written in M5

---

### Task 5: The query contract (no JSON route)

**Execute M5 plan Task 4 Steps 1–4 and 6 with the edits below. Do NOT execute Step 5 (`src/pages/api/pool.ts`) or Step 7 — the route is not built; the page is the client.**

**Edits to `src/lib/pool-api.ts` as given in M5 Task 4 Step 3:**

1. Delete the `PoolResponse` type entirely (nothing fetches JSON).
2. In `PoolTrack`, after `has_peaks: boolean` add:

```ts
  has_thumb: boolean
```

3. Append `poolHref` at the end of the file:

```ts
/**
 * The pool page's only link builder. Sort links restart paging on purpose —
 * a keyset cursor is only valid within the sort that minted it, so a sort
 * change never carries `cursor`. The next-page link carries both.
 */
export function poolHref(
  q: PoolQuery, opts: { sort?: PoolSort; cursor?: string } = {},
): string {
  const sp = poolQueryToSearchParams(opts.sort === undefined ? q : { ...q, sort: opts.sort })
  if (opts.cursor !== undefined) sp.set('cursor', opts.cursor)
  const s = sp.toString()
  return s === '' ? '/' : `/?${s}`
}
```

**Edits to `src/lib/pool-api.test.ts` as given in M5 Task 4 Step 1:** append this describe block:

```ts
describe('poolHref', () => {
  it('is a clean / for the default query', () => {
    expect(poolHref(EMPTY_QUERY)).toBe('/')
  })
  it('keeps the filters and swaps the sort, dropping any cursor', () => {
    const q = { ...EMPTY_QUERY, bpmMin: 120, sort: 'added_desc' as const }
    expect(poolHref(q, { sort: 'bpm_asc' })).toBe('/?bpm_min=120&sort=bpm_asc')
  })
  it('carries the cursor for the next page under the current sort', () => {
    const q = { ...EMPTY_QUERY, sort: 'bpm_asc' as const }
    expect(poolHref(q, { cursor: '00000123abc' }))
      .toBe('/?sort=bpm_asc&cursor=00000123abc')
  })
})
```

(and add `poolHref` to the import list). Expected total: 17 tests.

**Edit to M5 Task 4 Step 6** (the `src/lib/upload-api.ts` header rewrite): use this text instead, since `/api/pool` does not exist:

```ts
/**
 * Request parsing, error mapping and the ownership lookup shared by the
 * /api/upload routes, and the JSON error vocabulary (`jsonError`,
 * `rpcError`, `dbErrorResponse`, `isUuid`) shared by every JSON route
 * including /api/track/* and /api/upload/status.
 *
 * This module exists separately from the routes because every upload route
 * imports src/lib/r2.ts, which imports `cloudflare:workers` — a workerd
 * built-in Vitest cannot resolve. A validator inside a route file is
 * therefore permanently untestable. Nothing here may import r2.ts.
 */
```

- [ ] Step 1: write the failing test (M5 text + the `poolHref` block, minus nothing else)
- [ ] Step 2: `npx vitest run src/lib/pool-api.test.ts` → FAIL (unresolved import)
- [ ] Step 3: implement (M5 text + edits 1–3)
- [ ] Step 4: run → PASS, 17 tests
- [ ] Step 5: widen the upload-api header comment (text above)
- [ ] Step 6: commit:

```bash
git add src/lib/pool-api.ts src/lib/pool-api.test.ts src/lib/upload-api.ts
git commit -m "feat(pool): url<->query contract and link builder — no json route"
```

---

### Task 6: Shell, brutalist stylesheet, persistent native player

**Execute M5 plan Task 5 (Steps 1–9) with the replacements below.** Steps 1–3 (build SHA, build-info tests, `build-info.ts`), Step 5 (`StatusRegion` extraction into the three existing islands), Step 6 (build-info endpoint + `PUBLIC_PATHS` + login footer) and Step 7's upload/admin adoption are verbatim. The deltas: `Shell.astro` is replaced wholesale (router + player + stylesheet + script), and two new files are created.

**Files (beyond M5 Task 5's list):**
- Create: `src/styles/global.css`, `src/scripts/site.ts`

**Interfaces:**
- Produces: `Shell.astro` with props `{ title: string }` (the named `player` slot from M5 is **gone** — the shell owns the player div itself, so every page keeps the bar); the DOM contract `#player-audio` (native `<audio>`), `#player-label`, `a.play[data-track-id][data-label]`, `form[data-autosubmit]` — consumed by `src/scripts/site.ts` and Tasks 7 & 10.
- Consumes: `debounce` (M5 Task 6 defines it — created **here** instead, see Step 4, since the script needs it first).

- [ ] **Step 1: M5 Task 5 Steps 1–3 verbatim** (astro.config.ts `vite.define`, `build-info.test.ts` → FAIL, `build-info.ts` → PASS 5 tests)

- [ ] **Step 2: M5 Task 5 Step 4's three components verbatim** (`SourceLink.astro`, `StorageChip.astro`, `AppNav.astro`) — but **not** its `Shell.astro`; ours is Step 5 below.

- [ ] **Step 3: The stylesheet**

```css
/* src/styles/global.css
   localchune — MIT licensed. See LICENSE.
   NOTE: the distributed combination is AGPL-3.0 because the analysis
   worker includes Essentia. LICENSE explains why.

   The entire visual language. Six greyscale tokens, no font-family (the
   browser default is the typeface), 1px solid borders, zero radii, zero
   shadows. Dark mode is the token swap below and NOTHING else — if a
   component ever needs a colour this file does not define, the design is
   wrong, not this file. */

:root {
  --bg: #fff;
  --fg: #000;
  --mid: #555;
  --line: #000;
  --faint: #ddd;
  --zebra: #f4f4f4;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000;
    --fg: #fff;
    --mid: #aaa;
    --line: #fff;
    --faint: #333;
    --zebra: #121212;
  }
}

*, *::before, *::after {
  border-radius: 0;
  box-shadow: none;
  box-sizing: border-box;
}

html {
  background: var(--bg);
  color: var(--fg);
}

body {
  margin: 0 auto;
  max-width: 72rem;
  /* Room for the fixed player bar. */
  padding: 0 1rem 6rem;
}

a { color: var(--fg); }

h1, h2 { font-weight: bold; }

/* Numeric data is the one permitted second face. */
.num, .keychip { font-family: monospace; }

/* --- nav / footer --- */
.appnav {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.appnav a[aria-current='page'] { font-weight: bold; text-decoration: none; }
.appnav .who, .appnav .credits { color: var(--mid); margin-left: auto; }
.appnav .who + .credits { margin-left: 0; }

.appfoot {
  display: flex;
  gap: 1rem;
  padding: 1rem 0;
  border-top: 1px solid var(--line);
  color: var(--mid);
  flex-wrap: wrap;
}

/* --- native controls: border, padding, accent — nothing else --- */
input, select, button {
  accent-color: var(--fg);
  border: 1px solid var(--line);
  padding: 0.15rem 0.4rem;
}
input[type='checkbox'], input[type='radio'] { border: none; }

/* --- filter form --- */
.filterbar {
  display: flex;
  align-items: end;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.75rem 0;
}
.filterbar fieldset {
  border: 1px solid var(--faint);
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.5rem;
}
.filterbar label { display: inline-flex; align-items: center; gap: 0.35rem; }
.filterbar input[type='number'] { width: 4.5rem; }

/* --- the table --- */
table { border-collapse: collapse; width: 100%; }
th, td {
  text-align: left;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--faint);
}
thead th { border-bottom: 1px solid var(--line); }
tbody tr:nth-child(even) { background: var(--zebra); }
th a { text-decoration: none; }
th a[aria-current] { font-weight: bold; }
th a[aria-current]::after { content: ' ▾'; }
td.uploader, td.added { color: var(--mid); }

/* --- artwork thumbs: content keeps its colour; the box is chrome --- */
img.thumb, .thumb-empty {
  width: 28px;
  height: 28px;
  display: block;
}
img.thumb { object-fit: cover; border: 1px solid var(--line); }
.thumb-empty { border: 1px solid var(--faint); }
img.art { max-width: 256px; height: auto; border: 1px solid var(--line); }

/* --- player bar --- */
.playerbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  background: var(--bg);
  border-top: 1px solid var(--line);
}
.playerbar audio { flex: 1; max-width: 32rem; }
.playerbar .nowplaying { color: var(--mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --- odds and ends --- */
.keychip {
  background: var(--fg);
  color: var(--bg);
  padding: 0 0.35em;
  display: inline-block;
}
.empty { border: 1px solid var(--faint); padding: 1rem; color: var(--mid); }
.empty a, .empty p { color: var(--fg); }
.counts { color: var(--mid); }
.pager { padding: 0.75rem 0; }
.dropzone { border: 1px dashed var(--line); }
.status.error { color: var(--fg); font-weight: bold; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; }
dt { color: var(--mid); }
dd { margin: 0; }
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 4: `debounce.ts` — pulled forward from M5 Task 6 Steps 2** (the site script imports it). Execute M5 plan Task 6 Step 2 verbatim: write `src/lib/debounce.test.ts` → FAIL → implement `src/lib/debounce.ts` → PASS, 3 tests.

- [ ] **Step 5: The one script and the new shell**

```ts
// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'

/**
 * The whole client, ~30 lines: play-link delegation into the one persisted
 * <audio>, and the search box's auto-submit. Document-level listeners on
 * purpose — the ClientRouter swaps page bodies, and delegation is what
 * survives a swap without re-binding. Without JS every play link degrades
 * to its href (the track page) and the Filter button submits the form.
 */
const audio = document.getElementById('player-audio') as HTMLAudioElement | null
const label = document.getElementById('player-label')

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a.play[data-track-id]')
  if (!(a instanceof HTMLAnchorElement) || audio === null) return
  e.preventDefault()
  void (async () => {
    const res = await fetch(`/api/track/${a.dataset.trackId}/source`, {
      headers: { accept: 'application/json' },
    })
    // Non-JSON means middleware redirected to /login — say so, do not parse.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (label) label.textContent = 'Session ended — reload to sign in.'
      return
    }
    const body = (await res.json()) as { url?: string; message?: string; error?: string }
    if (!res.ok || !body.url) {
      if (label) label.textContent = body.message ?? body.error ?? 'could not load that track'
      return
    }
    audio.src = body.url
    if (label) label.textContent = a.dataset.label ?? ''
    void audio.play().catch(() => {
      if (label) label.textContent = 'That track would not play. Try downloading it.'
    })
  })()
})

const autosubmit = debounce((form: HTMLFormElement) => form.requestSubmit(), 300)
document.addEventListener('input', (e) => {
  const el = e.target
  if (el instanceof HTMLInputElement && el.name === 'q'
      && el.form?.hasAttribute('data-autosubmit')) autosubmit(el.form)
})
```

```astro
---
// src/layouts/Shell.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The shell owns three things beyond the frame: the <ClientRouter />, the
// persisted player div, and the one site script. The router swaps page
// bodies AROUND the transition:persist div, which is what lets playback
// survive filter submits, sort clicks, pagination and detail navigation —
// butternutcrack needed 345 lines and a store for the same property.
import { ClientRouter } from 'astro:transitions'
import AppNav from '../components/AppNav.astro'
import SourceLink from '../components/SourceLink.astro'
import StorageChip from '../components/StorageChip.astro'
import '../styles/global.css'

interface Props { title: string }
const { title } = Astro.props
---
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <ClientRouter />
</head>
<body>
  <AppNav />
  <main><slot /></main>
  <footer class="appfoot">
    <StorageChip />
    <SourceLink />
  </footer>
  <div class="playerbar" transition:persist="player">
    <span id="player-label" class="nowplaying" aria-live="polite"></span>
    <audio id="player-audio" controls preload="none"></audio>
  </div>
  <script src="../scripts/site.ts"></script>
</body>
</html>
```

- [ ] **Step 6: M5 Task 5 Steps 5–7 verbatim** (StatusRegion + the three island substitutions; build-info endpoint + `PUBLIC_PATHS` + login footer; adopt the shell on `index.astro` — just wrap the existing body for now, Task 7 rewrites it — `upload.astro` and `admin/index.astro`).

- [ ] **Step 7: Verify**

```bash
npm run check && npm test && npm run build
npm run dev
```

M5 Task 5 Step 8's four browser checks, plus:
5. Every page shows the player bar (empty label, idle native audio control) pinned to the bottom.
6. View source: exactly one stylesheet link, no `@font-face`, no `font-family` outside the `monospace` declarations in global.css.
7. DevTools → emulate `prefers-color-scheme: dark`: every surface inverts; nothing stays light.

- [ ] **Step 8: Commit**

```bash
git add astro.config.ts src/layouts src/components src/styles src/scripts \
        src/lib/build-info.ts src/lib/build-info.test.ts \
        src/lib/debounce.ts src/lib/debounce.test.ts src/pages src/middleware.ts
git commit -m "feat(shell): brutalist chrome, client router, persisted native player"
```

---

### Task 7: The pool — server-rendered table, GET-form filters

Replaces M5 plan Task 6. Same data, same names, zero islands. Everything renders on the server; the URL is the complete filter state.

**Files:**
- Create: `src/components/KeyChip.astro`, `src/components/QualityBadge.astro`, `src/components/EmptyState.astro`, `src/components/TrackRow.astro`, `src/components/TrackTable.astro`, `src/components/FilterBar.astro`, `src/components/GenreFacet.astro`
- Modify: `src/lib/format.ts`, `src/lib/preflight.ts` (move `formatDuration` — M5 Task 6 Step 1 verbatim), `src/pages/index.astro`

**Interfaces:**
- Consumes: `PoolQuery` / `PoolTrack` / `parsePoolQuery` / `poolListArgs` / `poolHref` / `isDefaultQuery` / `PAGE_SIZE` / `POOL_SORTS` (Task 5), `formatBpm` / `keyTooltip` / `qualityLabel` / `qualityTooltip` (Task 2), `formatDuration` / `formatBytes` (`src/lib/format.ts`), `Shell.astro` + the `a.play` / `data-autosubmit` DOM contract (Task 6).
- Produces: the pool page. Play links point at `/api/track/:id/source` (via the script) and `/track/:id` (href fallback); download links at `/api/track/:id/download`; thumbs at `/api/track/:id/art` — all Task 8 routes. Building the page first is fine: links 404 until Task 8 lands, and the page itself never fetches.

- [ ] **Step 1: M5 Task 6 Step 1 verbatim** — move `formatDuration` from `preflight.ts` to `format.ts`, re-export, both test files still pass.

- [ ] **Step 2: The presentational templates**

```astro
---
// src/components/KeyChip.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// Camelot on the chip, the other two profiles in the tooltip. Inverted
// black/white, monospace — the circle-of-fifths colouring from cue-tracks
// is dead on arrival here: it violates the monochrome rule.
import { keyTooltip } from '../lib/track-format'
interface Props { camelot: string | null; open: string | null; musical: string | null }
const { camelot, open, musical } = Astro.props
---
{camelot
  ? <span class="keychip" title={keyTooltip(camelot, open, musical)}>{camelot}</span>
  : <span class="num" title={keyTooltip(null, null, null)}>—</span>}
```

```astro
---
// src/components/QualityBadge.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The tooltip says MEASURED and names the measurement, because the claim
// being made is "this file is not what its container says it is". PRD §7.2:
// `abstain` renders neutral, never accusatory.
import { qualityLabel, qualityTooltip } from '../lib/track-format'
interface Props { tier: number | null; lossyAncestor: string | null; measCutoffHz: number | null }
const { tier, lossyAncestor, measCutoffHz } = Astro.props
---
<span class="qualitybadge num" title={qualityTooltip(tier, lossyAncestor, measCutoffHz)}>
  {qualityLabel(tier)}
</span>
```

```astro
---
// src/components/EmptyState.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// Three situations, three messages, three next actions — collapsing them
// into one "No results" is how an empty pool gets mistaken for a broken
// filter. The server decides the variant; nothing here is interactive.
interface Props { variant: 'pool-empty' | 'no-search-match' | 'no-filter-match'; term?: string }
const { variant, term = '' } = Astro.props
---
<div class="empty" role="status">
  {variant === 'pool-empty' && (
    <>
      <p>Nothing in the pool yet.</p>
      <p>Tracks appear here once they have been analysed. <a href="/upload">Upload some</a>.</p>
    </>
  )}
  {variant === 'no-search-match' && (
    <>
      <p>No track matches “{term}”.</p>
      <p>Search covers artist, title and filename. <a href="/">Clear filters</a></p>
    </>
  )}
  {variant === 'no-filter-match' && (
    <>
      <p>No track matches these filters.</p>
      <p>Try widening the BPM range, or turning on half/double time. <a href="/">Clear filters</a></p>
    </>
  )}
</div>
```

```astro
---
// src/components/GenreFacet.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The M8 slot. Genre needs a normalised vocabulary from the Discogs dumps
// (PRD §9.1); until that data exists `families` is always [] and this
// renders NOTHING, so no one sees a facet that filters nothing. Shipped
// now, empty, so the M8 task is a data task and not a layout task.
interface Props { families: { family: string; styles: string[] }[] }
const { families } = Astro.props
---
{families.length > 0 && (
  <fieldset class="facet genre">
    <legend>Genre</legend>
    {families.map((fam) => (
      <span class="family">{fam.family}: {fam.styles.join(', ')}</span>
    ))}
  </fieldset>
)}
```

- [ ] **Step 3: `TrackRow.astro`**

```astro
---
// src/components/TrackRow.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// One row. No crates column (M6 — omit, don't disable). Artist and title
// come from the server (migration 10's display_* fallbacks) and are never
// re-derived here — search matches the server's strings.
//
// The play control is a LINK whose href is the track page: with JS the
// site script intercepts it and streams; without JS it navigates, which
// still works. The thumb <img> only renders when thumb.jpg exists — rows
// never load full-size art, and a missing thumb is a bordered empty box,
// never a broken image.
import KeyChip from './KeyChip.astro'
import QualityBadge from './QualityBadge.astro'
import { formatBpm } from '../lib/track-format'
import { formatDuration } from '../lib/format'
import type { PoolTrack } from '../lib/pool-api'

interface Props { track: PoolTrack }
const { track } = Astro.props
const artist = track.display_artist ?? 'Unknown artist'
const noBeat = track.bpm === null || track.bpm <= 0
const added = new Date(track.created_at).toISOString().slice(0, 10)
---
<tr class="trackrow">
  <td class="controls">
    <a
      class="play"
      href={`/track/${track.file_id}`}
      data-track-id={track.file_id}
      data-label={`${artist} — ${track.display_title}`}
      aria-label={`Play ${track.display_title}`}
    >▶</a>
  </td>
  <td class="art">
    {track.has_thumb
      ? <img class="thumb" src={`/api/track/${track.file_id}/art`} alt="" width="28" height="28" loading="lazy" />
      : <span class="thumb-empty" aria-hidden="true"></span>}
  </td>
  <td class="title">
    <a href={`/track/${track.file_id}`}>
      <span class="artist">{artist}</span>
      <span class="sep"> — </span>
      <span class="name">{track.display_title}</span>
    </a>
  </td>
  <td class="bpm num" title={noBeat ? 'no beat detected' : undefined}>
    {formatBpm(track.bpm, track.ibi_std_ms)}
  </td>
  <td class="key">
    <KeyChip camelot={track.key_camelot} open={track.key_open} musical={track.key_musical} />
  </td>
  <td class="duration num">{formatDuration(track.duration_ms)}</td>
  <td class="quality">
    <QualityBadge tier={track.quality_tier} lossyAncestor={track.lossy_ancestor} measCutoffHz={track.meas_cutoff_hz} />
  </td>
  <td class="uploader">{track.uploader_name}</td>
  <td class="added num">{added}</td>
  <td class="download">
    <a href={`/api/track/${track.file_id}/download`} aria-label={`Download ${track.display_title}`}>↓</a>
  </td>
</tr>
```

- [ ] **Step 4: `FilterBar.astro`** — one GET form, native controls, no JS required

```astro
---
// src/components/FilterBar.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The filter state IS the URL. Submitting reloads the page; the Filter
// button is the no-JS path and the search box auto-submits after a typing
// pause via the site script (data-autosubmit). Sort is NOT a form field —
// it is the column headers — but the current sort persists across a filter
// submit through the hidden input. `cursor` is deliberately absent: a new
// filter starts at page one.
import GenreFacet from './GenreFacet.astro'
import { DEFAULT_SORT, type PoolQuery } from '../lib/pool-api'

interface Props { query: PoolQuery; uploaders: { member_id: string; uploader_name: string; track_count: number }[] }
const { query, uploaders } = Astro.props
const ALL_KEYS = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => [`${n}A`, `${n}B`])
---
<form class="filterbar" method="get" action="/" role="search" data-autosubmit>
  {query.sort !== DEFAULT_SORT && <input type="hidden" name="sort" value={query.sort} />}

  <label class="f-search">
    <span>Search</span>
    <input type="search" name="q" value={query.q} placeholder="artist, title or filename" />
  </label>

  <fieldset class="f-bpm">
    <legend>BPM</legend>
    <input type="number" name="bpm_min" min="0" max="1000" inputmode="numeric"
      aria-label="Minimum BPM" value={query.bpmMin ?? ''} />
    <span>–</span>
    <input type="number" name="bpm_max" min="0" max="1000" inputmode="numeric"
      aria-label="Maximum BPM" value={query.bpmMax ?? ''} />
    <label title="A 174 bpm drum & bass track is an 87 bpm track to a DJ. With this on, either query finds it.">
      <input type="checkbox" name="half_double" value="1" checked={query.halfDouble} />
      <span>half / double</span>
    </label>
  </fieldset>

  <fieldset class="f-key">
    <legend>Key</legend>
    <select name="key" aria-label="Camelot key">
      <option value="">any</option>
      {ALL_KEYS.map((k) => <option value={k} selected={query.key === k}>{k}</option>)}
    </select>
    <label title="Also matches one step either way around the wheel and the relative major or minor.">
      <input type="checkbox" name="harmonic" value="1" checked={query.harmonic} />
      <span>harmonic</span>
    </label>
  </fieldset>

  <label class="f-tier">
    <span>Min quality</span>
    <select name="tier_min">
      <option value="">any</option>
      {[1, 2, 3, 4, 5].map((t) => (
        <option value={t} selected={query.tierMin === t}>Tier {t}+</option>
      ))}
    </select>
  </label>

  <label class="f-uploader">
    <span>Uploader</span>
    <select name="uploader">
      <option value="">anyone</option>
      {uploaders.map((u) => (
        <option value={u.member_id} selected={query.uploader === u.member_id}>
          {u.uploader_name} ({u.track_count})
        </option>
      ))}
    </select>
  </label>

  <GenreFacet families={[]} />

  <button type="submit">Filter</button>
  <a class="f-reset" href="/">Clear</a>
</form>
```

- [ ] **Step 5: `TrackTable.astro`** — table + sortable headers + pager

```astro
---
// src/components/TrackTable.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE table. Pool, crate view (M6), "my uploads" — all of them are this
// template with different rows. Sort is column-header links that rewrite
// ?sort= (dropping any cursor — a keyset cursor is only valid within the
// sort that minted it). Pagination is ONE next link carrying the cursor;
// previous is the browser back button, and a keyset cursor cannot seek to
// page N anyway. TRIP-WIRE (M5 decision): if a view ever renders more than
// 1,000 rows at once, revisit.
import EmptyState from './EmptyState.astro'
import TrackRow from './TrackRow.astro'
import { isDefaultQuery, poolHref, type PoolQuery, type PoolSort, type PoolTrack } from '../lib/pool-api'

interface Props { tracks: PoolTrack[]; query: PoolQuery; nextCursor: string | null; poolEmpty: boolean }
const { tracks, query, nextCursor, poolEmpty } = Astro.props

const HEADERS: { label: string; sort: PoolSort | null; sr?: string }[] = [
  { label: '', sort: null, sr: 'Play' },
  { label: '', sort: null, sr: 'Artwork' },
  { label: 'Track', sort: 'artist_asc' },
  { label: 'BPM', sort: 'bpm_asc' },
  { label: 'Key', sort: 'key_asc' },
  { label: 'Length', sort: 'duration_asc' },
  { label: 'Quality', sort: 'tier_desc' },
  { label: 'Uploader', sort: null },
  { label: 'Added', sort: 'added_desc' },
  { label: '', sort: null, sr: 'Download' },
]

const emptyVariant = poolEmpty ? 'pool-empty' : query.q !== '' ? 'no-search-match' : 'no-filter-match'
---
<section class="tracktable">
  {tracks.length === 0 ? (
    <EmptyState variant={emptyVariant} term={query.q} />
  ) : (
    <table>
      <thead>
        <tr>
          {HEADERS.map((h) =>
            h.sort === null ? (
              <th scope="col">{h.sr ? <span class="sr-only">{h.sr}</span> : h.label}</th>
            ) : (
              <th scope="col">
                <a href={poolHref(query, { sort: h.sort })}
                   aria-current={query.sort === h.sort ? 'true' : undefined}>{h.label}</a>
              </th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {tracks.map((track) => <TrackRow track={track} />)}
      </tbody>
    </table>
  )}

  <p class="pager">
    <span class="counts">{tracks.length} track{tracks.length === 1 ? '' : 's'} on this page{isDefaultQuery(query) ? '' : ' (filtered)'}</span>
    {nextCursor !== null && (
      <> · <a rel="next" href={poolHref(query, { cursor: nextCursor })}>next ›</a></>
    )}
  </p>
</section>
```

- [ ] **Step 6: The pool page**

```astro
---
// src/pages/index.astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The pool is server-rendered. Zero islands. This page parses its own URL,
// calls pool_list() once, and renders everything — a filtered URL is the
// complete filter state and every view is shareable. View-source shows the
// rows; no client fetch renders anything.
import Shell from '../layouts/Shell.astro'
import FilterBar from '../components/FilterBar.astro'
import TrackTable from '../components/TrackTable.astro'
import { PAGE_SIZE, parsePoolQuery, poolListArgs, type PoolTrack } from '../lib/pool-api'

const query = parsePoolQuery(Astro.url.searchParams)
const rawCursor = Astro.url.searchParams.get('cursor')
const cursor = rawCursor !== null && rawCursor.length > 36 ? rawCursor : null

// Astro.locals.supabase — the request's cookie-bound client. Never a second one.
const { data, error } = await Astro.locals.supabase.rpc(
  'pool_list', poolListArgs(query, cursor, PAGE_SIZE))
if (error) console.error('pool_list failed:', error.message)
const tracks = (data ?? []) as PoolTrack[]
const nextCursor =
  tracks.length === PAGE_SIZE ? tracks[tracks.length - 1].row_cursor : null

const { data: uploaderRows, error: uploaderError } =
  await Astro.locals.supabase.rpc('pool_uploaders')
if (uploaderError) console.error('pool_uploaders failed:', uploaderError.message)
const uploaders = uploaderRows ?? []

// pool_uploaders() groups over stored files, so zero groups means the pool
// itself is empty — a different message from "your filters matched nothing".
const poolEmpty = uploaders.length === 0
---
<Shell title="localchune">
  <h1>Pool</h1>
  <FilterBar query={query} uploaders={uploaders} />
  <TrackTable tracks={tracks} query={query} nextCursor={nextCursor} poolEmpty={poolEmpty} />
</Shell>
```

- [ ] **Step 7: Verify**

```bash
npm run check && npm test && npm run build
```

Browser checks (repeated in Task 10's checklist):
1. View source on `/`: the full table content is in the HTML. The only scripts are the router bundle and the site script.
2. Submitting the filter form reloads with the filters in the URL; copying that URL into a fresh tab reproduces the view.
3. Clicking a column header sorts; the active header is bold with ▾; any `cursor` in the URL is dropped.
4. **next ›** appears only when a full page came back; clicking it appends `cursor=`; the browser back button is the previous page.
5. With JS disabled: search (via Filter button), BPM, key, tier, uploader filters, sort links and pagination all work identically.
6. Rows with no thumb show a bordered empty box, not a broken image.

- [ ] **Step 8: Commit**

```bash
git add src/lib/format.ts src/lib/preflight.ts src/components/*.astro src/pages/index.astro
git commit -m "feat(pool): server-rendered table, get-form filters, header sort, keyset pager"
```

---

### Task 8: Signed-GET routes — source, download, art

M5 plan Task 7's backend half stands; its player/waveform/store front-end is dead. Adds the art route the thumbs need.

**Files:**
- Create: `src/pages/api/track/[id]/source.ts`, `src/pages/api/track/[id]/download.ts`, `src/pages/api/track/[id]/art.ts`
- Modify: `src/lib/r2.ts`
- Test: `src/lib/r2.test.ts` (append)

**Do NOT create** (M5 planned them; the spec kills them): `peaks.ts` route, `src/lib/peaks.ts`, `src/lib/player-store.ts`, any player component.

**Interfaces:**
- Consumes: `pool_get` (Task 4), `objectUrl` + cached signer in `src/lib/r2.ts`.
- Produces: `presignGet()`, `readableObjectUrl()`, `GET_TTL_SECONDS`; `GET /api/track/:id/source` → `{url, kind, mime}`; `GET /api/track/:id/download` → 302; `GET /api/track/:id/art[?full=1]` → 302. Consumed by the site script (Task 6) and the row/detail templates (Tasks 7, 10).

- [ ] **Step 1: M5 Task 7 Step 1 verbatim** — `presignGet` / `readableObjectUrl` / `GET_TTL_SECONDS` in `src/lib/r2.ts`, `objectUrl` refactored onto the shared guard, r2.test.ts appended; `npx vitest run src/lib/r2.test.ts` → PASS including pre-existing cases.

- [ ] **Step 2: M5 Task 7 Step 2's `source.ts` and `download.ts` verbatim.** Skip its `peaks.ts`.

- [ ] **Step 3: The art route**

```ts
// src/pages/api/track/[id]/art.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { GET_TTL_SECONDS, presignGet, r2ErrorResponse } from '../../../../lib/r2'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'

/**
 * Album art, as a redirect the <img> tag can follow — a 302 keeps the
 * Worker out of the byte path, same rule as audio (PRD §12).
 *
 * Default is the 64px thumb and ONLY the thumb: rows must never load
 * full-size art, so a row whose file predates the thumb task gets a 404
 * (the template already rendered an empty box instead of an <img> when
 * has_thumb was false — this is defence, not the primary path).
 * `?full=1` is the detail page: full art, falling back to the thumb.
 *
 * The R2 response carries an immutable year-long cache-control (art for a
 * given file_id never changes). The 302 itself is cacheable for HALF the
 * signature TTL, so a cached redirect can never hand out a URL that is
 * about to expire.
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  let track: Record<string, string | null> | undefined
  try {
    const { data, error } = await locals.supabase.rpc('pool_get', { p_file_id: id })
    if (error) return rpcError(error)
    track = data?.[0]
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
  if (!track) return jsonError(404, 'not_found', 'no such track')

  const full = url.searchParams.get('full') === '1'
  const name = full ? (track.artwork_key ?? track.thumb_key) : track.thumb_key
  if (!name) return jsonError(404, 'no_art', 'no artwork for this track')

  try {
    const signed = await presignGet(`derived/${id}/${name}`, {
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
    })
    return new Response(null, {
      status: 302,
      headers: {
        location: signed,
        'cache-control': `private, max-age=${Math.floor(GET_TTL_SECONDS / 2)}`,
      },
    })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
```

- [ ] **Step 4: Verify**

```bash
npm run check && npm test && npm run build
```

Then by hand against `npm run dev` (needs at least one row in `audio_analysis` — insert a fixture pointing at a real uploaded object, or defer the click-through to Task 10's checklist):

```bash
curl -sI 'http://localhost:4321/api/track/<id>/download' -b cookies.txt
```
Expected: `302` with `location:` on `r2.cloudflarestorage.com`. `/api/track/<id>/art` on a row with no art: JSON 404 `{"error":"no_art",…}`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/r2.ts src/lib/r2.test.ts src/pages/api/track
git commit -m "feat(pool): signed-get source/download/art routes — worker never proxies bytes"
```

---

### Task 9: The 64px thumb (analysis worker)

Spec §4: emit `thumb.jpg` (64px, JPEG quality ~70) next to `artwork.jpg` in `derived/<file_id>/`, so rows never load full-size art. Files analysed before this lands have no thumb — the UI already falls back to the empty box.

**Files:**
- Modify: `worker/app/tags.py` (add `make_thumb`), `worker/app/main.py` (call it), `worker/app/models.py` (add `thumb_key`), `workers/analysis/src/index.ts` (drain + type)
- Test: `worker/tests/test_tags.py` (append)

**Interfaces:**
- Consumes: `tags.extract_artwork` (exists, `worker/app/tags.py:41`), ffmpeg (already in the container image).
- Produces: `tags.make_thumb(src: str, out: str, size: int = 64) -> bool`; `AnalyzeResponse.thumb_key: Optional[str]`; the DO uploads `derived/<file_id>/thumb.jpg`. M3 Task 9's `persist()` must write `thumb_key` (recorded there; the column exists from Task 3).

- [ ] **Step 1: Write the failing test** — append to `worker/tests/test_tags.py`, and widen its line-7 import to `from app.tags import parse_tags, read_tags, extract_artwork, make_thumb`. It reuses the file's existing real-ffmpeg fixture helpers `_cover_png` and `_tagged_mp3_with_art` — do not add a second fixture:

```python
def test_make_thumb_produces_a_small_square_jpeg(tmp_path):
    mp3 = str(tmp_path / 'tagged.mp3')
    cover = str(tmp_path / 'cover.png')
    art = str(tmp_path / 'artwork.jpg')
    thumb = str(tmp_path / 'thumb.jpg')
    _cover_png(cover)
    _tagged_mp3_with_art(mp3, cover)

    assert extract_artwork(mp3, art) is True
    assert make_thumb(art, thumb) is True
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', thumb],
        capture_output=True, text=True, check=True).stdout.strip()
    w, h = (int(x) for x in out.split(','))
    assert (w, h) == (64, 64)
    assert 0 < os.path.getsize(thumb) < 20_000   # a 64px q~70 jpeg is a few KB

def test_make_thumb_returns_false_for_a_missing_source(tmp_path):
    assert make_thumb(str(tmp_path / 'absent.jpg'), str(tmp_path / 'out.jpg')) is False
```

Run (from `worker/`): `python -m pytest tests/test_tags.py -q` → FAILS at import time (`make_thumb` does not exist yet).

- [ ] **Step 2: Implement `make_thumb`** — append to `worker/app/tags.py`:

```python
def make_thumb(src: str, out: str, size: int = 64) -> bool:
    """Downscale extracted cover art to a `size`-square JPEG (~q70).

    Cover-crop rather than letterbox: scale the short edge to `size`, crop
    the centre. Returns False instead of raising when `src` is missing or
    unreadable -- a track with undecodable art is a track with no thumb,
    not a failed analysis. ffmpeg's -q:v 7 lands near libjpeg quality 70.
    """
    result = subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-i', src,
         '-vf', f'scale={size}:{size}:force_original_aspect_ratio=increase,'
                f'crop={size}:{size}',
         '-frames:v', '1', '-q:v', '7', out],
        capture_output=True)
    return result.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0
```

- [ ] **Step 3: Run the tests** — `python -m pytest tests/test_tags.py -q` → PASS.

- [ ] **Step 4: Wire it through the pipeline**

`worker/app/models.py` — in `AnalyzeResponse`, after `artwork_key: Optional[str] = None` add:

```python
    thumb_key: Optional[str] = None
```

`worker/app/main.py` — in `_analyze_sync`, replace the artwork block (currently lines ~245–247) with:

```python
        artwork_key = None
        thumb_key = None
        if tags.extract_artwork(src, os.path.join(d, "artwork.jpg")):
            artwork_key = "artwork.jpg"
            # 64px cover-cropped JPEG so the pool table never loads
            # full-size art. Spec: 2026-07-29-ui-brutalist-design.md §4.
            if tags.make_thumb(os.path.join(d, "artwork.jpg"),
                               os.path.join(d, "thumb.jpg")):
                thumb_key = "thumb.jpg"
```

and add `thumb_key=thumb_key,` to the `AnalyzeResponse(...)` construction next to `artwork_key=artwork_key,`.

`workers/analysis/src/index.ts` — add `thumb_key: string | null` to the response interface next to `artwork_key` (line ~111), and add `out.thumb_key,` to the artifact-drain list next to `out.artwork_key,` (line ~247).

- [ ] **Step 5: Full worker test suite + typecheck**

```bash
cd worker && python -m pytest -q
cd .. && npm run check
```
Expected: all Python tests green (the contract test may assert the response schema — update its expected field list if it does); no TS errors.

- [ ] **Step 6: Commit**

```bash
git add worker/app/tags.py worker/app/main.py worker/app/models.py \
        worker/tests/test_tags.py workers/analysis/src/index.ts
git commit -m "feat(worker): 64px thumb.jpg beside artwork.jpg — rows never load full art"
```

---

### Task 10: Track detail, upload ticker, manual checklist

**Execute M5 plan Task 8 (Steps 1–9) with the replacements below.** Steps 1–4 (migration 12 + pgTAP, `upload-batch.ts`, `/api/upload/status`, `AnalysisFailedRow`, `FileStateTicker`, upload.astro mounts) are verbatim — the ticker islands survive by design. Step 5's detail page is replaced wholesale:

- [ ] **Steps 1–4: verbatim from M5 Task 8** (4 pgTAP tests pass; ticker polls; both islands mounted on upload.astro).

- [ ] **Step 5: The track detail page** (replaces M5's)

```astro
---
// src/pages/track/[id].astro
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
import Shell from '../../layouts/Shell.astro'
import KeyChip from '../../components/KeyChip.astro'
import QualityBadge from '../../components/QualityBadge.astro'
import { formatBytes, formatDuration } from '../../lib/format'
import { formatBpm } from '../../lib/track-format'
import { isUuid } from '../../lib/upload-api'

const { id } = Astro.params
// Guard before the RPC: a non-uuid path segment would otherwise reach
// Postgres and come back as 22P02 — a 500-shaped answer to a 404 question.
if (!isUuid(id)) return new Response('Not found', { status: 404 })

const { data, error } = await Astro.locals.supabase.rpc('pool_get', { p_file_id: id })
if (error) console.error('pool_get failed:', error.message)
const t = data?.[0]
// pool_get applies the visibility rule, so "not yours to see" and "does
// not exist" are the same answer — which is the point.
if (!t) return new Response('Not found', { status: 404 })

const artist = t.display_artist ?? 'Unknown artist'
const title = `${artist} — ${t.display_title}`
const hasArt = t.artwork_key !== null || t.thumb_key !== null
const num = (v: number | null, digits = 1, unit = '') =>
  v === null || v === undefined ? '—' : `${v.toFixed(digits)}${unit}`
---
<Shell title={`localchune — ${title}`}>
  <article class="trackdetail">
    <header>
      <h1>{title}</h1>
      {/* The larger copy. Colour, unfiltered — content is not chrome.
          M7 note: if this art is ever Apple-sourced, the "Listen on
          Apple Music" badge is required HERE (PRD §8.1) — this page,
          never the table. */}
      {hasArt && (
        <img class="art" src={`/api/track/${t.file_id}/art?full=1`} alt={`Cover art for ${t.display_title}`} />
      )}
      <p class="transport">
        <a
          class="play"
          href={`/track/${t.file_id}`}
          data-track-id={t.file_id}
          data-label={title}
        >▶ Play</a>
        {' '}
        <a href={`/api/track/${t.file_id}/download`}>↓ Download</a>
      </p>
    </header>

    <section class="identity">
      <h2>Identity</h2>
      <dl>
        <dt>Artist</dt><dd>{artist}</dd>
        <dt>Title</dt><dd>{t.display_title}</dd>
        <dt>Filename</dt><dd>{t.original_filename}</dd>
      </dl>
      {/* M7 slot: canonical artist/title/album/label from the catalogue
          match. Nothing until then — no placeholder, no empty box. */}
    </section>

    <section class="analysis">
      <h2>Analysis</h2>
      <dl>
        <dt>BPM</dt>
        <dd class="num" title={t.bpm === null || t.bpm <= 0 ? 'no beat detected' : `${t.beat_count} beats on the grid`}>
          {formatBpm(t.bpm, t.ibi_std_ms)}
        </dd>
        <dt>Key</dt>
        <dd><KeyChip camelot={t.key_camelot} open={t.key_open} musical={t.key_musical} /></dd>
        <dt title="What each key-detection profile answered. Disagreement between them is the honest signal that the key is ambiguous.">
          Other key profiles
        </dt>
        <dd>{t.key_alt_profiles
              ? Object.entries(t.key_alt_profiles).map(([p, k]) => `${p}: ${k}`).join(' · ')
              : '—'}</dd>
        <dt>Length</dt><dd class="num">{formatDuration(t.duration_ms)}</dd>
        <dt>Integrated loudness</dt><dd class="num">{num(t.integrated_lufs, 1, ' LUFS')}</dd>
        <dt>Loudness range</dt><dd class="num">{num(t.lra_lu, 1, ' LU')}</dd>
        <dt>True peak</dt><dd class="num">{num(t.true_peak_dbtp, 1, ' dBTP')}</dd>
        <dt>ReplayGain</dt><dd class="num">{num(t.replaygain_db, 1, ' dB')}</dd>
      </dl>
    </section>

    <section class="forensics">
      <h2>Source quality</h2>
      <p><QualityBadge tier={t.quality_tier} lossyAncestor={t.lossy_ancestor} measCutoffHz={t.meas_cutoff_hz} /></p>
      <dl>
        <dt>Container</dt><dd>{t.container ?? '—'}</dd>
        <dt>Size</dt><dd class="num">{formatBytes(t.byte_size)}</dd>
        <dt>Measured cutoff</dt>
        <dd class="num">{t.meas_cutoff_hz ? `${(t.meas_cutoff_hz / 1000).toFixed(1)} kHz` : '—'}</dd>
        <dt title="A suspicion proxy, not a verdict. Loud modern masters clip on purpose.">
          Clipped samples
        </dt>
        <dd class="num">{num(t.clipped_pct, 2, ' %')}</dd>
      </dl>
    </section>

    <section class="provenance">
      <h2>Provenance</h2>
      <dl>
        <dt>Uploaded by</dt><dd>{t.uploader_name}</dd>
        <dt>Batch</dt><dd>{t.batch_label ?? t.batch_id}</dd>
        <dt>Added</dt><dd class="num">{new Date(t.created_at).toISOString().slice(0, 10)}</dd>
        <dt>Analysed</dt>
        <dd class="num">{t.analyzed_at ? `${new Date(t.analyzed_at).toISOString().slice(0, 16).replace('T', ' ')} (${t.analysis_version})` : '—'}</dd>
        <dt>Also contributed by</dt>
        <dd>{(t.claim_names ?? []).join(', ') || '—'}</dd>
      </dl>
      {/* M4 slot: the duplicate-review verdict and the merge/undo history. */}
    </section>
  </article>
</Shell>
```

- [ ] **Step 6: Run everything**

```bash
npm run check && npm test && npx supabase test db && npm run build
```

- [ ] **Step 7: The manual checklist** — M5 Task 8 Step 7's list, **minus** items 8 (infinite scroll — cut), 14/15/17 (waveform — cut), 12 in its old form, **plus** the spec's additions. Work through it in a browser against `npm run dev` with seeded data, then repeat the marked items on the deployed build.

**Pool (server-rendered)**
1. `/` renders the rows **in the HTML** — view source, before JavaScript.
2. The only scripts on `/` are the ClientRouter bundle and the site script (player + search debounce).
3. Typing in search fires one GET navigation ~300 ms after the last keystroke; the Filter button does the same without JS.
4. BPM 86–86 + half/double reveals a 174 track; unticking hides it.
5. Key 12B + harmonic returns 1B tracks (the wraparound).
6. A copied filtered URL reproduces the view in a fresh tab, server-side.
7. Sort headers rewrite `?sort=`; **next ›** carries `?cursor=`; back button returns to the previous page.
8. Empty pool → "nothing here yet" + `/upload` link; no filter match → filter message; no search match names the term.
9. `bpm = 0` renders `—` + "no beat detected", styled like every other row.
10. `lossy_ancestor = 'abstain'` reads neutral, never accusatory.
11. Rows without thumbs show the bordered empty box; rows with thumbs show 28px colour art.

**Player (persistent, native)**
12. Clicking ▶ fetches `/api/track/*/source` then streams straight from `*.r2.cloudflarestorage.com` — no audio bytes through the Worker (Network panel).
13. There is exactly one `<audio>` element in the DOM, in the player bar, whatever the row count.
14. **Playback continues, uninterrupted, across: a filter submit, a sort click, a pagination click, and a navigation to a track detail page and back.** (The spec's headline property.)
15. Seeking uses the native control and works near the end of a long track after minutes of playback (`GET_TTL_SECONDS`).
16. A second ▶ swaps the source in the same element; the label updates.
17. With JS disabled, ▶ navigates to the track page — nothing errors.

**Download**
18. Download returns the original file with the original filename, accents intact. *(repeat deployed)*
19. `curl -sI .../download -b cookies.txt` → 302 to R2. *(repeat deployed)*

**Upload page** — M5 items 20–23 unchanged (ticker states, polling stops, backgrounding pauses, failure reasons).

**Shell, licence, brutalism**
24. Nav, storage chip, footer source link on every page; player bar on every page.
25. Footer link resolves to the deployed commit. *(repeat deployed)*
26. `/api/build-info` answers signed out. *(repeat deployed)*
27. No `@font-face`; no `font-family` outside `monospace`; zero font bytes in the Network panel.
28. Lighthouse on `/`: no render-blocking request beyond the one stylesheet.
29. Emulated dark mode inverts every surface — table stripes, chips, player bar, empty boxes — with no component-level overrides.

**Sessions and failure**
30. Signed out mid-session, clicking ▶ writes "Session ended — reload to sign in." into the player label; filters (being plain GETs) bounce to `/login` — no HTML rendered into a table.

- [ ] **Step 8: Deploy and re-check** — M5 Task 8 Step 8 verbatim (`npx supabase db push`, `npm run deploy`, re-check the deployed items; R2 CORS note applies to streaming).

- [ ] **Step 9: Commit and open the PR**

```bash
git add supabase/migrations/20260728120200_12_upload_status.sql supabase/tests/upload_status.sql \
        src/lib/upload-batch.ts src/pages/api/upload/status.ts \
        src/components/FileStateTicker.tsx src/components/AnalysisFailedRow.tsx \
        src/components/UploadDropzone.tsx src/pages/track src/pages/upload.astro
git commit -m "feat(pool): track detail page, upload state ticker, failure rows"
git push -u origin rohan/brutalist-ui-design-091da9
gh pr create --title "Brutalist pool UI — zero-island pool, persisted native player, thumbs" --fill
gh pr list --state open
```

---

## Done when

The M5 plan's "Done when" list stands, **minus** its waveform/infinite-scroll items, **plus** (spec §6):

- View-source on `/` shows the full table content — no client fetch renders rows.
- The only `<script>` on the pool page is the router + player + search debounce.
- No `@font-face`, no `font-family` beyond `monospace`, anywhere.
- No render-blocking request on `/` beyond the one stylesheet.
- Dark mode inverts every surface via the token swap alone.
- Playback survives filter submits, sort clicks, pagination and detail navigation.
- With JS disabled: filters, sort, pagination and download all work.
- Pool rows show 28px thumbs (or bordered empty boxes); the worker emits `thumb.jpg`; rows never fetch `artwork.jpg`.

## Deferred, on purpose

M5's deferral table stands, with these spec-driven changes: cross-page player persistence is **v1** (done above, not deferred); `WaveformScrubber` is cut from v1 (peaks JSON still produced, so it can land later without pipeline work); localStorage resume-position and listen counts stay cut.

## Unresolved questions

1. ~~Dark mode: spec §1 says "v1 ships light only" but §6's done-list requires the inversion to work. Plan ships the 8-line `prefers-color-scheme` token swap (it *is* "the token swap and nothing else"). Rip it out if you want literal light-only.~~
   **Resolved (owner decision, 2026-07-29):** ripped out. Light-only for v1;
   see spec §1 point 2.
2. Art thumbs in colour (spec current) — confirm, or CSS-grayscale?
3. `thumb.jpg` 64px JPEG q~70 — confirm before Task 9 lands.
4. M3 Task 9 (queue consumer + `persist()`): lands separately on the m3 branch. Its `persist()` must write `preview_key`/`peaks_key`/`artwork_key`/`thumb_key` — recorded here and in migration 10's comments.
