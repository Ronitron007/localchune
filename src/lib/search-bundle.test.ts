// src/lib/search-bundle.test.ts
// localchune — MIT licensed. See LICENSE.
//
// THE SEARCH OVERLAY MUST NOT REACH /login.
//
// Shell.astro mounts on every page and loads site.ts as a single
// `<script src>`, so everything in site.ts's STATIC import graph is shipped
// to every page — including the one page a signed-out visitor sees. The
// queue engine already learned this (shell-bundle.test.ts, perf task 2.3);
// the overlay is the same regression arriving through a different door,
// and it would produce no build error, no failing test and no visible
// change on a laptop.
//
// The defence is the design: site.ts reaches search-overlay.ts through
// `await import()` and nothing else. This file asserts that, and asserts
// the row contract the overlay depends on for its zero-new-code reuse —
// which is the other thing that can silently rot.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname
const site = readFileSync(join(SRC, 'scripts/site.ts'), 'utf8')
const overlay = readFileSync(join(SRC, 'lib/search-overlay.ts'), 'utf8')
const nav = readFileSync(join(SRC, 'components/AppNav.astro'), 'utf8')

const frontmatter = (source: string): string => {
  const m = source.match(/^---\n([\s\S]*?)\n---/)
  return m === null ? '' : m[1]
}

/**
 * Source with its comments removed.
 *
 * The prose in search-overlay.ts legitimately names the very things the
 * assertions below forbid — it explains WHY the rows sit outside a
 * `[data-queue-list]`, and why `▶`/`⋮`/`♥` are drawn as SVG rather than
 * typed as characters. Scanning the raw file makes those explanations
 * fail the test that they document, which is the worst possible incentive:
 * it would pressure the next person to delete the reasoning rather than
 * keep the rule. Same motivation as `frontmatter()` above.
 *
 * Block comments first, then whole-line `//` comments — deliberately NOT
 * trailing `//`, which would need a string-aware parser to avoid eating
 * the SVG namespace URL and every `https://` in the file.
 */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

const overlayCode = code(overlay)

