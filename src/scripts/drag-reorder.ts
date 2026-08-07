// src/scripts/drag-reorder.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * THE ONLY MODULE THAT IMPORTS THE DRAG LIBRARY, and it is loaded on demand.
 *
 * site.ts reaches this file through `import('./drag-reorder')` and nothing
 * else does, so `@formkit/drag-and-drop` — 8.7 KB gzip — sits in a chunk of
 * its own. The shell every signed-in page loads, `/login`, and a `/pool` a
 * member only reads gain ZERO bytes from it. `drag-bundle.test.ts` bundles
 * site.ts for real and proves that rather than asserting it.
 *
 * WHY A LIBRARY AT ALL, having shipped a hand-written one. The crate page's
 * reorder was native HTML5 drag-and-drop, and native HTML5 drag DOES NOT FIRE
 * ON TOUCH — the whole feature was invisible on a phone, which is the audit's
 * offender #3. Of the four candidates measured in the Phase 3 report, the
 * smallest (`@atlaskit/pragmatic-drag-and-drop`, 6.9 KB) is built on that same
 * dead API and contains zero occurrences of `touchstart` or `touchmove`; it
 * would have shipped 6.9 KB that changes nothing on the target device. This
 * one carries a Pointer Events path for touch and native drag for the desktop.
 *
 * THIS MODULE KNOWS NOTHING ABOUT THE QUEUE. It reports "the row that was at
 * index A is now at index B" and stops. The queue engine's invariants — one
 * `reduce` call, events carrying the rendered array, reordering that touches
 * layer 1 only — live in site.ts and queue-engine.ts, where they are guarded.
 * A drag module that dispatched engine events would be a second code path
 * into the reducer, and there is exactly one.
 *
 * ONE REPORT PER COMPLETED DRAG, NEVER PER POSITION. The library sorts live:
 * it moves the real DOM node as the pointer passes each neighbour, and calls
 * `setValues` every time. Reporting from there would dispatch six engine
 * events for a drag across six rows — six reduces, six regenerations, and five
 * intermediate orders nobody asked for. `setValues` therefore writes to a
 * local mirror and says nothing; `onDragend` fires exactly once, including on
 * a cancel, and that is the only thing that speaks.
 */

import { dragAndDrop } from '@formkit/drag-and-drop'

export interface DragList {
  /** The element whose direct children are the sortable rows. */
  parent: HTMLElement
  /** A stable id per row, in the order they are rendered. */
  ids: readonly string[]
  /**
   * Selector for the grab affordance INSIDE each row. Required, not optional.
   * Without a handle the whole row is the drag surface, and on touch that
   * fights the scroll: a finger dragged down a queue means "scroll" far more
   * often than it means "reorder", and the library cannot tell which until it
   * has already swallowed the gesture. A handle makes the answer unambiguous
   * before the first pointermove — touch the handle to drag, touch anywhere
   * else to scroll or to play.
   */
  handle: string
  /**
   * Called ONCE per completed drag, with indices into `ids`.
   *
   * `from === to` for a cancelled drag or one that ended where it began, and
   * it is still reported: the caller re-renders from its own state on that
   * signal, which is what restores the row order the library moved.
   */
  onDrop: (from: number, to: number, id: string) => void
}

/**
 * Make `parent`'s children sortable by dragging their handles.
 *
 * Safe to call again on the same element — the library tears the previous
 * registration down itself — which is what lets the queue drawer re-wire the
 * fresh `<ul>` it builds on every render.
 */
