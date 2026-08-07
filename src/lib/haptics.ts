// src/lib/haptics.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// A SYSTEM HAPTIC TICK ON THE FOUR TRANSPORT CONTROLS, ON iOS ONLY.
// Design: docs/superpowers/specs/2026-08-07-ios-safari-haptics-design.md.
//
// Safari has never shipped the Vibration API. Safari 17.4 added a
// non-standard `switch` attribute for checkboxes — `<input type=checkbox
// switch>` — and iOS plays a system tick when that control toggles. That
// control is the only route from a web page to the Taptic Engine.
//
// WHAT THIS IS NOT, and the history matters because it is the reason the
// module is this small. Until iOS 26.5 a script could call `.click()` on a
// hidden switch and fire a tick from anywhere. lochie/web-haptics (2.7k
// stars) did exactly that and is now abandoned and broken. **Apple patched
// script-triggered haptics in iOS 26.5, around May 2026.** Only a direct
// finger tap on the native control fires a tick now.
//
// So there is no `haptic()` function here to call, and there must never be
// one: a tick on track auto-advance or on upload completion is not
// available at any price, and code that tries is code that does nothing.
// haptics.test.ts fails the build if `.click(` appears in this file.
//
// The technique is credited to tijnjh/ios-haptics v3.1.1, which is the one
// maintained implementation. We do not depend on it: it nests with no
// `aria-hidden` and no `tabindex`, and it sizes the overlay at `width:
// 100%`, which is wrong for `.likebtn` here — see OVERLAY_STYLE.

/** Marks an overlay this module created. The idempotency key: .playerbar is
 *  transition:persist, so a soft navigation MOVES these nodes rather than
 *  recreating them, and any re-entry must not stack a second input. */
export const HAPTIC_ATTR = 'data-haptic'

/**
 * The overlay's attributes, as data so the contract is testable with no DOM
 * (vitest runs `environment: 'node'` — see queue-wiring.test.ts).
 *
 * `aria-hidden` and `tabindex` are where we deliberately depart from the
 * upstream library. Without them every haptic button gains an unlabeled
 * checkbox in the accessibility tree, and a keyboard user tabs into an
 * invisible control that does nothing. VoiceOver reports a switch as
 * "On"/"Off", which means nothing to a member pressing play.
 *
 * The input stays UNNAMED on purpose. #player-like is a real POST form, and
 * form submission includes only named controls — so the body sent to
 * /api/track/[id]/like is byte-for-byte what it was.
 */
export const OVERLAY_ATTRS: Readonly<Record<string, string>> = {
  type: 'checkbox',
  switch: '',
  [HAPTIC_ATTR]: '',
  'aria-hidden': 'true',
  tabindex: '-1',
}

/**
 * Two lines here are load-bearing and both have already been got wrong once
 * in this technique's short life.
 *
 * `opacity: 0` AND NEVER `appearance: none`. WebKit's own announcement is
 * explicit that with `appearance: none` "all properties will have their
 * initial values" — full styling control, which means the control is no
 * longer native. The native rendering IS the haptic. `opacity: 0` hides the
 * switch and keeps it native. This is the one declaration that silently
 * kills the feature if a later reader tidies it, so the test forbids the
 * string `appearance` in this file entirely.
 *
 * THE SIZE IS THE HIT BOX, NOT THE BORDER BOX. `.likebtn` already carries a
 * hit-area extender at global.css:806 — `::after` at
 * `max(100%, var(--tap))`, centred — because "♥ 12" is under 44px wide and
 * the visual box has to stay small in a dense row. Its real tap target is
 * therefore WIDER than its border box. An overlay at `width: 100%` sits
 * inside that ring, so a thumb landing in the outer band would like the
 * track and produce no tick: the haptic would work in the middle and fail
 * at the edges, which reads as "haptics are flaky" rather than as a bug.
 * Copying the extender's exact geometry fixes it, and costs nothing on the
 * other three targets — they already clear 44px, so `max(100%, var(--tap))`
 * resolves to `100%` there. One rule, four controls.
 *
 * `var(--tap)` and not `44px`: the token is declared in :root at
 * global.css:91 so it inherits into an inline style, and it is the single
 * place that number is allowed to live (global-tokens.test.ts guards it).
 *
 * NO `clip-path`. Both upstream implementations clip to
 * `inset(0 round 999px)` to match a pill-shaped button. This design system
 * is `border-radius: 0` on everything, forever — a pill clip on a square
 * control would leave the corners haptically dead. clip-path only ever
 * shrinks a hit area, so omitting it is what gives us the full rect.
 */
export const OVERLAY_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'max(100%, var(--tap))',
  height: 'max(100%, var(--tap))',
  margin: '0',
  opacity: '0',
  cursor: 'pointer',
  'touch-action': 'manipulation',
  '-webkit-tap-highlight-color': 'transparent',
}

/**
 * A real feature detect, not a user-agent sniff: the `switch` IDL attribute
 * reflects on HTMLInputElement in Safari 17.4+ and is absent everywhere
 * else. Android and desktop therefore receive no extra DOM node and no
 * invalid nesting — the whole module is inert there.
 */
export function supportsSwitchHaptics(doc: Document): boolean {
  return 'switch' in doc.createElement('input')
}

/**
 * Give `el` a system haptic tick when a finger taps it.
 *
 * The input is a CHILD of the target, not a sibling laid over it. That is
 * the entire reason this function adds no event listener: the tap lands on
 * the input, and the click bubbles to the button, so #player-toggle's own
 * listener and form.likeform's submit delegation keep working untouched.
 *
 * The sibling-overlay shape (project-fathom's) is valid HTML where this is
 * not — `button` forbids interactive descendants — but it swallows the tap
 * and needs the click forwarded by hand. A hand-forwarded click re-enters
 * the document-level delegation that ClientRouter also listens to, which is
 * precisely the shape of the "♥ → 404" double-POST outage of 2026-07-31
 * (site.ts:1356). We take invalid nesting in four runtime-created nodes
 * over a second synthetic-click path. Stated plainly so nobody "fixes" it
 * back into the outage.
 */
export function attachHaptic(el: Element | null | undefined): void {
  if (el == null) return
  const doc = el.ownerDocument
  if (doc === null || !supportsSwitchHaptics(doc)) return
  // Idempotent: see HAPTIC_ATTR. Direct children only, so a control nested
  // inside another haptic target could never read as already-done.
  if (el.querySelector(`:scope > input[${HAPTIC_ATTR}]`) !== null) return

  const input = doc.createElement('input')
  for (const [name, value] of Object.entries(OVERLAY_ATTRS)) input.setAttribute(name, value)
  // setProperty, not Object.assign(input.style, …): the record is CSS
  // property names, and `touch-action` / `-webkit-tap-highlight-color` have
  // no camelCase identity to assign to.
  for (const [prop, value] of Object.entries(OVERLAY_STYLE)) input.style.setProperty(prop, value)

  // Without this the overlay resolves against the nearest positioned
  // ancestor, which is .playerbar (position: fixed, global.css:1056) — an
  // absolutely-positioned child of an unpositioned button would cover the
  // WHOLE BAR and swallow every tap in it. `.likebtn` is already relative;
  // the other three are static.
  if (doc.defaultView?.getComputedStyle(el).position === 'static') {
    if (el instanceof (doc.defaultView.HTMLElement)) el.style.position = 'relative'
  }

  el.appendChild(input)
}