describe('the overlay stays a lazy chunk', () => {
  it('site.ts imports search-overlay DYNAMICALLY and never statically', () => {
    // A static `import ... from '../lib/search-overlay'` at the top of
    // site.ts is the whole regression. Look for any import of the module
    // that is not the dynamic form.
    const staticImport = /^\s*import\s[^\n]*['"][^'"]*search-overlay['"]/m
    expect(site).not.toMatch(staticImport)
    expect(site).toMatch(/import\(\s*['"]\.\.\/lib\/search-overlay['"]\s*\)/)
  })

  it('site.ts does not statically import search-api either', () => {
    // search-api carries the fetch client and the projection; it belongs in
    // the lazy chunk with its only caller.
    expect(site).not.toMatch(/^\s*import\s[^\n]*['"][^'"]*search-api['"]/m)
  })

  it('no .astro page or island imports the overlay or its api module', () => {
    const astroFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name)
        if (e.isDirectory()) return astroFiles(full)
        return e.name.endsWith('.astro') || e.name.endsWith('.tsx') ? [full] : []
      })
    // MATCHED AS AN IMPORT, not as a substring. The bare-name version of
    // this flagged RowMenu.astro for a frontmatter COMMENT explaining that
    // search-overlay.ts builds its own copy of the ⋮ — a file documenting
    // the module it must stay in step with, which is the opposite of the
    // defect. The rule is "no .astro pulls the overlay into its graph", so
    // it is `from '…'` and `import('…')` that matter. Both forms are
    // covered; a bare `import '…'` for side effects is too.
    const IMPORTS_OVERLAY = /(?:from|import)\s*\(?\s*['"][^'"]*(?:search-overlay|search-api)['"]/
    const offenders = astroFiles(SRC)
      .filter((f) => IMPORTS_OVERLAY.test(frontmatter(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length))
    // /api/search.ts is a server route, not an .astro file, so it is not
    // in this sweep — it may import search-api freely.
    expect(offenders).toEqual([])
  })

  it('the overlay does not import site.ts — that would be a cycle back into the entry', () => {
    expect(overlay).not.toMatch(/from\s+['"][^'"]*scripts\/site/)
  })
})

describe('the nav icon keeps its no-JS destination', () => {
  it('is still an <a> to /pool, not a <button>', () => {
    // Without JS this is the only search a member has. A <button> here
    // would be a control that does nothing — the one thing every queue
    // control in this repo ships `hidden` to avoid.
    expect(nav).toMatch(/<a class="navsearch" href="\/pool"/)
  })

  it('carries an accessible name and the SVG icon, never a text glyph', () => {
    expect(nav).toContain('aria-label="Search the pool"')
    expect(nav).toMatch(/<Icon name="search"/)
  })

  it('site.ts leaves a modified click alone, so cmd-click still opens /pool', () => {
    const handler = site.slice(site.indexOf("closest?.('a.navsearch')"))
    const scoped = handler.slice(0, handler.indexOf('}, true)'))
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      expect(scoped).toContain(key)
    }
  })
})

describe('a result row IS a pool row — the reuse contract', () => {
  // Every selector below is one site.ts already queries for the pool
  // table. The overlay renders rows that match them so that play, the ⋮
  // sheet, +queue, the ♥ and the crate picker all work with NO new code.
  // Drop any one of these and that feature silently stops working in the
  // overlay only, with nothing else in the repo noticing — site.ts cannot
  // be imported under node, which is why this is a source assertion.
  it.each([
    ['data-play-row', /dataset\.playRow/],
    ['a.play', /el\('a', 'play'\)/],
    ['data-track-id', /dataset\.trackId/],
    ['button.rowmenu', /el\('button', 'rowmenu'\)/],
    ['button.queueadd', /el\('button', 'queueadd/],
    ['form.likeform', /el\('form', 'likeform'\)/],
    ['button.likebtn', /el\('button', 'likebtn'\)/],
    ['.likeglyph', /'likeglyph'/],
    ['.likecount', /'likecount'/],
    ['details.cratepick', /el\('details', 'cratepick'\)/],
  ])('renders %s', (_name, pattern) => {
    expect(overlay).toMatch(pattern)
  })

  it('puts all six queue attributes on the play link, where scrapeOne reads them', () => {
    const row = overlay.slice(overlay.indexOf('function rowEl'), overlay.indexOf('let openOverlay'))
    for (const attr of ['trackId', 'artist', 'title', 'duration', 'bpm', 'key']) {
      expect(row).toMatch(new RegExp(`play\\.dataset\\.${attr}`))
    }
  })

  it('carries the metadata classes openRowSheet reads by name', () => {
    // ROW_META in site.ts maps these cell classes to sheet rows. They are
    // the same node as the visible chips, so no value is duplicated.
    for (const cls of ['bpm', 'key', 'duration', 'quality']) {
      expect(overlay).toMatch(new RegExp(`'[^']*\\b${cls}\\b[^']*'`))
    }
  })

  it('renders the like form as a real POST with data-astro-reload', () => {
    // CLAUDE.md's rule applies to markup built in a portal exactly as it
    // does to markup on a page.
    expect(overlay).toMatch(/likeform\.method = 'post'/)
    expect(overlay).toContain("setAttribute('data-astro-reload'")
  })

  it('does NOT wrap the rows in a [data-queue-list] container', () => {
    // Outside one, site.ts plays the clicked track alone and queues
    // nothing — the semantics /track/[id] already has, and the right
    // reading of a search result.
    expect(overlayCode).not.toContain('data-queue-list')
    expect(overlayCode).not.toMatch(/dataset\.queueList/)
  })
})

describe('no text-glyph controls — the standing owner directive', () => {
  // iOS emoji-renders bare characters like these, which is the whole
  // reason icons.ts exists. Every CONTROL in the overlay draws an SVG.
  it.each(['▶', '⏭', '⏮', '⋮', '✕', '×', '↓', '♥'])('does not paint %s', (glyph) => {
    expect(overlayCode).not.toContain(glyph)
  })

  it('paints no ♡ either — the like glyph is the icon set now', () => {
    // This used to assert that the ONE ♡ in the file sat inside the hidden
    // like form. There is no ♡ at all any more: the heart is `iconEl` from
    // icons.ts, filled or stroked, on this surface and the four rendered
    // ones together. The node still exists and is still hidden — site.ts's
    // like delegation queries `.likeglyph` by name and repaints it.
    expect(overlay).not.toContain('♡')
    expect(overlay).toContain('likeglyph')
    expect(overlay).toContain('likeform.hidden = true')
  })

  it('builds its controls from the icon set', () => {
    // `iconEl`, not the local `svgIcon` this file used to assert: that
    // helper was one of two byte-identical copies (the other in site.ts)
    // and both are gone. One builder in icons.ts serves the sheet rows,
    // these results and the like heart, from one attribute table.
    for (const icon of ['search', 'close', 'kebab']) {
      expect(overlay).toMatch(new RegExp(`iconEl\\('${icon}'`))
    }
  })

  it('takes the like heart from the shared constant, not a fourth opinion', () => {
    // Five surfaces render this control and site.ts repaints whichever is
    // on screen. Naming the glyph here instead of importing LIKE_ICON is
    // how the overlay's heart would come to differ in size from the row's.
    expect(overlay).toContain('iconEl(LIKE_ICON.name')
  })
})

describe('empty, error and hint stay three different things — §6.6, survive-list #16', () => {
  const css = readFileSync(join(SRC, 'styles/global.css'), 'utf8')

  it('renders an outage with different words from an empty result', () => {
    // The worst possible outcome of this feature is a member reading "the
    // database is down" as "your pool is empty" and giving up.
    expect(overlayCode).toContain('No tracks match that.')
    expect(overlayCode).toContain('Search is unavailable right now.')
    expect(overlayCode).toContain('Session ended — reload to sign in.')
  })

  it('tags each message with its own kind, so CSS can tell them apart', () => {
    expect(overlayCode).toMatch(/'hint' \| 'empty' \| 'error'/)
    expect(overlayCode).toMatch(/setMessage\([^)]*'error'\)/s)
    expect(overlayCode).toMatch(/setMessage\('No tracks match that\.', 'empty'\)/)
  })

  it('...and the CSS actually distinguishes them', () => {
    // A `kind` nothing styles differently would be a distinction that
    // exists only in the source.
    expect(css).toContain('.searchoverlay-message.is-empty')
    expect(css).toContain('.searchoverlay-message.is-error')
    expect(css).toMatch(/\.searchoverlay-message\.is-empty\s*\{[^}]*--line-dash/)
    expect(css).toMatch(/\.searchoverlay-message\.is-error\s*\{[^}]*--btn-red/)
  })

  it('teaches the token syntax on open — it is otherwise undiscoverable', () => {
    // Nothing else in the app hints that `128` or `8A` mean anything in a
    // search box.
    expect(overlayCode).toContain('showOpeningHint')
    expect(overlayCode).toMatch(/128/)
    expect(overlayCode).toMatch(/8A/)
  })

  it('returns to that hint when the box is cleared, not to a blank panel', () => {
    expect(overlayCode).toMatch(/if \(raw\.trim\(\) === ''\) showOpeningHint\(\)/)
  })
})

describe('the request discipline', () => {
  it('aborts the previous request before starting another', () => {
    // Without this a slow answer to `mo` can repaint over a fast answer to
    // `mochakk`, which looks exactly like the search being wrong.
    expect(overlay).toContain('inflight?.abort()')
    expect(overlay).toContain('new AbortController()')
  })

  it('cancels the pending timer when the query drops below the floor', () => {
    // Deleting back to one character must not let an already-scheduled
    // search fire.
    expect(overlay).toContain('run.cancel()')
  })

  it('debounces at 150ms — half the pool filter, which costs a page load', () => {
    expect(overlay).toMatch(/DEBOUNCE_MS = 150/)
  })

  it('closes on astro:before-swap, like every other portalled surface', () => {
    // Portalled to <body>, so it sits outside transition:persist and
    // ClientRouter would destroy the node while this module still held a
    // reference and <body> was still scroll-locked.
    expect(overlay).toContain("astro:before-swap")
  })

  it('locks the page through the shared, COUNTED helper', () => {
    // This used to assert a local `prevOverflow` snapshot, which was the
    // right instinct and the wrong mechanism. A snapshot per overlay still
    // gets it wrong when two are up at once: a sheet opened from the player
    // bar over an open queue drawer restored ITS value on close and
    // unlocked the page under a drawer that was still there.
    // src/lib/overlay.ts counts instead, so the page unlocks when the last
    // overlay leaves and not before.
    expect(overlay).toContain('lockPage(')
    expect(overlay).toContain('releaseLock()')
    expect(overlay, 'the overlay must not manage body overflow itself')
      .not.toContain('body.style.overflow')
  })
})
