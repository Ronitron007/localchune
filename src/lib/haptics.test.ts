// src/lib/haptics.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// WHAT THIS FILE CAN AND CANNOT PROVE.
//
// vitest runs `environment: 'node'` here — there is no Document to build, so
// `attachHaptic` cannot be driven and `supportsSwitchHaptics` cannot be
// exercised. This is the same wall queue-wiring.test.ts hit, and the same
// answer: the DECISIONS were extracted into data (OVERLAY_ATTRS,
// OVERLAY_STYLE) and are asserted directly, and the WIRING is checked by
// reading the source.
//
//   It CAN pin the overlay's contract — that the control stays native, that
//   it is sized to the hit box rather than the border box, that it is
//   invisible to screen readers and to the Tab key, that it is unnamed and
//   so changes no POST body, and that nobody re-adds the script-triggered
//   `.click()` Apple removed in iOS 26.5.
//
//   It CANNOT prove a phone vibrates. The iOS Simulator has no Taptic
//   Engine and macOS Safari has no path to one. A green run here says the
//   DOM contract holds and says nothing about the tick. That evidence comes
//   from a physical iPhone on iOS 17.4+ against the deployed URL, tapping
//   each of the four controls — §8 of the design doc.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HAPTIC_ATTR, OVERLAY_ATTRS, OVERLAY_STYLE } from './haptics'

const SRC = new URL('..', import.meta.url).pathname
const HAPTICS = join(SRC, 'lib/haptics.ts')
const SITE = join(SRC, 'scripts/site.ts')

/** Source with block and line comments removed. Load-bearing exactly as it
 *  is in queue-wiring.test.ts: haptics.ts's own prose quotes every string
 *  the assertions below forbid. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
}

describe('the overlay attributes', () => {
  it('is a native iOS switch', () => {
    expect(OVERLAY_ATTRS.type).toBe('checkbox')
    expect(OVERLAY_ATTRS).toHaveProperty('switch')
  })

  it('is invisible to assistive tech and to the Tab key', () => {
    // Where we depart from tijnjh/ios-haptics, which sets neither: without
    // these, every haptic button gains an unlabeled checkbox in the a11y
    // tree and a keyboard user tabs into a control that does nothing.
    expect(OVERLAY_ATTRS['aria-hidden']).toBe('true')
    expect(OVERLAY_ATTRS.tabindex).toBe('-1')
  })

  it('is unnamed, so #player-like posts exactly what it posted before', () => {
    // Form submission includes only NAMED controls. This one assertion is
    // the whole reason the ♥ form's body is unchanged.
    expect(OVERLAY_ATTRS).not.toHaveProperty('name')
    expect(OVERLAY_ATTRS).not.toHaveProperty('value')
  })

  it('carries the idempotency marker', () => {
    expect(OVERLAY_ATTRS).toHaveProperty(HAPTIC_ATTR)
  })
})

describe('the overlay style', () => {
  it('hides the control WITHOUT un-nativing it', () => {
    // The native rendering is the haptic. `appearance: none` gives full
    // styling control, which means it is no longer a native switch, which
    // means there is no tick. opacity is the only legal way to hide it.
    expect(OVERLAY_STYLE.opacity).toBe('0')
    expect(OVERLAY_STYLE).not.toHaveProperty('appearance')
    expect(OVERLAY_STYLE).not.toHaveProperty('-webkit-appearance')
  })

  it('is sized to the hit box, not the border box', () => {
    // .likebtn's real tap target is its ::after extender at
    // max(100%, var(--tap)) — WIDER than its border box (global.css:806).
    // width:100% would sit inside that ring and the tick would fail at the
    // edges only, which reads as flaky rather than as broken.
    expect(OVERLAY_STYLE.width).toBe('max(100%, var(--tap))')
    expect(OVERLAY_STYLE.height).toBe('max(100%, var(--tap))')
    expect(OVERLAY_STYLE.top).toBe('50%')
    expect(OVERLAY_STYLE.left).toBe('50%')
    expect(OVERLAY_STYLE.transform).toBe('translate(-50%, -50%)')
  })

  it('reads the tap token rather than retyping the number', () => {
    for (const value of Object.values(OVERLAY_STYLE)) expect(value).not.toContain('44px')
  })

  it('does not clip its own hit area', () => {
    // Both upstreams clip to a pill to match a rounded button. This design
    // system is border-radius: 0 forever, so a pill clip would leave the
    // corners of a square control haptically dead.
    expect(OVERLAY_STYLE).not.toHaveProperty('clip-path')
  })

  it('establishes a containing block by being absolute', () => {
    expect(OVERLAY_STYLE.position).toBe('absolute')
  })
})

describe('the module keeps the shape iOS 26.5 left us', () => {
  const code = codeOf(HAPTICS)

  it('never triggers a haptic from script', () => {
    // Apple removed script-triggered haptics in iOS 26.5. A `.click()` here
    // would be a function that silently does nothing on every current
    // iPhone — and it is exactly what the abandoned libraries still ship.
    expect(code).not.toContain('.click(')
    expect(code).not.toContain('dispatchEvent')
  })

  it('never un-natives the control', () => {
    expect(code).not.toContain('appearance')
  })

  it('feature-detects instead of sniffing the user agent', () => {
    expect(code).toContain("'switch' in")
    expect(code).not.toContain('userAgent')
    expect(code).not.toContain('platform')
  })

  it('adds no event listener', () => {
    // The tap bubbles from the nested input to the button on its own. A
    // listener here would mean a second synthetic-click path through the
    // delegation ClientRouter also watches — the ♥ → 404 outage shape.
    expect(code).not.toContain('addEventListener')
  })
})

describe('the wiring, and its blast radius', () => {
  const site = codeOf(SITE)

  it('attaches to all four transport controls', () => {
    expect(site).toContain("from '../lib/haptics'")
    expect(site.match(/attachHaptic\(/g) ?? []).toHaveLength(4)
    for (const ref of ['toggle', 'nextBtn', 'drawerToggle', 'likebtn']) {
      expect(site).toMatch(new RegExp(`attachHaptic\\([^)]*${ref}`))
    }
  })

  it('is imported by site.ts and nothing else', () => {
    // The owner's constraint: one commit, revertible without breaking
    // anything else. That property is only true while this module has
    // exactly one consumer — a second importer makes `git revert` a
    // build break instead of a clean removal.
    const importers = walk(SRC)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.astro'))
      .filter((f) => f !== HAPTICS && f !== join(SRC, 'lib/haptics.test.ts'))
      .filter((f) => /from ['"][^'"]*\/haptics['"]/.test(readFileSync(f, 'utf8')))
    expect(importers).toEqual([SITE])
  })
})
