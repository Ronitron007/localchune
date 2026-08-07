// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// A PER-ROW BUDGET, MEASURED ON RENDERED MARKUP.
//
// The pool page is one tbody of PAGE_SIZE = 100 of these, so anything a row
// carries is paid for a hundred times. The 2026-08-06 audit measured the row
// at ~2.3 KB / 32 elements against short strings; against the realistic
// strings below (a 40-character artist, a 58-character title, three tags) it
// was **2,957 bytes and 37 elements**, i.e. ~296 KB of tbody per page.
//
// WHAT THIS FILE PINS, and what it deliberately does not:
//
//  - It pins BYTES. The audit's "artist and title are serialised up to 8×
//    per row" was the recoverable part, and `button.queueadd` carrying its
//    own copy of artist/title/duration/bpm/key was five of those eight.
//    site.ts now reads the row's own `a.play` instead, so the button needs
//    only `data-file-id`. The "file id and nothing else to say" case below
//    is the real contract assertion — the byte number is downstream of it.
//    Measured: 2,957 → 2,753 B per row, 1,505 → 1,301 B per feed row.
//    Then 2,797 / 1,345 when the retina `srcset` landed. Then re-baselined
//    to a NORMALISED number — see `normalize` below — because the art URLs
//    made the count depend on a deployment setting rather than on the row.
//    That held 2,742 and 1,290 until the icon sweep, which took them to
//    4,155 and 2,174 — and which is why there is a GZIPPED budget below
//    as well. Raw bytes are the wrong axis for markup repeated a hundred
//    times identically; see that block for the measured proof.
//
//    `data-label` WAS dead weight — site.ts derives the same string from
//    artist and title in `entryLabel()` and never read the attribute. It is
//    gone, in the commit that reworked the row-tap contract, and two
//    surfaces that carried it INSTEAD of artist/title (track/[id] and
//    /review's ComparePanel) were queueing entries with a blank title as a
//    result. Both now carry the attributes site.ts actually reads.
//
//  - It does NOT pin ≤10 elements per row, and the reason is arithmetic
//    rather than effort. The owner's decision Q3 keeps the 15-column table
//    above 640px, and the mobile card layout is CSS over that same DOM (one
//    template, one set of selectors, no chance of the two drifting). Fifteen
//    `<td>` are therefore a floor: 10 elements/row is only reachable by
//    rendering a second template, which is the thing the design rules out.
//    The element ceiling here is the achieved number, so the row cannot grow
//    quietly; it is not the plan's ≤10.
//
// The rendering is `experimental_AstroContainer`, which is why
// vitest.config.ts runs on `getViteConfig` — a budget checked against
// template source would count the template, not the page.
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import FeedRow from './FeedRow.astro'
import TrackRow from './TrackRow.astro'
import type { PoolTrack } from '../lib/pool-api'
import { artThumb2xUrl, artThumbUrl } from '../lib/track-format'

/** Deliberately near the worst realistic case: long artist, long title,
 *  three tags, a liked row (the ♥ branch renders the longer aria-label). */
const track: PoolTrack = {
  file_id: '11111111-2222-4333-8444-555555555555',
  display_artist: 'Anonymous Recordings Collective Berlin XY',
  display_title: 'A Very Long Title For Measuring Real Rows In The Pool Table',
  bpm: 128.4,
  ibi_std_ms: 2.1,
  key_camelot: '8A',
  key_open: '1m',
  key_musical: 'Am',
  duration_ms: 384_000,
  quality_tier: 'lossless',
  lossy_ancestor: false,
  meas_cutoff_hz: null,
  uploader_name: 'someuploader',
  created_at: '2026-01-01T00:00:00Z',
  download_count: 12,
  like_count: 34,
  liked_by_me: true,
  play_count: 56,
  has_thumb: true,
  tags: ['techno', 'peak-time', 'vinyl-rip'],
  row_cursor: 'c',
} as unknown as PoolTrack

/** Opening tags only — closing tags are not elements. */
const elementCount = (html: string): number =>
  (html.match(/<[a-zA-Z][^>]*>/g) ?? []).length

type Renderable = Parameters<AstroContainer['renderToString']>[0]

/**
 * THE ART URLs ARE NOT PART OF THE BUDGET, and leaving them in made this
 * file fail twice for reasons that had nothing to do with the row.
 *
 * `artThumbUrl` returns `${PUBLIC_ART_BASE_URL}/derived/<id>/thumb.jpg`
 * when that variable is set, and the signed `/api/track/<id>/art?full=1`
 * fallback when it is not — a 62-character swing on this file id, doubled
 * once `srcset` named the 2x key as well. So the measured byte count moved
 * with a DEPLOYMENT SETTING, in both directions:
 *
 *   - a developer whose `.env` names a longer art host (a local Supabase
 *     storage path is 84 bytes longer than the fallback) got a red budget
 *     and no defect;
 *   - CI, which sets no `PUBLIC_ART_BASE_URL` at all, got a red
 *     `thumb.jpg` assertion against the fallback route and no defect.
 *
 * Both are the same mistake: measuring a deployment setting inside a
 * per-row budget. The budget is about what the ROW serialises; how long a
 * CDN hostname is is neither the row's fault nor the row's to fix.
 *
 * Normalising `src` AND `srcset` to one byte each makes the number depend
 * on the template alone, in every checkout and in CI. It costs no
 * strictness: the attributes are still counted, and the assertion below
 * compares the UNnormalised markup against the URL BUILDERS' own output,
 * which is true whichever state the variable is in. The URLs themselves
 * are asserted in both states in track-format.test.ts, where the base is
 * an argument rather than an ambient.
 */
