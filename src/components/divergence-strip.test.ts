// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// PERF TASK 2.4 — the heaviest page in the app, and it is the owner's.
//
// /review rendered one `<span class="bar">` per second of overlap, each
// carrying an inline `style` and a `title`, ~81 bytes apiece. At the old
// REVIEW_PAGE_SIZE of 50 pairs that was up to 18,000 spans and ~1.42 MB of
// strip markup in one document. Phones stuttered or dropped the tab.
//
// Measured here, on a 360-second strip with a peak:
//
//   elements   362  ->  3      (div + svg + path, plus one for the peak)
//   bytes   30,341  ->  2,878
//
// THE ROUND TRIP IS THE POINT OF THIS FILE. An SVG path is a string, and a
// string is easy to get subtly wrong in a way that still renders something
// plausible — an off-by-one in the x walk, or a y axis pointing the wrong
// way, draws a strip that looks like a strip and lies about where two
// recordings diverge. PRD §6 says the whole reason the strip exists is to
// show WHERE. So the test decodes `d` back into heights and compares it to
// what barHeightPct would have produced for the same input, which is the
// same function the spans used.
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'
import DivergenceStrip from './DivergenceStrip.astro'
import { barHeightPct, peakBarPath, stripPath } from '../lib/review-api'

type Renderable = Parameters<AstroContainer['renderToString']>[0]

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create()
  return container.renderToString(DivergenceStrip as Renderable, { props })
}

const elementCount = (html: string): number => (html.match(/<[a-zA-Z][^>]*>/g) ?? []).length

/** A realistic six-minute overlap: mostly agreeing, with a divergent intro. */
const ber = Array.from({ length: 360 }, (_, s) => (s < 30 ? 0.18 + (s % 7) / 100 : 0.004))

/** The inverse of stripPath. Each `V<y>H<x>` pair is one second's top edge;
 *  the trailing `V100Z` has no `H` after it and is skipped by construction. */
const decode = (d: string): number[] =>
  [...d.matchAll(/V(\d+)H(\d+)/g)].map((m) => 100 - Number(m[1]))

describe('stripPath — the geometry survives the change of element', () => {
  it('decodes back to exactly the heights barHeightPct gives', () => {
    expect(decode(stripPath(ber))).toEqual(ber.map((v) => barHeightPct(v)))
  })

  it('walks x one unit per second and closes on the baseline', () => {
    const d = stripPath([0.5, 0, 0.25])
    expect(d).toBe('M0 100V0H1V98H2V50H3V100Z')
  })

  it('gives a null second the same floor a null span got', () => {
    expect(decode(stripPath([null, 0.5]))).toEqual([barHeightPct(null), 100])
  })

  it('draws nothing for an empty array — the caller renders a sentence', () => {
    expect(stripPath([])).toBe('')
  })

  it('marks the peak as its own closed bar at the same height', () => {
    expect(peakBarPath([0.1, 0.5, 0.1], 1)).toBe('M1 100V0H2V100Z')
  })

  it('draws no peak for an index outside the array', () => {
    expect(peakBarPath([0.1], -1)).toBe('')
    expect(peakBarPath([0.1], 1)).toBe('')
    expect(peakBarPath([], 0)).toBe('')
  })
})

describe('DivergenceStrip — the element budget', () => {
  it('renders three elements for a 360-second strip (was 362)', async () => {
    const html = await render({ ber, peakAt: 12 })
    expect(elementCount(html)).toBeLessThanOrEqual(4)
  })

  it('stays under 3 KB where 360 spans were 30 KB', async () => {
    const html = await render({ ber, peakAt: 12 })
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(3_000)
  })

  it('carries no title attribute — unreachable on touch, 40% of the bytes', async () => {
    const html = await render({ ber, peakAt: 12 })
    expect(html).not.toContain('title=')
  })

  it('keeps one inline style, not one per second', async () => {
    const html = await render({ ber, peakAt: 12 })
    expect((html.match(/style=/g) ?? []).length).toBe(1)
  })

  it('keeps the strip box and its accessible name', async () => {
    const html = await render({ ber, peakAt: 12 })
    expect(html).toContain('class="strip"')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Bit-error rate per second across 360 seconds of overlap"')
  })

  it('still renders a sentence, not an empty box, for a layer-0 merge', async () => {
    const html = await render({ ber: null })
    expect(html).toContain('whole-file digest')
    expect(html).not.toContain('<svg')
  })

  it('omits the second path when there is no peak to mark', async () => {
    const html = await render({ ber })
    expect((html.match(/<path/g) ?? []).length).toBe(1)
  })
})
