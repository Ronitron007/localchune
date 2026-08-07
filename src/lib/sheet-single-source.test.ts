// src/lib/sheet-single-source.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE ROW SHEET, ONE ⋮, ONE PLACE THAT BUILDS EITHER.
//
// THE NAMED PRECEDENT IS THE TWO-NAVS INCIDENT: the app grew a second
// navigation because the first one was markup rather than a component,
// and nothing failed — two navs are both valid HTML. The row sheet has
// the same shape of risk and a worse blast radius, because site.ts finds
// its entry point through ONE document-level delegation on ONE selector
// (`button.rowmenu`). A second copy of that button that spells the class
// differently is not a broken build; it is a control that silently does
// nothing, on whichever surface nobody checked.
//
// It had already started. `button.rowmenu` was hand-typed in
// TrackRow.astro AND FeedRow.astro, and built a third time in
// search-overlay.ts. For a while one carried a text `⋮` and another an
// <svg>, on two rows a member sees side by side.
//
// So this file pins three properties:
//
//   1. The ⋮ is rendered from ONE Astro component. Any other .astro file
//      that types the class itself is a second source.
//   2. THERE IS NO RUNTIME COPY LEFT. POOL.1 retired the search overlay:
//      /pool is the search page, and its instant results are an Astro
//      PARTIAL rendering the same TrackRow.astro the server-rendered page
//      renders. This used to be a "the runtime copy agrees" assertion,
//      which is a weaker property than "there is no runtime copy" — so it
//      is now the absence that is pinned, plus the partial that made the
//      absence possible.
//   3. The SHEET has one builder and one opener. No surface may branch a
//      sheet of its own. POOL.1's filter chips are the fifth caller and
//      add no sixth primitive.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './source-scan'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return astroFiles(full)
    return e.name.endsWith('.astro') ? [full] : []
  })
}

