// src/lib/sheet.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The bottom action sheet's PURE half: the gesture maths, the dismissal
// predicates, the row model and the focus-trap arithmetic. No `document`
// and no `window` — src/scripts/site.ts owns every DOM call, exactly as
// queue-model.ts and play-meter.ts already split.
//
// The sheet itself is the owner's "modals and three dot menus", built
// ONCE and reused by the nav, every row's ⋮, the filter panel and the
// crate picker. Building it per surface is how an app ends up with four
// dismissal behaviours, and a member who has learned one of them.

import type { IconName } from './icons'

/** Panel enter/exit duration. Mirrors --dur-panel in global.css. */
export const PANEL_MS = 280

/**
 * A downward drag past this fraction of the panel's height dismisses it.
 * Strictly past: a drag that stops exactly on the line springs back, so
 * the boundary always resolves the same way instead of depending on a
 * sub-pixel.
 */
export const DISMISS_FRACTION = 0.3

/**
 * …or a flick faster than this, in px per ms, regardless of distance.
 * Without the velocity branch a quick flick from the top of a tall panel
 * would have to travel most of the screen before it counted.
 */
export const FLICK_PX_PER_MS = 0.5

/**
 * |dx| / |dy| past this is a HORIZONTAL gesture and the sheet ignores it
 * entirely. A member swiping sideways — a carousel, or the browser's own
 * back-swipe — must not close a menu by accident.
 */
export const HORIZONTAL_RATIO = 0.6

export type Gesture = 'horizontal' | 'vertical' | 'none'

/**
 * Which axis the finger is committed to. `none` means it has not moved,
 * which is a tap and not a drag.
 */
export function classifyGesture(dx: number, dy: number): Gesture {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax === 0 && ay === 0) return 'none'
  // ay === 0 with any dx is purely sideways — the ratio would divide by
  // zero, and the answer is obvious without it.
  if (ay === 0) return 'horizontal'
  return ax / ay > HORIZONTAL_RATIO ? 'horizontal' : 'vertical'
}

/** Absolute speed. Never Infinity: two samples inside one millisecond are
 *  ordinary on a 120Hz screen, and Infinity would dismiss on every one. */
export function velocityPxPerMs(distance: number, dtMs: number): number {
  if (dtMs <= 0) return 0
  return Math.abs(distance) / dtMs
}

/**
 * Close, or spring back.
 *
 * `dy` is positive downward. An upward drag never dismisses however fast
 * it is — dragging a sheet UP is a member trying to see more of it.
 */
export function shouldDismiss(input: {
  dy: number
  panelHeight: number
  velocity: number
}): boolean {
  const { dy, panelHeight, velocity } = input
  if (dy <= 0) return false
  if (velocity > FLICK_PX_PER_MS) return true
  // A zero-height panel is the frame before layout. Every drag would be
  // "past" 30% of nothing, so distance cannot decide here.
  if (panelHeight <= 0) return false
  return dy > panelHeight * DISMISS_FRACTION
}

/**
 * How long to keep the node mounted after the exit class goes on.
 *
 * Zero under reduced motion. The global CSS block already flattens the
 * transition to 0.01ms, but the JS timeout is a SEPARATE clock — left at
 * 280ms it would hold a finished sheet on screen, which reads as broken
 * rather than as fast, and that is the opposite of what the preference
 * asked for.
 */
export function exitDelayMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : PANEL_MS
}

/** One row of a sheet. `href` makes it a link; otherwise it is a button. */
export interface SheetRowInput {
  id: string
  label: string
  icon?: IconName
  /** Trailing text: a size, a count, a current value. */
  meta?: string
  href?: string
  danger?: boolean
  disabled?: boolean
  /** Rendered pressed, for a toggle row such as "like". */
  pressed?: boolean
}

export interface SheetRow extends SheetRowInput {
  /** The last row loses its divider — a list is one object, not N boxes. */
  isLast: boolean
}

/**
 * Cleans a caller's row list so a surface can build rows conditionally
 * (`isOwner && {…}`) without guarding every entry, and so the divider
 * rule is decided in one place rather than in six templates.
 */
export function normalizeRows(
  rows: readonly (SheetRowInput | null | undefined | false)[],
): SheetRow[] {
  const seen = new Set<string>()
  const kept: SheetRowInput[] = []
  for (const row of rows) {
    if (!row) continue
    if (row.label.trim() === '') continue
    // A menu with two rows carrying the same id is a bug in the caller,
    // and the second one would win every delegated lookup by accident.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    kept.push(row)
  }
  return kept.map((row, i) => ({ ...row, isLast: i === kept.length - 1 }))
}

/**
 * The next focusable row, wrapping at both ends — the focus trap. A sheet
 * that lets Tab escape to the page behind it is a sheet a keyboard user
 * cannot get out of, because the page they landed in is invisible to them
 * under the scrim.
 *
 * An out-of-range `current` returns to the first row rather than throwing:
 * the row list can shrink under the trap when a sheet re-renders.
 */
export function nextFocusIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return 0
  if (!Number.isInteger(current) || current < 0 || current >= count) return 0
  return (current + delta + count) % count
}
