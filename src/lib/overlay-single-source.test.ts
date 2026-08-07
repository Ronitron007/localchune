// src/lib/overlay-single-source.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE SCRIM, AND ONE ANSWER TO "IS THE PAGE BEHIND THIS USABLE".
//
// THE FORK WAS ALREADY THERE WHEN THE THIRD CONSUMER ARRIVED, which is the
// whole argument for this file. `.sheet-scrim` and `.searchoverlay-scrim`
// were byte-identical declarations under two names, in two files, neither
// aware of the other — the two-navs incident in its quietest form, because
// two identical scrims look exactly like one scrim until somebody changes
// the alpha on one of them.
//
// The owner then asked for a third: "when the queue drawer is enabled the
// background page must not be usable as with any queues… add an overlay
// like in other drawers." Three copies would have been the point of no
// return, so they became one class and one builder instead.
//
// Every assertion reads CODE — withoutComments() exists because five guards
// here have already failed on a comment documenting what they guard, and
// the prose above names every string this file forbids.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './source-scan'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const overlay = withoutComments(read('lib/overlay.ts'))
const site = withoutComments(read('scripts/site.ts'))
const css = withoutComments(read('styles/global.css'))

// POOL.1 RETIRED THE SEARCH OVERLAY — the third consumer this file was
// written to unify is gone, not un-unified. `/pool` is the search page now,
// so the sheet and the queue drawer are the two consumers left and both
// live in site.ts. Every assertion below keeps its exact meaning; it simply
// has one fewer file to check. The `.searchoverlay-scrim` name stays in the
// forbidden list on purpose: a rule about what nobody may reintroduce does
// not stop applying when the last user of the name goes away.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx|astro)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : []
  })
}

