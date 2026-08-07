// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE OWNER'S ICON DIRECTIVE, MADE CHECKABLE: no control in this app draws
// itself with a text glyph.
//
// The owner, reading the live app on a phone: the ▶ / ⏸ / ⏭ controls were
// EMOJI. iOS applies emoji presentation to characters like U+25B6 and
// U+2665 on its own — a font decision the app does not get a vote in — so a
// monochrome 90-degree interface renders a fat blue-and-white rounded
// triangle in the middle of it. There is no CSS that reliably prevents
// this; the fix is to stop asking a font for a picture.
//
// Phase 1 built the answer already: thirteen inline SVGs in src/lib/icons.ts
// with square terminals and no library. An <svg> cannot be emoji-rendered,
// takes a size and a colour independently of the label, and can be given a
// hit box. This test is what stops the fourteenth glyph from being typed.
//
// WHY A LIST OF KNOWN SURFACES RATHER THAN A CLEAN SWEEP. Three surfaces
// still carry glyphs and none of them is this task's file:
//
//   Shell.astro         the player bar's ▶ ⏭ ☰, built and rewritten by
//                       site.ts at runtime as well as rendered here
//   TrackRow.astro      the row's ♥/♡ ↓ ⋮ +Q
//   FeedRow.astro       the feed row's ♥ ⋮ +Q
//
// The ♥ in particular is not a template edit: `likeGlyph()` in
// track-format.ts is written into `.likeglyph` by site.ts on three surfaces
// at once (row, track page, player bar), so converting it is one coherent
// change across those files and a change to how site.ts writes that node —
// not something to do halfway from here. They are listed, so the rule is
// stated and the remaining work is named; nothing OUTSIDE the list may
// regress, and a fixed surface can simply be deleted from it.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return astroFiles(full)
    return e.name.endsWith('.astro') ? [full] : []
  })
}

/**
 * Characters a platform may render as emoji, or that exist only to imitate
 * an icon. Listed one by one rather than by Unicode block: an em dash and a
 * middle dot are typography and must stay legal, and a block range would
 * take them with it.
 */
const GLYPHS = [
  // transport and media
  '▶', '►', '⏵', '⏸', '⏯', '⏭', '⏮', '⏹', '■', '●', '◼', '⏏',
  // hearts and stars — state that a fill should carry, not a character
  '♥', '♡', '❤', '★', '☆',
  // arrows used as buttons
  '↑', '↓', '←', '→', '⬆', '⬇', '⇧', '⇩',
  // marks
  '✕', '✖', '✗', '✓', '✔', '×', '✚',
  // menus and chrome
  '☰', '⋮', '⋯', '⚙', '🔍', '🔎', '⚠', 'ℹ', '☓',
] as const

/**
 * THE DEBT, NAMED GLYPH BY GLYPH RATHER THAN FILE BY FILE.
 *
 * A whole-file exemption would let a NEW glyph be added to an already-listed
 * file and nobody would hear about it, which is the failure mode this test
 * exists to prevent. Each entry lists the exact characters that surface is
 * still allowed to carry; anything else there fails, and an empty list means
 * the file is done. Delete a character when you convert it.
 *
 * The ♥ is the one that is not a template edit. `likeGlyph()` in
 * track-format.ts is written into `.likeglyph` by site.ts on three surfaces
 * at once — the pool row, this page and the player bar — so converting it is
 * one coherent change across those files plus a change to how site.ts writes
 * that node (textContent to markup). Doing it halfway from a track-page task
 * would leave the same heart rendering two ways on one screen.
 */
const ALLOWED = new Map<string, string[]>([
  // The player bar's transport and the drawer toggle. site.ts swaps ▶ for
  // ⏸ and writes the heart at runtime, so this one is not template-only —
  // the ⏸ is not in the markup at all, which is exactly why the list is
  // per-glyph and pruned.
  ['layouts/Shell.astro', ['▶', '⏭', '☰', '♡']],
  ['components/TrackRow.astro', ['♥', '♡', '↓', '⋮', '→']],
  ['components/FeedRow.astro', ['⋮']],
  // Task 3.6 converted this page's play, download and tag-remove controls
  // to the SVG set. The like heart is the shared-glyph case above.
  ['pages/track/[id].astro', ['♥', '♡']],
  // Other agents' surfaces, untouched by this task and listed so their
  // current state is recorded rather than silently permitted.
  ['components/ComparePanel.astro', ['▶']],
  ['pages/crate/[id].astro', ['▶', '↑', '↓', '✕']],
  ['pages/member/[username].astro', ['→']],
])

