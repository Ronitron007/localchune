// src/components/filter-chips.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// POOL.1 — ONE FILTER SECTION, AND IT HAS TO STAY ONE.
//
// The audit measured the old FilterBar at roughly 300px of chrome before
// the first track at 375px: five stacked fieldsets and labels laid out
// `flex-wrap`. On a 667px screen that is nearly half the window spent on
// controls, above a list.
//
// The number is a LAYOUT fact, so most of it is pinned in the stylesheet
// (crate-card.test.ts's precedent: pin the property that makes the defect
// impossible, in the file the defect lived in). What this file adds is the
// MARKUP half of the same promise:
//
//   1. There is exactly one filter section and it does not stack. No
//      `<fieldset>`, no `<legend>`, one `.filterchips` row.
//   2. Every chip works with NO JavaScript — it is a `<details>` with a
//      real control and a real submit inside it. site.ts cancels the
//      summary's click and opens the sheet; without JS the disclosure is
//      the panel. This is AppNav's ⋮ pattern, and the rule this repo holds
//      is that a control which would do nothing without JS must not be
//      visible without it.
//   3. The chip's VALUE is derived server-side from the same PoolQuery the
//      RPC was called with, so the chips describe the rows beneath them on
//      a shared link and with JS off.
//   4. There is no hidden mirror of the filter state. The native control
//      IS the state; a hidden input beside it would be a second copy, and
//      the member can see the chip but not the input.
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'
import FilterBar from './FilterBar.astro'
import { EMPTY_QUERY, type PoolQuery } from '../lib/pool-api'

type Renderable = Parameters<AstroContainer['renderToString']>[0]

const UPLOADERS = [
  { member_id: '11111111-1111-1111-1111-111111111111', uploader_name: 'ana', track_count: 12 },
  { member_id: '22222222-2222-2222-2222-222222222222', uploader_name: 'ben', track_count: 3 },
]

async function render(query: Partial<PoolQuery> = {}): Promise<string> {
  const container = await AstroContainer.create()
  return container.renderToString(FilterBar as Renderable, {
    props: { query: { ...EMPTY_QUERY, ...query }, uploaders: UPLOADERS },
  })
}

/** Every `<details class="chip">` in document order, by its data-filterchip. */
const chipNames = (html: string): string[] =>
  [...html.matchAll(/data-filterchip="([^"]+)"/g)].map((m) => m[1])

describe('the filters are one section, not a stack', () => {
  it('renders exactly one chip row', async () => {
    const html = await render()
    expect(html.match(/class="filterchips"/g)?.length).toBe(1)
  })

  it('renders no fieldset and no legend at all', async () => {
    // The two elements the old bar used to group its controls, and the
    // reason it stacked: a fieldset is a block box with a border and a
    // legend, five of them wrap, and five wrapped rows is 300px.
    const html = await render({ key: '8A', bpmMin: 120, tierMin: 3 })
    expect(html).not.toContain('<fieldset')
    expect(html).not.toContain('<legend')
  })

  it('carries the five filters the owner named, in one row', async () => {
    expect(chipNames(await render())).toEqual(['Key', 'BPM', 'Quality', 'Uploader', 'Sort'])
  })

  it('the search field is the first thing in the form', async () => {
    const html = await render()
    expect(html.indexOf('poolsearch-field')).toBeLessThan(html.indexOf('filterchips'))
  })
})

describe('a chip works with no JavaScript', () => {
  it('every chip is a <details> with a <summary>', async () => {
    const html = await render()
    // Five chips, five disclosures. A <button> here would be a control
    // that does nothing without JS, which this codebase refuses to ship.
    expect(html.match(/<details class="chip"/g)?.length).toBe(5)
    expect(html.match(/<summary class="chip-btn"/g)?.length).toBe(5)
  })

  it('every chip menu holds a real control and its own submit', async () => {
    const html = await render()
    const menus = [...html.matchAll(/<div class="chip-menu">([\s\S]*?)<\/div>\s*<\/details>/g)]
      .map((m) => m[1])
    expect(menus).toHaveLength(5)
    for (const menu of menus) {
      expect(menu).toMatch(/<select|<input/)
      expect(menu).toContain('type="submit"')
    }
  })

  it('the form is a GET to /pool, so the filter state IS the URL', async () => {
    const html = await render()
    expect(html).toContain('method="get"')
    expect(html).toContain('action="/pool"')
    expect(html).toContain('role="search"')
  })

  it('there is a submit for a member with no JS, hidden by CSS when there is', async () => {
    // `hidden` would be wrong: this must be usable without JavaScript. It
    // is `has-instant` on <html> that hides it, the same way `has-rowmenu`
    // hides the row controls the sheet replaces.
    const html = await render()
    expect(html).toContain('class="btn poolsearch-go"')
    expect(html).not.toMatch(/poolsearch-go[^>]*hidden/)
  })

  it('the sheet hook is on the summary, and it announces itself', async () => {
    const html = await render()
    expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(5)
  })
})

