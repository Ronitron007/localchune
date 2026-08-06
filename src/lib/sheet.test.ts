// src/lib/sheet.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The sheet's decisions, tested at their boundaries. Every one of these
// is a number a finger will land exactly on eventually, and "roughly
// right" is how a dismissal gesture becomes unpredictable.

import { describe, expect, it } from 'vitest'
import {
  DISMISS_FRACTION,
  FLICK_PX_PER_MS,
  HORIZONTAL_RATIO,
  PANEL_MS,
  classifyGesture,
  exitDelayMs,
  nextFocusIndex,
  normalizeRows,
  shouldDismiss,
  velocityPxPerMs,
} from './sheet'

describe('classifyGesture', () => {
  // |dx| / |dy| > 0.6 is a horizontal gesture and the sheet ignores it.
  // Without this a member swiping a carousel or triggering the browser's
  // back-swipe would close the sheet by accident.
  it('is vertical at exactly the ratio — the boundary is NOT horizontal', () => {
    expect(classifyGesture(60, 100)).toBe('vertical')
  })

  it('is horizontal just past the ratio', () => {
    expect(classifyGesture(61, 100)).toBe('horizontal')
  })

  it('treats a pure sideways drag as horizontal even with zero dy', () => {
    expect(classifyGesture(40, 0)).toBe('horizontal')
  })

  it('reports none when the finger has not moved', () => {
    expect(classifyGesture(0, 0)).toBe('none')
  })

  it('ignores the sign of dx — left and right are both horizontal', () => {
    expect(classifyGesture(-80, 10)).toBe('horizontal')
  })

  it('classifies an upward drag as vertical, sign and all', () => {
    expect(classifyGesture(5, -100)).toBe('vertical')
  })

  it('exposes the ratio it uses', () => {
    expect(HORIZONTAL_RATIO).toBe(0.6)
  })
})

describe('shouldDismiss', () => {
  const panelHeight = 400 // 30% = 120px

  it('does not dismiss at exactly 30% — "past 30%" is strict', () => {
    expect(shouldDismiss({ dy: 120, panelHeight, velocity: 0 })).toBe(false)
  })

  it('dismisses one pixel past 30%', () => {
    expect(shouldDismiss({ dy: 121, panelHeight, velocity: 0 })).toBe(true)
  })

  it('does not dismiss at exactly the flick velocity', () => {
    expect(shouldDismiss({ dy: 10, panelHeight, velocity: FLICK_PX_PER_MS })).toBe(false)
  })

  it('dismisses on a flick even when the drag barely moved', () => {
    // The whole point of the velocity branch: a fast flick from the top
    // of the panel should close it without travelling 30% of its height.
    expect(shouldDismiss({ dy: 10, panelHeight, velocity: 0.51 })).toBe(true)
  })

  it('never dismisses on an upward drag, however fast', () => {
    expect(shouldDismiss({ dy: -300, panelHeight, velocity: 4 })).toBe(false)
    expect(shouldDismiss({ dy: 0, panelHeight, velocity: 4 })).toBe(false)
  })

  it('scales with the panel — a short panel closes on a shorter drag', () => {
    expect(shouldDismiss({ dy: 61, panelHeight: 200, velocity: 0 })).toBe(true)
    expect(shouldDismiss({ dy: 61, panelHeight: 800, velocity: 0 })).toBe(false)
  })

  it('treats a zero-height panel as un-dismissable by distance', () => {
    // Guards the frame before layout: 30% of 0 is 0, and every drag would
    // otherwise be "past" it.
    expect(shouldDismiss({ dy: 5, panelHeight: 0, velocity: 0 })).toBe(false)
  })

  it('exposes the fraction it uses', () => {
    expect(DISMISS_FRACTION).toBe(0.3)
  })
})

describe('velocityPxPerMs', () => {
  it('is distance over time', () => {
    expect(velocityPxPerMs(100, 200)).toBe(0.5)
  })

  it('is always positive — direction is shouldDismiss\'s job', () => {
    expect(velocityPxPerMs(-100, 200)).toBe(0.5)
  })

  it('returns 0 rather than Infinity when no time passed', () => {
    // Two pointer samples in the same millisecond are common on a 120Hz
    // screen, and Infinity would dismiss the sheet on every one of them.
    expect(velocityPxPerMs(50, 0)).toBe(0)
    expect(velocityPxPerMs(50, -1)).toBe(0)
  })
})

describe('exitDelayMs', () => {
  it('waits out the panel transition normally', () => {
    expect(exitDelayMs(false)).toBe(PANEL_MS)
  })

  it('collapses to 0 under reduced motion', () => {
    // The CSS block already flattens the transition to 0.01ms. Without
    // this the JS would still hold the node mounted for 280ms with
    // nothing happening, and the sheet would feel BROKEN rather than
    // fast — which is the opposite of what the preference asked for.
    expect(exitDelayMs(true)).toBe(0)
  })
})

describe('normalizeRows', () => {
  it('drops nulls so a caller can build rows conditionally', () => {
    const rows = normalizeRows([
      { id: 'a', label: 'Play' },
      null,
      { id: 'b', label: 'Queue' },
      undefined,
    ])
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('flags the last row, which is the one that loses its divider', () => {
    const rows = normalizeRows([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
    expect(rows.map((r) => r.isLast)).toEqual([false, true])
  })

  it('keeps the first of a duplicate id — a menu with two "like" rows is a bug', () => {
    const rows = normalizeRows([
      { id: 'like', label: 'Like' },
      { id: 'like', label: 'Like again' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('Like')
  })

  it('drops a row with no label rather than rendering an empty target', () => {
    expect(normalizeRows([{ id: 'a', label: '   ' }])).toEqual([])
  })

  it('returns an empty array for an empty input, not a single blank row', () => {
    expect(normalizeRows([])).toEqual([])
  })

  it('preserves order, icon, meta and the danger flag', () => {
    const rows = normalizeRows([
      { id: 'dl', label: 'Download', icon: 'download', meta: '8.4 MB' },
      { id: 'rm', label: 'Remove', danger: true },
    ])
    expect(rows[0]).toMatchObject({ id: 'dl', icon: 'download', meta: '8.4 MB' })
    expect(rows[1]).toMatchObject({ id: 'rm', danger: true })
  })
})

describe('nextFocusIndex', () => {
  // The focus trap. A sheet that lets Tab escape to the page behind it is
  // a sheet a keyboard user cannot get out of, because the page they
  // tabbed into is inert to their eyes.
  it('moves forward', () => {
    expect(nextFocusIndex(0, 4, 1)).toBe(1)
  })

  it('wraps forward off the end, back to the first row', () => {
    expect(nextFocusIndex(3, 4, 1)).toBe(0)
  })

  it('wraps backward off the start, round to the last row', () => {
    expect(nextFocusIndex(0, 4, -1)).toBe(3)
  })

  it('stays put when there is nothing to move to', () => {
    expect(nextFocusIndex(0, 1, 1)).toBe(0)
    expect(nextFocusIndex(0, 0, 1)).toBe(0)
  })

  it('recovers from an index that is no longer in range', () => {
    // The row list can shrink under the trap — a "remove from crate" row
    // that disappears when the sheet re-renders.
    expect(nextFocusIndex(99, 3, 1)).toBe(0)
    expect(nextFocusIndex(-5, 3, 1)).toBe(0)
  })
})