const normalize = (html: string): string =>
  html.replace(/src="[^"]*"/g, 'src="#"').replace(/srcset="[^"]*"/g, 'srcset="#"')

async function renderRaw(Component: unknown, props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create()
  return container.renderToString(Component as Renderable, { props })
}

async function render(Component: unknown, props: Record<string, unknown>): Promise<string> {
  return normalize(await renderRaw(Component, props))
}

/**
 * THE GZIPPED BUDGET, AND WHY IT WAS ADDED.
 *
 * The raw per-row count below is a real number that answers the wrong
 * question. A pool page is a hundred rows, and those hundred rows are a
 * hundred BYTE-IDENTICAL copies of everything that is not a title — so
 * DEFLATE emits the second through the hundredth as back-references and
 * the marginal cost of repeated markup is nearly nothing.
 *
 * That mattered the moment the icon sweep landed. Judged on raw bytes the
 * sweep looked catastrophic — a hundred rows of the fixture below went
 * 274 KB -> 416 KB, and the note in TrackRow.astro had refused the kebab
 * SVG on exactly that arithmetic. Gzipped, the same hundred rows went
 * 2,585 B -> 3,968 B: +1.4 KB, ONE PERCENT of the raw delta. The old note
 * predicted 30 KB and was out by a factor of twenty.
 *
 * So both are asserted. The raw number still catches a row that grew a
 * per-track string (a second copy of the title, a duplicated data-*),
 * because those DO NOT compress away — that is the regression perf task
 * 2.2 fixed and it must stay fixed. The gzipped number is what a member
 * actually downloads, and it is the one to weigh a design decision
 * against.
 */
const GZIP_ROWS = 100
const gzippedPage = (rowHtml: string): number =>
  gzipSync(Buffer.from(rowHtml.repeat(GZIP_ROWS))).length

