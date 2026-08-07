// src/scripts/drag-dismiss-single-source.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE SWIPE-DOWN, TWO PANELS, AND NO SECOND COPY OF IT.
//
// THE NAMED PRECEDENT IS THE TWO-NAVS INCIDENT AND ITS SEQUEL, the two
// sheets: this app grew a second navigation and nearly grew a second row
// menu, both times because a behaviour was typed out rather than rendered
// from one place, and both times NOTHING FAILED — two navs are valid HTML
// and two dismissal gestures are valid JavaScript.
//
// The gesture has the same shape of risk and a nastier failure mode,
// because a divergence here is invisible in a screenshot and invisible in
// a build. A second copy that forgot the 0.6 axis test closes the drawer on
// a sideways swipe. One that forgot the scroller check closes it when a
// member scrolls their own queue. One that drifted from 30% to 50% teaches
// a member a gesture that then does not work on the other panel. Every one
// of those ships green.
//
// So the defence is structural, exactly as it is for the ⋮: ONE module owns
// the DOM half, src/lib/sheet.ts owns the arithmetic half, and both panels
// consume them. This file pins that.
//
// Every assertion reads CODE, never prose — withoutComments() exists
// because five guards in this repo have already failed on a comment
// documenting the very thing they guard.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '../lib/source-scan'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const module_ = read('scripts/drag-dismiss.ts')
const site = read('scripts/site.ts')
const sheet = read('lib/sheet.ts')
const css = read('styles/global.css')

const moduleCode = withoutComments(module_)
const siteCode = withoutComments(site)
const cssCode = withoutComments(css)

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

