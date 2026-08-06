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
//
//    `data-label` on the play link is dead weight too — site.ts derives the
//    same string from artist and title in `entryLabel()` and never reads
//    the attribute — but it is named in survive-list #7 and removing it
//    belongs in the commit that updates the selector-contract test, not
//    this one. It is worth another ~116 B per row when that lands.
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
import { describe, expect, it } from 'vitest'
import FeedRow from './FeedRow.astro'
import TrackRow from './TrackRow.astro'
import type { PoolTrack } from '../lib/pool-api'

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

async function render(Component: unknown, props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create()
  return container.renderToString(Component as Renderable, { props })
}

describe('TrackRow — the per-row budget', () => {
  it('stays at or under 2,753 bytes with realistic strings (was 2,957)', async () => {
    const html = await render(TrackRow, { track })
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(2_753)
  })

  it('stays at or under 37 elements — the 15-column floor plus its cells', async () => {
    const html = await render(TrackRow, { track })
    expect(elementCount(html)).toBeLessThanOrEqual(37)
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
      'data-track-id=', 'data-label=', 'data-artist=', 'data-title=',
      'data-duration=', 'data-bpm=', 'data-key=',
    ]) {
      expect(play).toContain(attr)
    }
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
  it('stays at or under 1,301 bytes (was 1,505)', async () => {
    const html = await render(FeedRow, { track })
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(1_301)
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