describe('a chip shows what it is filtering', () => {
  it('shows nothing when nothing is set', async () => {
    expect(await render()).not.toContain('chip-value')
  })

  // The VALUE, not the option list. Every label here is also an <option>
  // inside the chip's own menu, so a bare `toContain('8A')` would pass on
  // the menu alone and prove nothing about what the row displays.
  const value = (html: string): string[] =>
    [...html.matchAll(/class="chip-value[^"]*">([^<]*)</g)].map((m) => m[1])

  it('names the key, and marks a harmonic widening', async () => {
    expect(value(await render({ key: '8A' }))).toEqual(['8A'])
    expect(value(await render({ key: '8A', harmonic: true }))).toEqual(['8A+'])
  })

  it('reads a BPM range as a range, and a single bound as half-open', async () => {
    expect(value(await render({ bpmMin: 120, bpmMax: 130 }))).toEqual(['120–130'])
    expect(value(await render({ bpmMin: 120 }))).toEqual(['120+'])
    expect(value(await render({ bpmMax: 130 }))).toEqual(['≤130'])
  })

  it('names the tier and the uploader', async () => {
    expect(value(await render({ tierMin: 4 }))).toEqual(['T4+'])
    expect(value(await render({ uploader: UPLOADERS[0].member_id }))).toEqual(['ana'])
  })

  it('says nothing about a sort the page would have used anyway', async () => {
    // added_desc for an empty box, relevance for a typed one. A chip value
    // that repeats the default is noise on a row with a scroll budget.
    expect(value(await render())).toEqual([])
    expect(value(await render({ q: 'bicep', sort: 'relevance' }))).toEqual([])
  })

  it('names a sort the member chose', async () => {
    expect(value(await render({ sort: 'bpm_asc' }))).toEqual(['Tempo'])
  })

  it('shows every set filter at once, in chip order', async () => {
    const html = await render({ q: 'x', key: '8A', bpmMin: 120, tierMin: 3, sort: 'likes_desc' })
    expect(value(html)).toEqual(['8A', '120+', 'T3+', 'Likes'])
  })

  it('offers Best match only when there is something to rank', async () => {
    // With an empty box the RPC degrades relevance to added_desc, and a
    // chip that silently means something else is worse than a missing one.
    expect(await render()).not.toContain('Best match')
    expect(await render({ q: 'bicep' })).toContain('Best match')
  })

  it('gives the implied sort an EMPTY value, so the URL stays clean', async () => {
    // A select always submits something. `value="relevance"` would glue
    // `&sort=relevance` to every search URL and leave it there after the
    // box is cleared, where it means added_desc and the chip would read
    // "Best match" over a list sorted by date.
    const html = await render({ q: 'bicep' })
    expect(html).toMatch(/<option value=""[^>]*>\s*Best match/)
    expect(html).not.toMatch(/<option value="relevance"/)
  })

  it('offers Clear only when there is something to clear', async () => {
    expect(await render()).not.toContain('chip-reset')
    expect(await render({ q: 'x' })).toContain('chip-reset')
    expect(await render({ tierMin: 2 })).toContain('chip-reset')
  })
})

describe('the state lives in the controls, not in a mirror', () => {
  it('renders no hidden input at all', async () => {
    // The sheet writes `select.value` / `input.checked` and submits the
    // form; the form is what serialises. A hidden mirror would be a second
    // copy of the filter state, and the two would eventually disagree
    // about what the page is showing.
    const html = await render({ key: '8A', bpmMin: 120, tierMin: 3, sort: 'bpm_asc' })
    expect(html).not.toContain('type="hidden"')
  })

  it('the selected option carries the current value', async () => {
    const html = await render({ key: '8A', tierMin: 4 })
    expect(html).toMatch(/<option value="8A"[^>]*selected/)
    expect(html).toMatch(/<option value="4"[^>]*selected/)
  })

  it('the checkboxes reflect their flags', async () => {
    expect(await render({ harmonic: true })).toMatch(/name="harmonic"[^>]*checked/)
    expect(await render({ halfDouble: true })).toMatch(/name="half_double"[^>]*checked/)
  })

  it('never renders a cursor — a filter change starts at page one', async () => {
    // A keyset cursor is only valid inside the sort and predicate that
    // minted it. Carrying one through a filter change would page into the
    // middle of a different answer.
    expect(await render({ q: 'x', key: '8A' })).not.toContain('name="cursor"')
  })

  it('the uploader options carry each member id and their count', async () => {
    const html = await render()
    for (const u of UPLOADERS) {
      expect(html).toContain(`value="${u.member_id}"`)
      expect(html).toContain(`${u.uploader_name} (${u.track_count})`)
    }
  })
})

describe('the field itself', () => {
  it('is a search input with the search keyboard', async () => {
    const html = await render()
    expect(html).toContain('type="search"')
    expect(html).toContain('name="q"')
    expect(html).toContain('enterkeyhint="search"')
  })

  it('turns autocorrect off', async () => {
    // A DJ types artist names the dictionary has never seen, and "Mochakk"
    // silently becoming "Mocha" is a search that answers a different
    // question.
    const html = await render()
    expect(html).toContain('autocorrect="off"')
    expect(html).toContain('autocapitalize="off"')
    expect(html).toContain('autocomplete="off"')
  })

  it('carries the current query back into the box', async () => {
    expect(await render({ q: 'mochakk' })).toContain('value="mochakk"')
  })

  it('names itself for assistive tech, since the icon is decorative', async () => {
    expect(await render()).toContain('aria-label="Search the pool"')
  })

  it('teaches the tokens in its placeholder', async () => {
    // Nothing else in the app hints that `128` or `8A` mean anything here,
    // and a tempo or key query is otherwise undiscoverable.
    expect(await render()).toMatch(/placeholder="[^"]*128[^"]*8A/)
  })
})