describe('the swipe-down has exactly one implementation', () => {
  it('drag-dismiss.ts exports wireDragDismiss, once', () => {
    expect(count(moduleCode, /export function wireDragDismiss/g)).toBe(1)
  })

  it('site.ts reaches the gesture only through it', () => {
    expect(siteCode).toContain("from './drag-dismiss'")
    // Not "at least once" — EXACTLY the two panels that have one. A third
    // call is not automatically wrong, but it is a decision somebody must
    // make on purpose, and this line is where they will be asked to.
    expect(count(siteCode, /wireDragDismiss\(/g)).toBe(2)
  })

  it('site.ts owns no gesture arithmetic of its own', () => {
    // The three functions that DECIDE a panel has been thrown away. If any
    // of them is called from site.ts, a second implementation is being
    // assembled there — which is how the two would drift while both kept
    // importing "the shared maths".
    for (const fn of ['classifyGesture', 'shouldDismiss', 'velocityPxPerMs']) {
      expect(siteCode, `${fn} belongs to drag-dismiss.ts`).not.toContain(fn)
    }
  })

  it('site.ts never writes the drag offset directly', () => {
    // `--drag-y` is the contract between the module and the CSS. A write
    // from anywhere else is a panel being moved by something that did not
    // consult a threshold.
    expect(siteCode).not.toContain('--drag-y')
    expect(count(moduleCode, /--drag-y/g)).toBeGreaterThan(0)
  })

  it('site.ts binds no pointer listener that could be a second gesture', () => {
    for (const evt of ['pointerdown', 'pointermove', 'pointercancel']) {
      expect(siteCode, `${evt} belongs to drag-dismiss.ts`).not.toContain(evt)
    }
  })

  it('the thresholds live in sheet.ts and are imported, never re-typed', () => {
    expect(moduleCode).toContain("from '../lib/sheet'")
    // The literals themselves must appear in exactly one module.
    expect(sheet).toContain('DISMISS_FRACTION = 0.3')
    expect(sheet).toContain('FLICK_PX_PER_MS = 0.5')
    expect(sheet).toContain('HORIZONTAL_RATIO = 0.6')
    for (const literal of ['0.3', '0.5', '0.6']) {
      expect(moduleCode, 'import the constant instead').not.toContain(literal)
    }
  })
})

describe('both panels wear the same handle', () => {
  it('one CSS rule declares it, and it is not the sheet\'s alone', () => {
    expect(count(cssCode, /^\.grabhandle \{/gm)).toBe(1)
    expect(cssCode).not.toContain('.sheet-handle')
  })

  it('the bar keeps its 36x4 shape — the min-* floor is still zeroed', () => {
    // THIS EXACT BUG HAS BEEN PAID FOR. The 44px floor is declared on the
    // `input, select, button` TYPE selector, so `height: 4px` overrides it
    // while `min-height: 44px` is a DIFFERENT PROPERTY and survives —
    // rendering the handle as a 44px grey block instead of a bar. The hit
    // box comes back from the ::after, which is where it belongs.
    const rule = cssCode.slice(cssCode.indexOf('.grabhandle {'))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('height: 4px')
    expect(body).toContain('min-height: 0')
    expect(body).toContain('min-width: 0')
  })

  it('and still offers a 44px target from the ::after', () => {
    const rule = cssCode.slice(cssCode.indexOf('.grabhandle::after'))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('var(--tap)')
  })

  it('the sheet builds it and the drawer renders it, both by that name', () => {
    expect(siteCode).toContain("handle.className = 'grabhandle'")
    expect(withoutComments(read('layouts/Shell.astro'))).toContain('class="grabhandle"')
  })
})

describe('the drawer can still hide itself', () => {
  it('declares .queuedrawer[hidden] — the sixth [hidden] defeat in this file', () => {
    // A `display` on the element BEATS the UA sheet's `[hidden] { display:
    // none }`, and the drawer grew `display: flex` the day it grew a grab
    // handle (the handle and the head must not scroll away with the list).
    // Measured consequence, frame by frame, before the rule was added: a
    // dismissed drawer slid off the bottom, was set `hidden`, and then
    // animated smoothly BACK to its open position and stayed there — while
    // every assertion about `drawer.hidden` passed.
    expect(cssCode).toMatch(/\.queuedrawer\[hidden\] \{ display: none; \}/)
  })

  it('and the rule that made it necessary is still there', () => {
    // The inverse: if the `display` ever goes away this guard should be
    // read as obsolete rather than as protection.
    const rule = cssCode.slice(cssCode.indexOf('.queuedrawer {'))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('display: flex')
  })

})

describe('the gesture is allowed to happen at all — touch-action', () => {
  // THIS IS NOT A POLISH RULE. Measured against unmodified main with real
  // touch events: `pointerdown`, ONE `pointermove`, then `pointercancel`.
  // The browser decides a vertical touch is a scroll and takes the gesture
  // before the second sample, so the panel never moves and never
  // dismisses — with the drag code entirely correct and simply never run.
  // The sheet had shipped that way; the drawer reproduced it on day one.
  //
  // BOTH PANELS, THE SAME PAIR OF DECLARATIONS: `none` on the panel so the
  // browser cannot claim the drag, `pan-y` on the scroller inside it so the
  // list still scrolls. `.queuerow-drag` already carried the same line for
  // the same reason on the same axis.
  const ruleBody = (selector: string): string => {
    const at = cssCode.indexOf(selector)
    expect(at, `${selector} exists`).toBeGreaterThan(-1)
    return cssCode.slice(at, cssCode.indexOf('}', at))
  }

  it.each(['.queuedrawer {', '.sheet-panel {'])('%s cannot have the drag stolen', (sel) => {
    expect(ruleBody(sel)).toContain('touch-action: none')
  })

  it.each(['.queuesections {', '.sheet-list,'])('%s still scrolls', (sel) => {
    expect(ruleBody(sel)).toContain('touch-action: pan-y')
  })
})

describe('one CSS rule stops the transition while a finger drives it', () => {
  it('covers both panels', () => {
    // Without this the transition fights the drag and the panel lags the
    // finger by a whole 280ms — the single most obvious way a "native"
    // gesture reads as broken.
    const rule = /\.sheet-panel\[data-dragging='true'\],\s*\.queuedrawer\[data-dragging='true'\] \{ transition: none; \}/
    expect(cssCode).toMatch(rule)
  })

  it('and the attribute it keys off is written by the shared module only', () => {
    expect(moduleCode).toContain("panel.dataset.dragging = 'true'")
    expect(siteCode).not.toContain('dataset.dragging')
  })
})