/** Comments are stripped: this repo documents the glyphs it removed, and
 *  the removal note must not read as a violation. `<svg>` contents go too —
 *  an icon's path data is not a label. */
function controlText(source: string): { text: string; line: number }[] {
  const end = source.indexOf('---', 3)
  const body = source.startsWith('---') && end > 0 ? source.slice(end + 3) : source
  const html = body
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
  const found: { text: string; line: number }[] = []
  const control = /<(button|a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = control.exec(html)) !== null) {
    found.push({ text: m[2], line: html.slice(0, m.index).split('\n').length })
  }
  return found
}

/** Glyphs this file uses that it is not on record as being allowed to. */
function offences(file: string, source: string): string[] {
  const rel = file.slice(SRC.length)
  const allowed = ALLOWED.get(rel) ?? []
  return controlText(source).flatMap(({ text, line }) => {
    const hit = GLYPHS.filter((g) => text.includes(g) && !allowed.includes(g))
    return hit.length === 0 ? [] : [`${rel}:${line} — control draws itself with ${hit.join(' ')}`]
  })
}

describe('no control draws itself with a text glyph', () => {
  const files = astroFiles(SRC)

  it('scans the templates', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('no surface carries a glyph it is not on record for', () => {
    const all = files.flatMap((f) => offences(f, readFileSync(f, 'utf8')))
    expect(all, 'use <Icon name="…" /> from src/lib/icons.ts').toEqual([])
  })

  it('the track page carries the shared ♥ and nothing else', () => {
    // The owner reported this page by name. Play, download and tag-remove
    // are SVG; this asserts the page cannot quietly grow a fourth glyph
    // while the heart waits for its own cross-surface change.
    const source = readFileSync(join(SRC, 'pages/track/[id].astro'), 'utf8')
    const used = new Set(controlText(source).flatMap(({ text }) => GLYPHS.filter((g) => text.includes(g))))
    expect([...used].sort()).toEqual(['♡', '♥'])
  })

  it('every allowlisted glyph is still really there — no stale exemptions', () => {
    // An allowlist nobody prunes stops describing the code. A surface that
    // has been converted must lose its entry, and this is what says so.
    const stale = [...ALLOWED].flatMap(([rel, glyphs]) => {
      const text = controlText(readFileSync(join(SRC, rel), 'utf8')).map((c) => c.text).join('')
      return glyphs.filter((g) => !text.includes(g)).map((g) => `${rel} no longer uses ${g}`)
    })
    expect(stale, 'delete the converted glyph from ALLOWED').toEqual([])
  })
})

describe('the scanner itself', () => {
  it('catches a glyph control', () => {
    const bad = '---\n---\n<a class="play">▶ Play</a>'
    expect(offences('/x/a.astro', bad)).toHaveLength(1)
  })

  it('catches a glyph inside an expression', () => {
    const bad = "---\n---\n<button>{liked ? '♥' : '♡'}</button>"
    expect(offences('/x/a.astro', bad)).toHaveLength(1)
  })

  it('passes an SVG icon with a word label', () => {
    const good = '---\n---\n<a class="play"><svg class="icon"><path d="M8 5 L20 12Z"/></svg> Play</a>'
    expect(offences('/x/a.astro', good)).toEqual([])
  })

  it('leaves typography alone — an em dash is not an icon', () => {
    expect(offences('/x/a.astro', '---\n---\n<a>Artist — Title · 3 plays</a>')).toEqual([])
  })

  it('ignores a glyph quoted in a comment', () => {
    expect(offences('/x/a.astro', '---\n---\n{/* was ▶ Play */}\n<a>Play</a>')).toEqual([])
  })
})
