// src/components/app-nav.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The nav's four load-bearing properties, pinned as source assertions.
// Three of them fail SILENTLY if they regress — no build error, no test
// elsewhere — which is exactly the shape of failure survive-list #7 is a
// list of.
//
// It reads the component as TEXT. `AppNav.astro` renders from
// `Astro.locals.member`, so rendering it through a container would mean
// faking a member, a session and an RPC result to assert three static
// facts about the markup.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nav = readFileSync(new URL('./AppNav.astro', import.meta.url), 'utf8')
const site = readFileSync(new URL('../scripts/site.ts', import.meta.url), 'utf8')

describe('the owner-only links', () => {
  // AppNav has always OMITTED /review and /admin for a member rather than
  // rendering them disabled — "a disabled link is a promise with no
  // delivery date, and it tells a non-owner that an admin page exists."
  // The destination sheet must not become the loophole that leaks them.
  for (const href of ['/review', '/admin']) {
    it(`${href} renders only inside an owner branch`, () => {
      const at = nav.indexOf(`href="${href}"`)
      expect(at, `${href} must be rendered`).toBeGreaterThan(-1)
      // The nearest preceding conditional opener has to be the owner test.
      const before = nav.slice(0, at)
      expect(before.lastIndexOf("m.role === 'owner'"))
        .toBeGreaterThan(before.lastIndexOf('<nav'))
    })
  }

  it('the sheet is built from the rendered links, never from a role in JS', () => {
    // The sheet reads the nav's own anchors. That is what makes the
    // omission automatic: there is no second list of destinations for a
    // role check to get wrong, and nothing in the bundle knows what an
    // owner is.
    expect(site).toContain('[data-navlink]')
    expect(site).not.toMatch(/role\s*===\s*'owner'/)
  })
})

describe('sign-out stays a native POST full navigation', () => {
  // survive-list #11. The response clears the auth cookies, and only a
  // full document load tears down every persisted island with them — a
  // fetch-based sign-out would leave the player holding a dead session.
  it('the form carries data-astro-reload', () => {
    const form = nav.match(/<form[^>]*\/auth\/signout[^>]*>/)?.[0] ?? ''
    expect(form, 'the sign-out form must exist').not.toBe('')
    expect(form).toContain('data-astro-reload')
    expect(form).toContain('method="post"')
  })

  it('the sheet row submits that same form rather than fetching', () => {
    // requestSubmit() fires a real submit event, so ClientRouter sees the
    // data-astro-reload opt-out and stands aside; form.submit() would NOT
    // fire the event and would bypass it.
    expect(site).toMatch(/id === 'signout'.*requestSubmit\(\)/)
    expect(site).not.toMatch(/fetch\([^)]*auth\/signout/)
  })
})

describe('the menu works without JavaScript', () => {
  // The destination sheet is JS-only, and below 640px the links are the
  // only navigation there is. A <details> whose open state reveals them
  // is the fallback: site.ts preventDefault()s the summary click and
  // opens the sheet instead, so the disclosure never opens WITH JS and is
  // the whole menu WITHOUT it. No `hidden` attribute, so no flash.
  it('the trigger is a summary inside a details, not a button', () => {
    expect(nav).toMatch(/<details class="navmenu"/)
    expect(nav).toMatch(/<summary[^>]*class="navmenu-btn"/)
  })

  it('site.ts cancels the disclosure and opens the sheet', () => {
    const at = site.indexOf('navmenu-btn')
    expect(at).toBeGreaterThan(-1)
    const handler = site.slice(at, at + 2600)
    expect(handler).toContain('preventDefault()')
    expect(handler).toContain('openActionSheet')
  })
})
