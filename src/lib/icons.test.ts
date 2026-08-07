// src/lib/icons.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The 90 degree mandate, applied at icon level. Square terminals are the
// icon-level analogue of border-radius: 0 — the reference set this design
// borrows from uses round caps, and that single substitution is what makes
// this set ours rather than theirs. A test holds it, because "round" is
// the default a contributor reaches for.

import { describe, expect, it } from 'vitest'
import * as icons from './icons'
import { ICONS, ICON_NAMES, renderGlyph, type IconName } from './icons'

const entries = Object.entries(ICONS) as [IconName, string][]

describe('the set', () => {
  // SIXTEEN, NOT THIRTEEN, and each addition is named in the commit that made
  // it. OWNER, 2026-08-07: no text-glyph control anywhere — iOS renders
  // characters like ⏭ and ⏸ as colour emoji, which is a platform decision
  // painted over a monochrome design. Three glyphs the set did not have:
  //   move-up / move-down  the crate's one-step reorder pair, was `↑` `↓`
  //   queue                the drawer's toggle, was `☰`
  // `prev` is still absent: it is `next` under a CSS transform, and the
  // status `x` is still `close` reused.
  it('exports sixteen glyphs and no more', () => {
    expect(entries).toHaveLength(16)
  })

  it('names them exactly as the spec does', () => {
    expect(Object.keys(ICONS).sort()).toEqual([
      'check', 'close', 'crate', 'download', 'drag', 'heart', 'kebab',
      'move-down', 'move-up', 'next', 'pause', 'play', 'queue', 'queue-add',
      'search', 'upload',
    ])
  })

  it('draws `queue` and `queue-add` as a pair — the list, and adding to it', () => {
    // Same three lines at the same y positions. They read as one family
    // because they are literally the same drawing plus a plus.
    for (const y of ['4 7h', '4 12h', '4 17h']) {
      expect(ICONS.queue).toContain(y)
      expect(ICONS['queue-add']).toContain(y)
    }
    expect(ICONS['queue-add']).toContain('M17 14v7') // the plus
    expect(ICONS.queue).not.toContain('M17 14v7')
  })

  it('does not reuse the transfer glyphs for the reorder pair', () => {
    // `upload`/`download` carry a baseline — the line an object is lifted off
    // or dropped onto — which is what makes them mean "transfer". Rotating one
    // would give a crate row two controls reading "download this track".
    expect(ICONS['move-up']).not.toContain('h16')
    expect(ICONS['move-down']).not.toContain('h16')
    expect(ICONS.upload).toContain('h16')
    expect(ICONS.download).toContain('h16')
  })

  it('exports the names as a type-safe list', () => {
    expect(icons.ICON_NAMES).toEqual(Object.keys(ICONS))
  })
})

describe('the 90 degree doctrine', () => {
  it.each(entries)('%s has no round line cap', (_name, markup) => {
    expect(markup).not.toContain('stroke-linecap="round"')
  })

  it.each(entries)('%s has no round line join', (_name, markup) => {
    expect(markup).not.toContain('stroke-linejoin="round"')
  })

  it.each(entries)('%s declares square terminals when it strokes', (_name, markup) => {
    if (!markup.includes('stroke-width')) return // a filled glyph draws no line
    expect(markup).toContain('stroke-linecap="square"')
    expect(markup).toContain('stroke-linejoin="miter"')
  })
})

describe('every glyph is a fragment, not a document', () => {
  it.each(entries)('%s contains no <svg> wrapper', (_name, markup) => {
    // Icon.astro owns the wrapper. A glyph that carried its own could not
    // be resized, and two sources of viewBox is one too many.
    expect(markup).not.toContain('<svg')
  })

  it.each(entries)('%s hard-codes no colour', (_name, markup) => {
    // Everything inherits currentColor, which is what makes an icon white
    // inside a .btn, red inside .btn-danger and --ink-55 in a meta run
    // with no per-context rule.
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/\brgba?\(/)
    expect(markup).not.toMatch(/(fill|stroke)="(?!none|currentColor)[a-z]/i)
  })

  it.each(entries)('%s stays under 400 bytes', (_name, markup) => {
    expect(markup.length).toBeLessThan(400)
  })

  it.each(entries)('%s is non-empty and draws something', (_name, markup) => {
    expect(markup.trim().length).toBeGreaterThan(0)
    expect(markup).toMatch(/<(path|rect|circle|line|polyline|g)\b/)
  })
})

describe('paint discipline', () => {
  // Transport glyphs are solid fills with no stroke: a filled triangle
  // and two bars are already brutalist primitives and read better at
  // 16px than any outline can.
  it.each(['play', 'pause', 'next', 'kebab', 'drag'] as IconName[])(
    '%s is a filled primitive, not an outline',
    (name) => {
      expect(ICONS[name]).toContain('fill="currentColor"')
      expect(ICONS[name]).not.toContain('stroke-width')
    },
  )

  it.each([
    'queue-add', 'download', 'upload', 'search', 'close', 'crate', 'check',
    'move-up', 'move-down', 'queue',
  ] as IconName[])(
    '%s is stroked and inherits currentColor',
    (name) => {
      expect(ICONS[name]).toContain('stroke-width')
    },
  )

  it('heart strokes by default so it can FILL when liked', () => {
    // The one glyph whose paint changes with state, and the reason it is
    // stroked rather than filled at rest.
    expect(ICONS.heart).toContain('stroke-width')
  })
})

describe('renderGlyph', () => {
  it('returns the glyph unchanged with no options', () => {
    expect(renderGlyph('search')).toBe(ICONS.search)
  })

  it('thickens a 2px stroke to 2.5 at 14px and under', () => {
    expect(renderGlyph('search', { small: true })).toContain('stroke-width="2.5"')
    expect(renderGlyph('search', { small: true })).not.toContain('stroke-width="2"stroke')
  })

  it('leaves check alone — it already declares 2.5', () => {
    expect(renderGlyph('check', { small: true })).toBe(ICONS.check)
  })

  it('fills the heart, and only where fill was none', () => {
    const liked = renderGlyph('heart', { filled: true })
    expect(liked).toContain('fill="currentColor"')
    expect(liked).not.toContain('fill="none"')
    // Still the same path. A liked heart is painted, never redrawn.
    expect(liked).toContain('M12 20 L4 12')
  })

  it.each(ICON_NAMES)('%s survives both transforms without a colour literal', (name) => {
    const out = renderGlyph(name, { small: true, filled: true })
    expect(out).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(out).not.toContain('stroke-linecap="round"')
  })
})
