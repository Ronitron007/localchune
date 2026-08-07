// src/scripts/drag-dismiss.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE SWIPE-DOWN GESTURE, EVERY PANEL THAT HAS ONE.
//
// The owner, 2026-08-07, about the queue drawer: "the current queue drawer
// cant be closed by dragging it down and that feels like a bummer… make it
// like the drawer component of add to crate". The add-to-crate drawer is
// the action sheet, and the sheet's swipe-down already existed — as fifty
// lines living INSIDE openActionSheet, reachable by nothing else.
//
// Copying those fifty lines onto the drawer is how this app would end up
// with two dismissal behaviours that drift: one that vetoes horizontal
// swipes and one that does not, one that respects a scroller and one that
// hijacks it. That is the two-navs incident and the two-sheets incident in
// their third costume, and the answer is the same one both times — extract
// it, and put a guard on the extraction.
//
// So this module is the DOM half of the gesture and src/lib/sheet.ts is the
// arithmetic half. Neither surface owns a threshold, an axis test or a
// velocity sample of its own; both get the recipe the UI study documents:
//
//   · dismiss past 30% of the panel's height, OR a flick over 0.5 px/ms
//   · |dx|/|dy| over 0.6 is a HORIZONTAL gesture and belongs to somebody
//     else — a carousel, or the browser's own back-swipe
//   · `transition: none` while a finger drives it, so the panel tracks 1:1
//   · a drag that starts inside a scroller only pulls when that scroller
//     is already at its top
//
// THE 20px EDGE DEAD ZONE IN THE STUDY IS DELIBERATELY NOT HERE. It exists
// for a horizontally-dragged drawer, where a drag from the left bezel is
// the iOS back gesture. This gesture is vertical-only and already refuses
// anything past the 0.6 axis ratio, and global.css sets
// `html { overscroll-behavior-x: none }` so a back-swipe cannot start
// inside a panel at all. A dead zone here would only cost the top-left
// 20px of a real handle.
//
// NO INLINE HANDLERS, EVER — every listener below is addEventListener on a
// node the caller already owns (survive-list #6: an inline `on…=` in this
// bundle trips Cloudflare's API WAF and 403s the deploy).

import { classifyGesture, shouldDismiss, velocityPxPerMs } from '../lib/sheet'

/**
 * A TEXT FIELD OWNS ITS OWN DRAG, on every surface, without the caller
 * having to remember. In the sheet's modal variant the scroller holds an
 * `<input>`, and a finger dragged across it is a member selecting text or
 * moving the caret — stealing that to dismiss the panel makes the field
 * unusable on the one device this gesture exists for. `scrollTop` is 0 in a
 * short modal, so the scroller check below would not have caught it.
 */
const OWN_DRAG = 'input, textarea'

export interface DragDismissOptions {
  /**
   * The node the finger moves. It receives `--drag-y` (the offset, NOT a
   * whole transform — the sheet's desktop rule adds a -50% X translation
   * for centring and an inline `transform` would silently drop it) and
   * `data-dragging="true"` while a gesture is live.
   *
   * Listeners go here too, so the whole panel is draggable and the handle
   * is an affordance rather than the only target.
   */
  panel: HTMLElement
  /**
   * The panel's scrolling region, if it has one. A drag that starts inside
   * it must be allowed to scroll it; only a scroller already at its top can
   * pull the panel down.
   */
  scroller?: HTMLElement | null
  /**
   * Extra selector whose subtree never starts a dismissal. The queue
   * drawer passes its reorder grips: a row drag and a panel dismiss are the
   * same finger going the same direction, and the row has to win — a member
   * moving a track to the bottom of the queue must not throw the queue away
   * doing it.
   */
  ignore?: string
  /** The gesture committed. The caller closes; this module never does. */
  onDismiss: () => void
}

/**
 * Wires the swipe-down. Returns a function that unwires it and leaves the
 * panel with no trace of the gesture on it.
 */
export function wireDragDismiss(opts: DragDismissOptions): () => void {
  const { panel, onDismiss } = opts
  const scroller = opts.scroller ?? null
  const skip = opts.ignore === undefined ? OWN_DRAG : `${OWN_DRAG},${opts.ignore}`

  let startY = 0
  let startX = 0
  let startT = 0
  let lastY = 0
  let lastT = 0
  let dragging = false
  let axis: ReturnType<typeof classifyGesture> = 'none'

  function stop(): void {
    dragging = false
    delete panel.dataset.dragging
    panel.style.removeProperty('--drag-y')
  }

  function onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return // a mouse drags nothing here
    const target = e.target as Element | null
    if (target?.closest?.(skip)) return
    if (scroller !== null && scroller.contains(target as Node) && scroller.scrollTop > 0) return
    dragging = true
    axis = 'none'
    startY = lastY = e.clientY
    startX = e.clientX
    startT = lastT = e.timeStamp
    panel.dataset.dragging = 'true'
  }

  function onMove(e: PointerEvent): void {
    if (!dragging) return
    const dy = e.clientY - startY
    const dx = e.clientX - startX
    if (axis === 'none') {
      axis = classifyGesture(dx, dy)
      // A sideways swipe belongs to somebody else. Let go of it rather
      // than half-tracking it.
      if (axis === 'horizontal') { stop(); return }
    }
    if (dy <= 0) return // dragging up: the panel is already at its top
    lastY = e.clientY
    lastT = e.timeStamp
    panel.style.setProperty('--drag-y', `${dy}px`)
  }

  function onUp(e: PointerEvent): void {
    if (!dragging) return
    const dy = e.clientY - startY
    const velocity = velocityPxPerMs(lastY - startY, lastT - startT)
    const height = panel.getBoundingClientRect().height
    // Cleared BEFORE the callback, never after: `onDismiss` may hide the
    // panel, and a `--drag-y` left on a hidden node is what the next open
    // would animate from.
    stop()
    if (shouldDismiss({ dy, panelHeight: height, velocity })) onDismiss()
  }

  panel.addEventListener('pointerdown', onDown)
  panel.addEventListener('pointermove', onMove)
  panel.addEventListener('pointerup', onUp)
  panel.addEventListener('pointercancel', onUp)

  return () => {
    panel.removeEventListener('pointerdown', onDown)
    panel.removeEventListener('pointermove', onMove)
    panel.removeEventListener('pointerup', onUp)
    panel.removeEventListener('pointercancel', onUp)
    stop()
  }
}
