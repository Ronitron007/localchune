// src/scripts/pool-search-wiring.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// POOL.1 — THE PROPERTIES OF INSTANT SEARCH THAT NOTHING ELSE CAN SEE.
//
// A source guard, in the tradition of queue-wiring.test.ts, and for the
// same reason: these are decisions about ORDER and IDENTITY that a
// rendered DOM cannot show and a browser pass only catches by luck.
//
//   · the previous request is ABORTED before the next starts. Without it a
//     slow answer to `mo` lands after a fast answer to `mochakk` and
//     repaints the older result. It looks exactly like the search being
//     wrong, and it reproduces about one time in thirty.
//   · `history.state` is PRESERVED through replaceState. ClientRouter
//     keeps its own {index, scroll} bookkeeping in there, and a popstate
//     onto an entry we blanked makes it hard-reload the document.
//   · the fetch goes to the PARTIAL. Fetching /pool would swap a whole
//     document — nav, player, upload chip — into a <section>.
//   · the swap uses DOMParser, never innerHTML.
//   · a dead session is detected by `redirected`, because the middleware
//     answers with a /login PAGE and a content-type test cannot tell one
//     HTML document from another.
//
// And the two absences that make the rest true: no client-side row builder,
// and no page-name test anywhere in the wiring.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '../lib/source-scan'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const raw = read('scripts/site.ts')
/** A rule about CODE must read CODE — this file's own header names half
 *  the things it forbids, and so does site.ts's. Sixth time in this repo;
 *  src/lib/source-scan.ts keeps the list. */
const code = withoutComments(raw)

/** The instant-search block, from its debounce declaration to the reveal
 *  that closes it. Slicing rather than searching the whole file is what
 *  makes "the fetch aborts" an assertion about THIS fetch. */
const block = (() => {
  const start = code.indexOf('const POOL_DEBOUNCE_MS')
  const end = code.indexOf('function revealInstantSearch')
  return code.slice(start, end)
})()

describe('the block exists and is the one under test', () => {
  it('is found', () => {
    expect(block.length).toBeGreaterThan(400)
  })

  it('replaced the old full-page autosubmit entirely', () => {
    // What this replaces: `debounce(form.requestSubmit, 300)` on any input
    // named `q` in a `[data-autosubmit]` form — a full document per typing
    // pause, Shell and nav and two RPCs included.
    expect(code).not.toContain('data-autosubmit')
    expect(code).not.toContain('const autosubmit')
  })
})

describe('the request discipline', () => {
  it('debounces', () => {
    expect(block).toMatch(/debounce\([\s\S]*POOL_DEBOUNCE_MS\)/)
  })

  it('aborts the previous request BEFORE starting the next', () => {
    const abort = block.indexOf('poolInflight?.abort()')
    const create = block.indexOf('new AbortController()')
    expect(abort).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(-1)
    expect(abort).toBeLessThan(create)
  })

  it('passes the signal to fetch and re-checks it before painting', () => {
    // The signal alone is not enough: an abort that lands between the
    // response and the swap still repaints. Both halves are load-bearing.
    expect(block).toContain('signal: ac.signal')
    expect(block).toContain('!ac.signal.aborted')
  })

  it('an aborted fetch is not reported as an outage', () => {
    // Aborting is the expected outcome of typing. Painting "Search is
    // unavailable" over it would make every fast typist see an error.
    expect(block).toContain("name === 'AbortError'")
  })
})

