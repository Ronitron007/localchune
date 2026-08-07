// src/lib/overlay.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE SCRIM, AND ONE ANSWER TO "IS THE PAGE BEHIND THIS USABLE".
//
// OWNER, 2026-08-08: "when the queue drawer is enabled the background page
// must not be usable as with any queues… add an overlay like in other
// drawers." The queue drawer shipped without a scrim on a deliberate
// argument (it is non-modal, it survives filter navigation) and the owner
// overruled it: consistency with the sheet wins.
//
// THE FORK WAS ALREADY THERE, WHICH IS WHY THIS FILE EXISTS RATHER THAN A
// THIRD COPY. `.sheet-scrim` and `.searchoverlay-scrim` were byte-identical
// declarations under two names, in two files, and neither knew about the
// other. Adding the drawer's would have made three. They are one `.scrim`
// class and one builder now, and overlay-single-source.test.ts fails the
// build on a fourth.
//
// TWO THINGS, DELIBERATELY SEPARATE:
//
//   scrimEl()   the pixels — a dimmed sheet of glass that catches taps
//   lockPage()  the behaviour — the page behind stops scrolling and stops
//               being interactive at all
//
// They are separate because the three consumers need different amounts of
// each. The action sheet and the search overlay cover the ENTIRE viewport,
// so their scrim alone already blocks every pointer; they need the scroll
// lock and nothing more. The queue drawer deliberately leaves the player
// bar live outside its scrim — a member pausing while they read the queue
// is the whole reason the bar is persistent — so it needs the part a scrim
// cannot express: everything EXCEPT one subtree goes inert.
//
// NO `document` AT MODULE SCOPE. This module is imported by
// src/lib/search-overlay.ts, which is a deliberate dynamic import
// (search-bundle.test.ts), and it must never reach back into site.ts —
// that would be a cycle into the entry chunk.

/**
 * The dimmed sheet of glass. Callers own where it goes and what class
 * decides its layer; this owns what it looks like and that there is only
 * one of it.
 *
 * `is-open` is NOT set here. Every consumer mounts it transparent and
 * raises it on the next frame, because a scrim that appears at full
 * opacity in the frame it is inserted has nothing to fade from.
 */
export function scrimEl(...extraClasses: string[]): HTMLDivElement {
  const el = document.createElement('div')
  el.className = ['scrim', ...extraClasses].join(' ')
  return el
}

/**
 * How many locks are live. REFERENCE COUNTED, and that is not premature
 * generality — it is a bug that existed before this file.
 *
 * The player bar's crate button opens an action sheet while the queue
 * drawer is open. Both lock the page; whichever closes FIRST used to
 * restore `overflow` from its own saved value, so closing the sheet
 * unlocked scrolling underneath a drawer that was still up. With a count,
 * the page unlocks when the last overlay leaves and not before.
 */
let depth = 0
let savedOverflow = ''

/**
 * Make the page behind an overlay unusable, and return the undo.
 *
 * `keepLive`, when given, is the ONE subtree that stays interactive —
 * everything else that is a child of `<body>` at call time is marked
 * `inert`. Pass `null` for an overlay that covers the whole viewport with
 * its own scrim and therefore needs only the scroll lock.
 *
 * WHY `inert` AND NOT `aria-hidden` PLUS A FOCUS TRAP. They are not
 * equivalent and the difference is the point: `inert` removes pointer
 * events, focus AND the accessibility tree in one attribute, enforced by
 * the browser. A hand-rolled trap only covers Tab — it does nothing for a
 * screen reader's own cursor, for a rotor jump, or for a click on a
 * control the scrim does not happen to cover. It is also the only one of
 * the two that CANNOT drift out of sync with the scrim's geometry, which
 * matters here precisely because this drawer's scrim deliberately does not
 * cover everything. Support is not a live question: `inert` has been in
 * every current engine since 2023 (Chrome 102, Safari 15.5, Firefox 112),
 * and the failure mode without it is a page that is dimmed but still
 * clickable — degraded, not broken.
 *
 * Elements that were ALREADY inert are left alone and are not un-inerted
 * on release: this only ever undoes what it did.
 *
 * The returned function is idempotent. Call it twice and the second call
 * does nothing, so a caller re-applying across a navigation cannot drive
 * the count negative.
 */
export function lockPage(keepLive: HTMLElement | null = null): () => void {
  if (depth === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  depth += 1

  const mine: HTMLElement[] = []
  if (keepLive !== null) {
    // A snapshot of the children AT CALL TIME, which is what lets a caller
    // append its own scrim immediately afterwards and have it stay live.
    for (const child of [...document.body.children]) {
      if (!(child instanceof HTMLElement)) continue
      if (child === keepLive || child.contains(keepLive)) continue
      if (child.inert) continue
      child.inert = true
      mine.push(child)
    }
  }

  let released = false
  return () => {
    if (released) return
    released = true
    for (const el of mine) el.inert = false
    depth -= 1
    if (depth === 0) document.body.style.overflow = savedOverflow
  }
}

/** True while any overlay holds the page. Exported for tests and for a
 *  caller that needs to know whether it is the outermost one. */
export const isPageLocked = (): boolean => depth > 0