describe('the scrim has one builder', () => {
  it('overlay.ts exports it, once', () => {
    expect(overlay.match(/export function scrimEl/g)?.length).toBe(1)
    expect(overlay).toContain("'scrim'")
  })

  it('every existing consumer was converted rather than left alone', () => {
    // Both of them are in site.ts: the bottom action sheet (`scrimEl()`)
    // and the queue drawer (`scrimEl('queuescrim')`, which takes an extra
    // class because it is the one scrim that does not cover the bar).
    // Counting the calls is what stops "converted" meaning "one of the two",
    // and matching the OPEN PAREN rather than `()` is what stops it missing
    // the one that takes an argument.
    expect(site.match(/scrimEl\(/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('nothing types a scrim class of its own any more', () => {
    // The two names that used to exist. A file that reintroduces either —
    // or invents a third — is building a second scrim.
    const offenders = sourceFiles(SRC)
      .filter((f) => /sheet-scrim|searchoverlay-scrim|-scrim'|-scrim"/.test(
        withoutComments(readFileSync(f, 'utf8')),
      ))
      .map((f) => f.slice(SRC.length))
    expect(offenders, 'use scrimEl() from src/lib/overlay.ts').toEqual([])
  })

  it('one CSS rule declares what a scrim looks like', () => {
    expect(css.match(/^\.scrim \{/gm)?.length).toBe(1)
    expect(css).not.toContain('.sheet-scrim')
    expect(css).not.toContain('.searchoverlay-scrim')
    const rule = css.slice(css.indexOf('.scrim {'))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('background: var(--scrim)')
    // No backdrop-filter, ever — global-tokens.test.ts bans it repo-wide
    // and this is the one element anybody would be tempted to put it on.
    expect(body).not.toContain('backdrop-filter')
    // A fading scrim must stop swallowing clicks the moment it starts
    // leaving, or a member meets a 280ms dead zone.
    expect(body).toContain('pointer-events: none')
  })
})

describe('the page lock is counted, and shared', () => {
  it('overlay.ts owns it, once', () => {
    expect(overlay.match(/export function lockPage/g)?.length).toBe(1)
  })

  it('nobody else touches body overflow', () => {
    // THE BUG THIS FIXES: a sheet opened from the player bar over an open
    // queue drawer restored ITS OWN snapshot on close and unlocked the page
    // under a drawer that was still up. A count is the only thing that gets
    // nesting right.
    const offenders = sourceFiles(SRC)
      .filter((f) => f !== join(SRC, 'lib/overlay.ts'))
      .filter((f) => /body\.style\.overflow/.test(withoutComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length))
    expect(offenders, 'call lockPage() from src/lib/overlay.ts').toEqual([])
  })

  it('every consumer releases what it takes', () => {
    for (const [name, source] of [['site.ts', site]] as const) {
      expect(source, `${name} must lock`).toContain('lockPage(')
      expect(source, `${name} must release`).toMatch(/release\w*\(\)/)
    }
  })

  it('the drawer is the only one that keeps a subtree live', () => {
    // The sheet covers the whole viewport, so its scrim already blocks
    // every pointer and `null` is correct. The queue drawer deliberately
    // leaves the player bar usable, which is the one thing a scrim cannot
    // express — hence `inert` on everything else.
    expect(site).toContain('lockPage(null)')
    expect(site).toContain('lockPage(bar)')
  })

  it('uses `inert` rather than a hand-rolled focus trap', () => {
    // aria-hidden plus a Tab trap is not equivalent: it does nothing for a
    // screen reader's own cursor or a rotor jump, and it cannot stay in
    // sync with a scrim that deliberately does not cover everything.
    expect(overlay).toContain('.inert = true')
    expect(overlay).toContain('.inert = false')
  })

  it('only ever un-inerts what it inerted', () => {
    const body = overlay.slice(overlay.indexOf('export function lockPage'))
    expect(body).toContain('if (child.inert) continue')
    expect(body).toContain('mine.push(child)')
  })
})

describe('the drawer scrim sits under the bar and over the page', () => {
  it('the ladder declares the rung, and the bar claims the one above it', () => {
    expect(css).toContain('--z-scrim: 35;')
    expect(css).toContain('--z-player: 40;')
    // --z-player was declared and applied to NOTHING before this. The scrim
    // only works because the bar now actually claims it.
    const bar = css.slice(css.indexOf('.playerbar {'))
    expect(bar.slice(0, bar.indexOf('}'))).toContain('z-index: var(--z-player)')
    expect(css).toContain('.queuescrim { z-index: var(--z-scrim); }')
  })

  it('the transport stays clickable — the scrim never covers the bar', () => {
    // Stated as the ordering it is: scrim 35 < player 40. A scrim that
    // covered the bar would take the play button with it, and pausing while
    // reading the queue is the thing a member most wants there.
    const ladder = css.slice(css.indexOf('--z-rowmenu'), css.indexOf('--z-dialog'))
    const scrim = /--z-scrim: (\d+)/.exec(ladder)?.[1]
    const player = /--z-player: (\d+)/.exec(ladder)?.[1]
    expect(Number(scrim)).toBeLessThan(Number(player))
  })

  it('the scrim goes up and comes down with the drawer, from one place', () => {
    expect(site).toContain('function applyDrawerOverlay')
    expect(site).toContain('function clearDrawerOverlay')
    const setter = site.slice(site.indexOf('function setDrawerOpen'))
    const body = setter.slice(0, setter.indexOf('\n}') + 2)
    expect(body).toContain('applyDrawerOverlay()')
    expect(body).toContain('clearDrawerOverlay()')
  })

  it('the scrim is appended AFTER the lock, or it inerts itself', () => {
    // lockPage snapshots <body>'s children. A scrim appended first would be
    // marked inert and would stop accepting the tap that closes the drawer.
    const fn = site.slice(site.indexOf('function applyDrawerOverlay'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body.indexOf('lockPage(bar)')).toBeLessThan(body.indexOf('appendChild(scrim)'))
  })

  it('a soft navigation re-applies all of it', () => {
    // The drawer survives inside transition:persist; the scrim node, the
    // inert flags and the overflow lock all belonged to the <body> that was
    // replaced.
    const at = site.indexOf("document.addEventListener('astro:after-swap', () => {\n  document.body.classList.toggle('queueopen'")
    expect(at).toBeGreaterThan(-1)
    const handler = site.slice(at, site.indexOf('\n})', at))
    expect(handler).toContain('applyDrawerOverlay()')
    expect(handler).toContain('clearDrawerOverlay()')
    expect(handler).toContain('syncDrawerHeight()')
  })
})