export function wireDragList({ parent, ids, handle, onDrop }: DragList): void {
  // The mirror. The library owns this array during a drag and rewrites it on
  // every position change; nothing outside this function ever READS it, which
  // is precisely what keeps the churn from reaching the engine.
  let values = [...ids]

  /**
   * The order as it stood when the current gesture began, or null between
   * gestures.
   *
   * IT IS NOT TAKEN FROM `onDragstart`, AND THAT IS THE WHOLE POINT. The
   * library fires `onDragstart` from its NATIVE drag path only — the
   * synthetic pointer path that exists for touch never calls it. Reading the
   * source index there gives a reorder that works perfectly on a desktop and
   * silently does nothing on a phone, which is precisely the failure this
   * feature was written to end, reintroduced one layer up. Verified in a
   * browser, not read off the docs: a touch drag sorted the list and reported
   * no move at all.
   *
   * A pointerdown on the handle starts BOTH paths, so snapshotting there is
   * the one signal that covers them equally.
   */
  let before: string[] | null = null

  parent.addEventListener('pointerdown', (e) => {
    const t = e.target
    if (t instanceof Element && t.closest(handle) !== null) before = [...values]
  }, true)

  /**
   * id -> element, bound ONCE, positionally. `ids` is documented as being in
   * render order, so the Nth id is the Nth child, and the elements keep their
   * identity for the life of this wiring — only their order changes. Binding
   * here rather than reading an attribute per call keeps this module ignorant
   * of what the rows are: it never learns that they are tracks.
   */
  const byId = new Map<string, Element>()
  ;[...parent.children].forEach((el, i) => {
    const id = ids[i]
    if (id !== undefined) byId.set(id, el)
  })

  /**
   * THE LIBRARY DOES NOT MOVE THE DOM, and finding that out cost the crate
   * page a silent bug. `performSort` computes the new order and hands it to
   * `setValues` — that is the whole of it. Every framework binding this
   * package ships works because the framework re-renders the list from those
   * values; with no framework there is nobody to do it, so a drag sorted an
   * array nobody could see and the rows never moved at all. The crate's POST
   * reads its order back out of the DOM, so it would have persisted the
   * ORIGINAL order, on a page that looked like nothing had happened, with no
   * error anywhere.
   *
   * One walk, and `insertBefore` only where the order actually differs:
   * re-appending every child on every pointer move is a mutation storm, and
   * the library re-reads its node list when the parent mutates.
   */
  const applyOrder = (order: readonly string[]): void => {
    let ref: Element | null = parent.firstElementChild
    for (const id of order) {
      const el = byId.get(id)
      if (el === undefined) continue
      if (el === ref) {
        ref = el.nextElementSibling
        continue
      }
      parent.insertBefore(el, ref)
    }
  }

  dragAndDrop<string>({
    parent,
    getValues: () => values,
    setValues: (next) => {
      values = next
      // The "render" a framework binding would do. It is the visible feedback
      // too: the real row moves under the finger, which is why no animation
      // plugin is needed and why nothing here has to be undone for a member
      // who asked for reduced motion.
      applyOrder(next)
    },
    config: {
      dragHandle: handle,
      // Two classes, one for the native path and one for the touch path, and
      // the same rule behind both: opacity and an outline, never a transform.
      // The transport exception says a control under a finger must not travel,
      // and the library is already moving the real node — a lift or a shadow
      // here would be a second motion fighting the first.
      draggingClass: 'is-dragging',
      synthDraggingClass: 'is-dragging',
      dropZoneClass: 'is-over',
      // No animation plugin. The library moves the real node, which IS the
      // feedback; the FLIP tween on top of it is bytes for motion that the
      // global prefers-reduced-motion block would then have to take away
      // again. Not shipping it is the cheaper way to honour that rule and
      // the only one that cannot be got wrong.
      onDragend: ({ values: after, draggedNode }) => {
        const snapshot = before
        before = null
        const id: unknown = draggedNode?.data?.value
        if (snapshot === null || typeof id !== 'string') return
        const start = snapshot.indexOf(id)
        if (start < 0) return
        // A row the mirror cannot find is reported as "did not move" rather
        // than as index -1, so the caller's restore path runs and the visible
        // order snaps back to whatever the state actually says.
        const landed = after.indexOf(id)
        onDrop(start, landed < 0 ? start : landed, id)
      },
    },
  })
}
