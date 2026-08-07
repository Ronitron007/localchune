// src/lib/player-status.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
import { describe, expect, it } from 'vitest'
import {
  MARQUEE_PX_PER_MS, MARQUEE_SETTLE_MS, MARQUEE_SLOP_PX, MARQUEE_TAIL_MS,
  NAME_CYCLE_MAX_MS, NAME_CYCLE_MIN_MS, NAME_PAN_FRACTION,
  NAME_PX_PER_MS, STATUS_HOLD_MS, STATUS_MAX_MS,
  marqueeOffsetPx, marqueePlan, nameMarqueeMs, shouldMarquee,
} from './player-status'

describe('the status strip stays long enough to read', () => {
  it('a message that fits holds for the reading window and never moves', () => {
    expect(marqueePlan(0)).toEqual({ settleMs: 0, scrollMs: 0, totalMs: STATUS_HOLD_MS })
    expect(marqueePlan(-40)).toEqual({ settleMs: 0, scrollMs: 0, totalMs: STATUS_HOLD_MS })
  })

  it('a measurement that never happened is treated as "it fits"', () => {
    // A detached or not-yet-laid-out node reports NaN. NaN in a setTimeout
    // delay becomes 0, and the strip would flash instead of holding.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(marqueePlan(bad).totalMs).toBe(STATUS_HOLD_MS)
      expect(marqueePlan(bad).scrollMs).toBe(0)
    }
  })

  it('an overflowing message pans at the declared speed, once', () => {
    const plan = marqueePlan(100)
    expect(plan.scrollMs).toBe(Math.ceil(100 / MARQUEE_PX_PER_MS))
    expect(plan.settleMs).toBe(MARQUEE_SETTLE_MS)
    expect(plan.totalMs).toBe(MARQUEE_SETTLE_MS + plan.scrollMs + MARQUEE_TAIL_MS)
  })

  it('holds longer the further it has to pan', () => {
    expect(marqueePlan(200).totalMs).toBeGreaterThan(marqueePlan(50).totalMs)
  })

  it('is gone by the ceiling however absurd the message', () => {
    // A crate named by pasting a paragraph must not pin the strip over the
    // bar for a minute.
    expect(marqueePlan(100_000).totalMs).toBe(STATUS_MAX_MS)
    expect(marqueePlan(10_000).totalMs).toBeLessThanOrEqual(STATUS_MAX_MS)
  })

  it('pans LEFT, and not at all when it fits', () => {
    expect(marqueeOffsetPx(120)).toBe(-120)
    expect(marqueeOffsetPx(0)).toBe(0)
    expect(marqueeOffsetPx(Number.NaN)).toBe(0)
  })
})

describe('a line only moves when it actually overflows', () => {
  const base = { reducedMotion: false }

  it('does not move when the text fits', () => {
    expect(shouldMarquee({ ...base, scrollWidth: 100, clientWidth: 100 })).toBe(false)
    expect(shouldMarquee({ ...base, scrollWidth: 80, clientWidth: 100 })).toBe(false)
  })

  it('ignores sub-pixel overflow', () => {
    // scrollWidth and clientWidth are integers over a fractional layout, so
    // a line that fits exactly reports a pixel of overflow about half the
    // time. Animating by one pixel is motion with no purpose.
    expect(shouldMarquee({ ...base, scrollWidth: 100 + MARQUEE_SLOP_PX, clientWidth: 100 }))
      .toBe(false)
    expect(shouldMarquee({ ...base, scrollWidth: 100 + MARQUEE_SLOP_PX + 1, clientWidth: 100 }))
      .toBe(true)
  })

  it('moves when the text is genuinely wider', () => {
    expect(shouldMarquee({ ...base, scrollWidth: 400, clientWidth: 180 })).toBe(true)
  })

  it('REDUCED MOTION WINS, at any amount of overflow', () => {
    // Non-negotiable: a member who asked for less motion gets ellipsis.
    expect(shouldMarquee({ scrollWidth: 4000, clientWidth: 10, reducedMotion: true })).toBe(false)
  })

  it('refuses to measure a box that has no width yet', () => {
    // A hidden or not-yet-laid-out line reports clientWidth 0, against
    // which every text is "overflowing".
    expect(shouldMarquee({ ...base, scrollWidth: 300, clientWidth: 0 })).toBe(false)
    expect(shouldMarquee({ ...base, scrollWidth: Number.NaN, clientWidth: 100 })).toBe(false)
  })
})

describe('the track name cycles, and the cycle is bounded', () => {
  it('does not move when there is no overflow', () => {
    expect(nameMarqueeMs(0)).toBe(0)
    expect(nameMarqueeMs(-10)).toBe(0)
    expect(nameMarqueeMs(Number.NaN)).toBe(0)
  })

  it('pans at a constant speed rather than a constant duration', () => {
    // The whole reason the duration is derived: a title twice as long must
    // move at the same speed, not in the same time.
    // Both inside the clamp window, which is 160px..320px of overflow —
    // outside it the CLAMP is what decides, on purpose, because the DWELL
    // is what the bounds are chosen for.
    const a = 200
    const b = 300
    const panA = (nameMarqueeMs(a) * NAME_PAN_FRACTION)
    const panB = (nameMarqueeMs(b) * NAME_PAN_FRACTION)
    expect(nameMarqueeMs(a)).toBeGreaterThan(NAME_CYCLE_MIN_MS)
    expect(nameMarqueeMs(b)).toBeLessThan(NAME_CYCLE_MAX_MS)
    expect(a / panA).toBeCloseTo(NAME_PX_PER_MS, 3)
    expect(b / panB).toBeCloseTo(NAME_PX_PER_MS, 3)
  })

  it('never twitches and never becomes ambient', () => {
    expect(nameMarqueeMs(1)).toBe(NAME_CYCLE_MIN_MS)
    expect(nameMarqueeMs(100_000)).toBe(NAME_CYCLE_MAX_MS)
  })

  it('keeps the dwell where the owner asked for it, at every length', () => {
    // "a dwell at the start of each cycle (~2s) so the beginning is
    // readable rather than perpetually sliding". The dwell is a fixed
    // fraction of the cycle, so it is the CLAMP that has to hold this — and
    // it is why the bounds are chosen for the dwell rather than the pan.
    for (const overflow of [1, 40, 200, 320, 900, 5000]) {
      const dwell = nameMarqueeMs(overflow) * NAME_PAN_FRACTION
      expect(dwell, `dwell at ${overflow}px`).toBeGreaterThanOrEqual(2000)
      expect(dwell, `dwell at ${overflow}px`).toBeLessThanOrEqual(4000)
    }
  })
})
