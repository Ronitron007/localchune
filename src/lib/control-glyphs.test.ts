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
  // EMPTY, AND THAT IS THE POINT. Every entry that was here has been
  // converted rather than re-justified:
  //
  //   layouts/Shell.astro          ♡        -> Icon heart, and site.ts
  //   components/TrackRow.astro    ♥ ♡ ↓ ⋮ →   repaints it as an <svg>
  //   components/FeedRow.astro     ⋮           rather than a character
  //   pages/track/[id].astro       ♥ ♡
  //   components/ComparePanel.astro  ▶      -> Icon play + .playbtn
  //   pages/member/[username].astro  →      -> deleted; the label already
  //                                            says where the link goes
  //
  // The ♥ was the one that could not be done file by file: `likeGlyph()`
  // in track-format.ts fed `.likeglyph` on five surfaces at once, so it
  // moved as a single change — the constant is `LIKE_ICON` now and
  // site.ts writes a node instead of a string.
  //
  // The two ARROWS and the ⋮ were never emoji-presentable, so they were
  // safe under the narrow reading of the rule. They went anyway, because
  // the rule this file is named for is the broader one: a control does not
  // draw itself with a character. The byte budget that had defended ⋮ was
  // measured on raw bytes and was wrong by twenty times — see the gzipped
  // budget in track-row.test.ts.
  //
  // ADDING AN ENTRY HERE IS A REGRESSION, not a workflow. If a surface
  // genuinely needs a character, it must be decorative rather than a
  // control, and it must say why on the line above.
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

  it('the allowlist is empty, and staying empty is the contract', () => {
    // The sweep finished. This is deliberately a separate assertion from
    // the scan above: the scan would still pass if someone re-added an
    // entry here, and "no exemptions exist" is the property worth pinning.
    expect([...ALLOWED.keys()]).toEqual([])
  })

  it('the track page carries no glyph at all', () => {
    // The owner reported this page by name — first for `►▯ay`, then for
    // the heart. Play, download and tag-remove became SVG in task 3.6;
    // the heart followed with the cross-surface change.
    const source = readFileSync(join(SRC, 'pages/track/[id].astro'), 'utf8')
    const used = new Set(controlText(source).flatMap(({ text }) => GLYPHS.filter((g) => text.includes(g))))
    expect([...used].sort()).toEqual([])
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

/**
 * THE GAP THE CONTROL SCANNER HAD, AND HOW IT WAS FOUND.
 *
 * `controlText` only reads the bodies of <button>, <a> and <summary>. That
 * is the right shape for "a control draws itself with a character", and it
 * is why FeedRow.astro could carry
 *
 *     <span class="feedrow-likes">♥ {track.like_count}</span>
 *
 * for as long as it did: a DISPLAY heart, in a <span>, invisible to every
 * assertion in this file while the identical character three lines away in
 * a <button> was on the allowlist.
 *
 * A font does not care which element a character is in. iOS emoji-renders
 * U+2665 in a <span> exactly as it does in a <button>, so the monochrome
 * interface got its red heart either way — which is the owner's actual
 * complaint, and it was never about controls specifically.
 *
 * So this scans ALL rendered text. It is a second describe rather than a
 * widening of the first because the two rules are genuinely different: a
 * control must not draw itself with a character (a hit-box and
 * accessibility argument), and no text anywhere may use a glyph a platform
 * will colour in (a rendering argument). Attributes are excluded — an
 * aria-label or a title is read aloud, never painted.
 */
function renderedText(source: string): string {
  const end = source.indexOf('---', 3)
  const body = source.startsWith('---') && end > 0 ? source.slice(end + 3) : source
  return body
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    // Tags go last, so an attribute value can never be mistaken for text.
    .replace(/<[^>]*>/g, '')
}

describe('no glyph a platform will colour in appears in rendered text', () => {
  it('holds on every template', () => {
    const offences = astroFiles(SRC).flatMap((file) => {
      const hits = GLYPHS.filter((g) => renderedText(readFileSync(file, 'utf8')).includes(g))
      return hits.length === 0 ? [] : [`${file.slice(SRC.length)} renders ${hits.join(' ')}`]
    })
    expect(offences, 'use <Icon name="…" /> — a font decides how a character is painted').toEqual([])
  })

  it('catches a display glyph a <button> scan would miss', () => {
    // The FeedRow case, reduced. `offences` returns nothing for this.
    const feedish = '---\n---\n<span class="likes">♥ 12</span>'
    expect(offences('/x/a.astro', feedish)).toEqual([])
    expect(GLYPHS.filter((g) => renderedText(feedish).includes(g))).toEqual(['♥'])
  })

  it('still leaves an aria-label alone — it is spoken, never painted', () => {
    expect(renderedText('---\n---\n<button aria-label="Play ▶ now">Play</button>')).not.toContain('▶')
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
