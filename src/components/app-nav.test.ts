// src/components/app-nav.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The nav's two non-negotiables, pinned by reading the source rather than
// by rendering it: the owner-only links must stay OMITTED (not disabled),
// and the sign-out form must stay a native POST that a full document load
// completes. Both are survive-list items, and both fail silently — a
// disabled Admin link still looks fine, and a fetch-based sign-out still
// appears to work while leaving the player holding a dead session.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nav = readFileSync(new URL('./AppNav.astro', import.meta.url), 'utf8')
const site = readFileSync(new URL('../scripts/site.ts', import.meta.url), 'utf8')

describe('owner-only destinations', () => {
  it.each(['/review', '/admin'])('%s renders only under an owner branch', (href) => {
    const at = nav.indexOf(`href="${href}"`)
    expect(at, `${href} link must exist`).toBeGreaterThan(-1)
    // The nearest preceding conditional must be the owner test. A
    // disabled link is a promise with no delivery date, and it tells a
    // non-owner that an admin page exists.
    const before = nav.slice(0, at)
    expect(before.lastIndexOf("m.role === 'owner'")).toBeGreaterThan(before.lastIndexOf('</nav>'))
  })

  it('never renders a disabled destination', () => {
    expect(nav).not.toMatch(/<a[^>]*\bdisabled\b/)
    expect(nav).not.toMatch(/<a[^>]*aria-disabled/)
  })
})

describe('sign out', () => {
  it('is a POST form carrying data-astro-reload', () => {
    expect(nav).toMatch(/<form[^>]*method="post"[^>]*action="\/auth\/signout"[^>]*data-astro-reload/)
  })

  it('is reachable by id, because the sheet triggers the same form', () => {
    expect(nav).toContain('id="signout-form"')
  })

  it('the sheet submits that form rather than fetching', () => {
    // survive-list #11: the response clears the auth cookies, and only a
    // full document load tears down every persisted island with them. A
    // fetch would leave the player holding a dead session.
    expect(site).toContain("querySelector<HTMLFormElement>('#signout-form')?.requestSubmit()")
    const around = site.slice(site.indexOf("id !== 'signout'"), site.indexOf('#signout-form') + 400)
    expect(around).not.toContain('fetch(')
  })
})

describe('the compact bar', () => {
  it('ships the ⋮ hidden — it does nothing without JS', () => {
    const at = nav.indexOf('id="nav-menu"')
    expect(at).toBeGreaterThan(-1)
    expect(nav.slice(at, at + 260)).toContain('hidden')
  })

  it('unhides the ⋮ and hides the link list in ONE function', () => {
    // Doing one without the other strands a member with no navigation at
    // all: the class hides every destination and the unhide is the only
    // way back to them.
    const fn = site.slice(site.indexOf('function revealNavMenu'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('menu.hidden = false')
    expect(body).toContain("classList.add('is-compact')")
  })

  it('re-runs the reveal after a soft navigation', () => {
    // The nav is NOT inside transition:persist, so ClientRouter replaces
    // it and the fresh markup ships hidden again.
    expect(site).toContain("document.addEventListener('astro:after-swap', revealNavMenu)")
  })

  it('reads its destinations from the DOM, never from a second list', () => {
    // The owner-only omission is respected for free this way, and the
    // review badge comes along with it. A hard-coded list here would be a
    // second place for the destinations to drift.
    const at = site.indexOf("closest<HTMLElement>('#nav-menu')")
    const block = site.slice(at, at + 1200)
    expect(block).toContain(".appnav-links a")
    for (const href of ['/pool', '/upload', '/crates', '/merges', '/admin']) {
      expect(block, `${href} must not be hard-coded in the sheet builder`).not.toContain(`'${href}'`)
    }
  })
})