describe('the address bar', () => {
  it('preserves history.state rather than blanking it', () => {
    expect(block).toContain('history.replaceState(history.state')
  })

  it('replaces rather than pushes, so typing is not history', () => {
    // Deliberate: a chip change is a real navigation and a keystroke is
    // not. Forty history entries for one search is a page you cannot leave.
    expect(block).toContain('history.replaceState')
    expect(block).not.toContain('history.pushState')
  })

  it('writes /pool, not the partial, into the bar', () => {
    expect(block).toMatch(/'\/pool'|`\/pool\?/)
  })

  it('builds the query from the FORM, never from a hand-written field list', () => {
    // The form is the single source of what the page is showing. A name
    // list here would be a second one to keep in step with FilterBar.astro.
    expect(block).toContain('new FormData(form)')
  })

  it('drops empty values so the unfiltered pool has a clean URL', () => {
    expect(block).toMatch(/if \(v !== ''\) sp\.set/)
  })
})

describe('the swap', () => {
  it('fetches the partial, addressed through the one builder', () => {
    expect(block).toContain('poolPartialHref(sp)')
    expect(read('lib/pool-api.ts')).toContain("POOL_PARTIAL_PATH = '/partials/pool-rows'")
  })

  it('parses with DOMParser rather than assigning innerHTML', () => {
    expect(block).toContain('new DOMParser()')
    expect(block).not.toContain('innerHTML')
  })

  it('builds no row of its own', () => {
    // THE POINT OF THE PARTIAL. The retired overlay had ~140 lines of
    // createElement written against TrackRow.astro's markup contract by
    // hand, and it still drifted into three different ⋮ implementations.
    for (const smell of ['createElement', 'data-track-id', 'likeform', 'cratepick']) {
      expect(block, `the partial renders the row — do not rebuild ${smell}`)
        .not.toContain(smell)
    }
  })

  it('replaces the results section and nothing around it', () => {
    expect(block).toContain("querySelector('section.tracktable')")
    expect(block).toContain('replaceWith')
  })

  it('re-reveals the JS-only row controls the swap brought in hidden', () => {
    // A fresh page's worth of `button.rowmenu[hidden]` and `+Q` arrives
    // with every swap, and `<script src>` modules evaluate once per
    // document. Same rule the after-swap reveal already holds.
    expect(block).toContain('revealQueueControls()')
  })

  it('detects a dead session by the redirect, not by content-type', () => {
    // src/middleware.ts redirects a member-less request to /login and
    // fetch() follows it, so a dead session arrives as a 200 full of HTML.
    expect(block).toContain('res.redirected')
    expect(block).toContain('SessionExpiredError')
  })

  it('leaves the rows in place on an outage — survive-list #16', () => {
    // An outage must NOT read as an empty pool. The rows already on screen
    // are still true; they are just no longer the answer to what is typed.
    expect(block).not.toMatch(/catch[\s\S]*replaceChildren|catch[\s\S]*\.remove\(\)/)
    expect(block).toContain('is-error')
  })
})

describe('the announcement', () => {
  it('writes into a node OUTSIDE the swapped section', () => {
    // A live region replaced along with its content does not announce —
    // the node the screen reader was watching is gone.
    expect(block).toContain(".poolstatus")
    expect(read('pages/pool.astro')).toContain('class="poolstatus"')
    expect(read('pages/pool.astro')).toContain('aria-live="polite"')
    // …and it is a sibling of the table, not inside it.
    const page = read('pages/pool.astro')
    expect(page.indexOf('poolstatus')).toBeLessThan(page.indexOf('<TrackTable'))
  })

  it('takes the NUMBER from the server rather than counting rows itself', () => {
    // One place decides what "12 tracks (filtered)" says, and it is the
    // component that already renders it.
    expect(block).toContain('.tracktable .counts')
  })
})

describe('the filter chips open THE sheet', () => {
  const chip = (() => {
    const start = code.indexOf("closest?.('.chip[data-filterchip] > summary')")
    return code.slice(start, code.indexOf('}, true)', start))
  })()

  it('is delegated on one selector', () => {
    expect(chip.length).toBeGreaterThan(200)
    expect(code.match(/\.chip\[data-filterchip\] > summary/g)?.length).toBe(1)
  })

  it('uses openActionSheet — no sixth panel primitive', () => {
    expect(chip).toContain('openActionSheet(')
    expect(code.match(/export function openActionSheet/g)?.length).toBe(1)
  })

  it('cancels the disclosure, so the sheet is the only panel with JS', () => {
    expect(chip).toContain('e.preventDefault()')
  })

  it('builds its rows by READING the controls, not from a list of chips', () => {
    // Same discipline as openRowSheet: the sheet asks the chip what it
    // offers. So the Key chip's 24 keys and the Uploader chip's member
    // list need no code, and M8's genre facet will need none either.
    expect(code).toContain("CHIP_CONTROLS = 'select, input[type=\"checkbox\"]'")
    expect(code).toContain('menu.querySelectorAll(CHIP_CONTROLS)')
    for (const smell of ['key', 'bpm', 'tier', 'uploader', 'sort', 'location.pathname']) {
      expect(chip.toLowerCase(), `the chip sheet must not know about ${smell}`)
        .not.toContain(`'${smell}'`)
    }
  })

  it('writes into the real control and submits the form', () => {
    // Nothing here builds a URL: the form already serialises the whole
    // filter state, and a URL built here would be a second opinion about
    // what the page is showing.
    expect(chip).toMatch(/el\.value = value/)
    expect(chip).toContain('el.checked = !el.checked')
    expect(chip).toContain('form.requestSubmit()')
    // requestSubmit, never submit(): submit() fires no submit event, so
    // ClientRouter never sees it and the soft navigation becomes a hard one.
    expect(chip).not.toMatch(/form\.submit\(\)/)
  })

  it('escapes the control name it looks up', () => {
    expect(chip).toContain('CSS.escape(name)')
  })
})

describe('the no-JS submit is hidden only when there is JS', () => {
  it('adds has-instant on /pool, by attribute and not by pathname', () => {
    // A page-name test is a rule that cannot be moved, and it is the smell
    // sheet-single-source.test.ts already bans in openRowSheet.
    const fn = code.slice(code.indexOf('function revealInstantSearch'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain("classList.add('has-instant')")
    expect(body).toContain('poolRoot()')
    expect(body).not.toContain('pathname')
  })

  it('re-applies it after a soft navigation', () => {
    // `<script src>` modules evaluate once per document; a swapped-in page
    // body brings its own markup and none of this module's side effects.
    expect(code).toContain("astro:after-swap', revealInstantSearch")
  })

  it('the stylesheet hides the button under that class and not otherwise', () => {
    expect(read('styles/global.css')).toContain('.has-instant .poolsearch-go { display: none; }')
  })
})