describe('TrackRow — the per-row budget', () => {
  it('stays at or under 4,155 bytes with realistic strings (was 2,742)', async () => {
    // Re-baselined by the icon sweep: five controls that were text
    // characters (+Q, ⋮, ♥, ↓, +) are inline SVG from icons.ts now,
    // because iOS emoji-renders several of them and a font is not
    // something this app gets a vote in. The number that decided it is
    // the gzipped one below, not this one.
    const html = await render(TrackRow, { track })
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(4_155)
  })

  it('costs at most 4.0 KB gzipped across a hundred-row page', async () => {
    const html = await render(TrackRow, { track })
    expect(gzippedPage(html)).toBeLessThanOrEqual(4_000)
  })

  it('compresses like repeated markup — the icons are nearly free at scale', async () => {
    /* THE ASSERTION THAT RETIRES THE OLD OBJECTION, stated as a ratio so
       it cannot rot into a magic number. If a future change makes a row
       carry per-track strings instead of shared markup, this ratio
       collapses and the test says so — which is a stronger guard than
       either absolute number, and the one that would have caught the
       duplicated data-* attributes perf task 2.2 removed. */
    const html = await render(TrackRow, { track })
    const raw = Buffer.byteLength(html) * GZIP_ROWS
    expect(gzippedPage(html) / raw).toBeLessThan(0.02)
  })

  /* SURVIVE-LIST #15, AND THE TWO DERIVATIVE KEYS.
     One srcset candidate, not two: `src` is the 1x, so naming it again in
     the srcset would pay for a URL the browser already has. If the 2x
     object is missing the browser abandons the element rather than falling
     back, which is what `artFallback` exists to repair.

     ASSERTED THROUGH THE BUILDERS, NEVER AGAINST A LITERAL, and that is
     what makes this file env-deterministic. `artThumbUrl` returns the
     bucket URL when PUBLIC_ART_BASE_URL is set and the signed route when
     it is not, so a test containing the string `thumb.jpg` passes on a
     laptop with a .env and fails in CI without one — which is exactly the
     red this file shipped once. Comparing against the builder's own output
     asserts the WIRING (this component builds its URLs the one supported
     way) and is true in both states. The URLs THEMSELVES are asserted in
     both states in track-format.test.ts, where the base is an argument
     rather than an ambient. */
  it('offers the 2x thumb as the only srcset candidate, and adds no element', async () => {
    const html = await renderRaw(TrackRow, { track })
    const img = /<img[^>]*class="thumb"[^>]*>/.exec(html)?.[0] ?? ''
    const b = import.meta.env.PUBLIC_ART_BASE_URL
    expect(img, 'the row renders a thumb <img>').not.toBe('')
    expect(img).toContain(`src="${artThumbUrl(b, track.file_id)}"`)
    expect(img).toContain(`srcset="${artThumb2xUrl(b, track.file_id)} 2x"`)
    // 44, not 28: the artwork IS the play control now, so it has to be a
    // real tap target rather than a decoration beside one.
    expect(img).toContain('width="44"')
    expect(img).toContain('height="44"')
    expect(img).toContain('loading="lazy"')
  })

  it('stays at or under 50 elements — the 15-column floor plus its cells', async () => {
    // 38 -> 50: twelve of the additions are the <svg> and <path>/<rect>
    // nodes of the five icons that replaced text characters. An element
    // budget counts DOM nodes, which is the right axis for layout and
    // parse cost and the wrong one for transfer — see the gzipped budget.
    const html = await render(TrackRow, { track })
    expect(elementCount(html)).toBeLessThanOrEqual(50)
  })

  it('gives `button.queueadd` a file id and nothing else to say', async () => {
    const html = await render(TrackRow, { track })
    const button = /<button[^>]*class="queueadd[^>]*>/.exec(html)?.[0] ?? ''
    expect(button).toContain('data-file-id=')
    for (const dead of ['data-artist=', 'data-title=', 'data-duration=', 'data-bpm=', 'data-key=']) {
      expect(button).not.toContain(dead)
    }
  })

  it('keeps every attribute site.ts scrapes on the play link', async () => {
    const html = await render(TrackRow, { track })
    const play = /<a[^>]*class="play"[^>]*>/.exec(html)?.[0] ?? ''
    for (const attr of [
      'data-track-id=', 'data-artist=', 'data-title=',
      'data-duration=', 'data-bpm=', 'data-key=',
    ]) {
      expect(play).toContain(attr)
    }
  })

  it('no longer carries data-label, which nothing ever read', async () => {
    // scrapeOne reads dataset.artist and dataset.title; entryLabel()
    // rebuilds "Artist — Title" from the two. dataset.label has never
    // been read anywhere in site.ts. It was ~110 B on every one of a
    // hundred rows. Removed together with the two surfaces that carried
    // it INSTEAD of artist/title and therefore queued a blank name —
    // track/[id] and /review's ComparePanel.
    const html = await render(TrackRow, { track })
    expect(html).not.toContain('data-label=')
  })

  it('keeps the like form, its glyph and its count', async () => {
    const html = await render(TrackRow, { track })
    expect(html).toContain('class="likeform"')
    expect(html).toContain('data-astro-reload')
    expect(html).toContain('class="likebtn"')
    expect(html).toContain('class="likeglyph"')
    expect(html).toContain('class="likecount"')
  })

  it('keeps the crate picker\'s disclosure and its menu', async () => {
    const html = await render(TrackRow, { track })
    expect(html).toContain('class="cratepick"')
    expect(html).toContain('class="cratepick-menu"')
  })
})

describe('FeedRow — the same contract, the same dedup', () => {
  it('stays at or under 2,174 bytes (was 1,290)', async () => {
    const html = await render(FeedRow, { track })
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(2_174)
  })

  it('costs at most 2.2 KB gzipped across a hundred-row feed', async () => {
    const html = await render(FeedRow, { track })
    expect(gzippedPage(html)).toBeLessThanOrEqual(2_200)
  })

  it('gives `button.queueadd` a file id and nothing else to say', async () => {
    const html = await render(FeedRow, { track })
    const button = /<button[^>]*class="queueadd[^>]*>/.exec(html)?.[0] ?? ''
    expect(button).toContain('data-file-id=')
    for (const dead of ['data-artist=', 'data-title=', 'data-duration=', 'data-bpm=', 'data-key=']) {
      expect(button).not.toContain(dead)
    }
  })

  it('keeps its own play link whole — the feed builds a queue too', async () => {
    const html = await render(FeedRow, { track })
    const play = /<a[^>]*class="play"[^>]*>/.exec(html)?.[0] ?? ''
    for (const attr of ['data-track-id=', 'data-artist=', 'data-title=', 'data-duration=']) {
      expect(play).toContain(attr)
    }
  })
})

describe('the pool table has an overflow container — offender #1', () => {
  const css = readFileSync(new URL('../styles/global.css', import.meta.url).pathname, 'utf8')

  // The audit's worst single finding: 15 cells × 32px of cell padding against
  // a 375px viewport, and `.tracktable` had NO rule at all — so the PAGE
  // scrolled sideways rather than the table.
  it('scrolls the table, never the page', () => {
    expect(/\.tracktable\s*\{[^}]*overflow-x:\s*auto/.test(css)).toBe(true)
  })
})