/** Source only — a `.test.ts` naming the pattern it forbids is not a
 *  second implementation of it. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return tsFiles(full)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : []
  })
}

const ROW_MENU = 'components/RowMenu.astro'

describe('the ⋮ has exactly one source', () => {
  it('RowMenu.astro is it', () => {
    const src = read(ROW_MENU)
    expect(src).toContain('class="rowmenu"')
    expect(src).toContain('aria-haspopup="dialog"')
    // Hidden until JS: a sheet is client state with no server fallback,
    // so a control that would do nothing without JS must not be visible.
    expect(src).toContain('hidden')
    // The <svg> is aria-hidden, so the NAME has to be on the button or
    // the control disappears from assistive tech entirely.
    expect(src).toContain('aria-label')
  })

  it('no other template writes the class itself', () => {
    const offenders = astroFiles(SRC)
      .filter((f) => f.slice(SRC.length) !== ROW_MENU)
      .filter((f) => /class="rowmenu"|class:list=\{\[[^\]]*'rowmenu'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length))
    expect(offenders, 'render <RowMenu title={…} /> instead').toEqual([])
  })

  it('both row components actually use it', () => {
    // The inverse of the rule above: "nobody types the class" is also
    // satisfied by nobody rendering a ⋮ at all, which would delete the
    // feature rather than unify it.
    for (const f of ['components/TrackRow.astro', 'components/FeedRow.astro']) {
      expect(read(f), `${f} must render the shared ⋮`).toContain('<RowMenu title=')
    }
  })

  it('no module builds a ⋮ at runtime any more', () => {
    // The search overlay was the one place that had to. POOL.1 deleted it,
    // so the strongest available assertion is that nothing recreated it.
    expect(existsSync(join(SRC, 'lib/search-overlay.ts')),
      'the overlay is retired — /pool is the search page').toBe(false)
    const offenders = tsFiles(SRC)
      .filter((f) => /createElement\(\s*'button'\s*,\s*'rowmenu'|className\s*=\s*'rowmenu'/
        .test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length))
    expect(offenders, 'render <RowMenu /> from a partial instead').toEqual([])
  })

  it('the instant results are the SAME row, because they are the same component', () => {
    // This is what replaced the runtime builder, and it is the reason the
    // assertion above can be an absence. /pool fetches this partial while a
    // member types and swaps its <section> in; the partial renders
    // TrackTable -> TrackRow, so a searched row and a browsed row cannot
    // differ by so much as an attribute.
    const partial = read('pages/partials/pool-rows.astro')
    expect(partial).toContain('export const partial = true')
    expect(partial).toContain('<TrackTable')
    expect(read('components/TrackTable.astro')).toContain('<TrackRow')
  })
})

describe('the sheet has one builder and one opener', () => {
  const site = read('scripts/site.ts')

  it('openActionSheet is exported once and is the only sheet primitive', () => {
    expect(site.match(/export function openActionSheet/g)?.length).toBe(1)
    // A second implementation would show up as a second panel class.
    expect(site.match(/className = 'sheet-panel'|'sheet-panel'/g)?.length).toBeGreaterThan(0)
  })

  it('one delegation opens the row sheet, on the one selector', () => {
    expect(site.match(/closest\?\.\('button\.rowmenu'\)/g)?.length).toBe(1)
    expect(site.match(/function openRowSheet/g)?.length).toBe(1)
  })

  it('no surface branches a sheet of its own', () => {
    // The row sheet is built from what the ROW CARRIES, never from which
    // page it is on. A page check here would be the divergence this file
    // exists to prevent — it is how the feed came to have a four-row
    // sheet where the pool had fourteen.
    const fn = site.slice(site.indexOf('function openRowSheet'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    for (const smell of ['feedrow', 'searchrow', 'trackrow', 'location.pathname']) {
      expect(body, `openRowSheet must not know about ${smell}`).not.toContain(smell)
    }
  })
})

describe('every row that opens the sheet carries what the sheet reads', () => {
  /**
   * The sheet is built by READING the row: `form.likeform`,
   * `button.queueadd`, `details.cratepick`, and the metadata cells. A row
   * that renders a ⋮ but none of those gets a sheet with two entries,
   * which is a divergent sheet arrived at by omission rather than by a
   * branch — exactly what the feed had.
   */
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['components/TrackRow.astro', 'the pool row — canonical'],
    ['components/FeedRow.astro', 'the feed row'],
  ]

  it.each(rows)('%s carries the like form and the crate picker', (file) => {
    const src = read(file)
    expect(src).toContain('class="likeform"')
    expect(src).toContain('class="likebtn"')
    expect(src).toContain('class="cratepick"')
    expect(src).toContain('class="queueadd')
  })

  it('a searched row carries them because it IS the pool row', () => {
    // The overlay used to rebuild all four hooks by hand and this
    // assertion checked the copy. There is no copy: /pool's instant
    // results render TrackRow through an Astro partial, so the row above
    // is literally the row a search returns. Pinned through the partial so
    // that swapping it for a JSON route and a JS renderer fails here.
    const partial = read('pages/partials/pool-rows.astro')
    expect(partial).toContain('<TrackTable')
    // `withoutComments` because THIS FILE'S HEADER AND THE PARTIAL'S BOTH
    // NAME THE THING THEY FORBID — the partial's opening block explains
    // that it exists so nobody writes `document.createElement` rows again.
    // Sixth time in this repo; src/lib/source-scan.ts keeps the list.
    expect(withoutComments(partial)).not.toContain('createElement')
  })

  it('the crate row adds ONE contextual entry, and by data not by page', () => {
    const site = read('scripts/site.ts')
    // Reached through the row's own form — no second remove path.
    expect(site).toContain("form.removeform")
    expect(site).toContain("removeForm?.requestSubmit()")
    // requestSubmit, never submit(): submit() fires no submit event, so
    // the delegated confirm() guarding this POST would never run.
    expect(site).not.toContain('removeForm?.submit()')
  })
})
