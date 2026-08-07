// src/lib/player-status.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE PLAYER BAR'S STATUS STRIP: how long it stays, and how far it pans.
//
// THE BUG THIS COMES FROM, in the owner's words and with a screenshot: the
// bar read "already in It just goes and goes" and NEVER went away. The
// track title and its link were gone with it, so the track page could not
// be reached from the bar at all. A second instance: "artist — song name —
// 21 of 100 pool", equally permanent.
//
// The cause was structural rather than a missing timeout. `#player-label`
// was BOTH the now-playing identity and the one aria-live status region,
// and a status write did `label.textContent = text` — which detaches every
// child, the title anchor included. Shell.astro's own comment called those
// messages "transient". Nothing ever restored the identity, so every one
// of them was permanent until the next track change.
//
// A restore-after-timeout would have fixed the symptom. The owner asked for
// the better shape instead: put the message on its own strip above the bar,
// let it leave on its own, and never let it touch the title. That makes the
// bug IMPOSSIBLE rather than fixed — there is no code path from a status
// message to the identity any more, and player-label-single-source.test.ts
// asserts there is not.
//
// This module is the arithmetic half, with no `document` in it, exactly as
// sheet.ts is for the panel gesture. src/scripts/site.ts owns the DOM.

/**
 * How long a message that FITS stays on screen.
 *
 * Four seconds, and it is a reading-speed number rather than a round one.
 * Comfortable prose reading is around 200 wpm — call it 3.3 words a second.
 * The longest ordinary message here is a crate confirmation of about six
 * words ("already in Friday Warmup"), so the words themselves cost under
 * two seconds. The rest is the part people forget to budget: roughly a
 * second before a member's eye arrives at something that just appeared in
 * their peripheral vision, and enough slack afterwards that the strip is
 * not already leaving as they finish.
 *
 * It can afford to be generous now in a way it never could before. The
 * strip hides NOTHING — the title, the artist, the ♥, the transport are all
 * still there underneath it — so a longer message costs a member nothing.
 * The old design had to be short because the message was standing where the
 * track name should be.
 */
export const STATUS_HOLD_MS = 4000

/** A beat before a long message starts moving, so the first words can be
 *  read from a standing start rather than while they are already sliding. */
export const MARQUEE_SETTLE_MS = 700

/**
 * The pan speed, in pixels per millisecond. 50 px/s.
 *
 * Slow, deliberately. This is not a stock ticker; it is one pass over a
 * message a member is trying to read, and a fast pan is unreadable at
 * 375px where the whole strip is about 340px wide.
 */
export const MARQUEE_PX_PER_MS = 0.05

/** A dwell on the last words before the strip leaves. Without it the end of
 *  a long message is on screen for exactly zero milliseconds. */
export const MARQUEE_TAIL_MS = 900

/**
 * However long the message, the strip is gone by this. A pathological
 * value — a crate named by pasting a paragraph — must not pin the strip
 * over the bar for a minute.
 */
export const STATUS_MAX_MS = 12_000

export interface MarqueePlan {
  /** Pause before the pan starts. Zero when nothing needs to pan. */
  settleMs: number
  /** How long the pan itself takes. Zero when the message fits. */
  scrollMs: number
  /** Total time on screen, from shown to dismissed. */
  totalMs: number
}

/**
 * ONE PASS, NEVER A LOOP.
 *
 * §"nothing loops" in the motion doctrine is not a stylistic preference —
 * global-tokens.test.ts fails the build on an infinite animation anywhere in
 * the stylesheet. A looping marquee is also the specific thing that makes a
 * banner impossible to read: the eye has no fixed point to start from. So a
 * message that overflows pans exactly once, to its end, and stops there
 * until the strip leaves.
 *
 * `overflowPx` is how much wider the text is than the strip. Zero or less
 * means it fits, and a message that fits does not move at all.
 *
 * Defensive on the input because it comes from a measurement: a detached or
 * not-yet-laid-out node reports NaN, and NaN would propagate into a
 * setTimeout delay, where it becomes 0 and the strip flashes.
 */
export function marqueePlan(overflowPx: number): MarqueePlan {
  if (!Number.isFinite(overflowPx) || overflowPx <= 0) {
    return { settleMs: 0, scrollMs: 0, totalMs: STATUS_HOLD_MS }
  }
  const scrollMs = Math.ceil(overflowPx / MARQUEE_PX_PER_MS)
  const totalMs = Math.min(
    MARQUEE_SETTLE_MS + scrollMs + MARQUEE_TAIL_MS,
    STATUS_MAX_MS,
  )
  return { settleMs: MARQUEE_SETTLE_MS, scrollMs, totalMs }
}

/**
 * How far the text has to travel: negative, because it moves LEFT to reveal
 * its tail. Clamped at zero so a message that fits never gets a transform
 * at all — a `translate3d(0,0,0)` would still promote it to its own
 * compositor layer for no reason.
 */
export function marqueeOffsetPx(overflowPx: number): number {
  if (!Number.isFinite(overflowPx) || overflowPx <= 0) return 0
  return -Math.ceil(overflowPx)
}

/* ================================================================== */
/* THE TRACK NAME'S OWN MARQUEE — owner, 2026-08-08: "also can the track
 * name also have a marquee", and then, on the shape of it: "loop forever,
 * car-stereo style."
 *
 * The bar's two name lines have always ellipsised, and on a phone a long
 * title is mostly ellipsis. Same measurement as the strip above, opposite
 * motion, and the difference is the point:
 *
 *   the STATUS STRIP pans ONCE and leaves. It is transient by nature —
 *   four seconds and gone — so a loop would be motion with nothing left to
 *   reveal.
 *
 *   the TRACK NAME loops for as long as the track plays. It is not
 *   transient: a member looks up at it thirty seconds in, a minute in, at
 *   the end. Anything that stops leaves a permanently truncated middle at
 *   whatever moment they happen to look, which is the complaint being
 *   answered. A car stereo has had this exactly right for forty years.
 *
 * ══ A DELIBERATE, OWNER-APPROVED EXCEPTION TO "NOTHING LOOPS" ══════════
 * The design system's motion doctrine says nothing loops, and
 * global-tokens.test.ts enforces it by banning `infinite` outright. This
 * animation is the ONE exception and the ban has been amended to name it —
 * see the test, which now allows `name-marquee` by name and still fails on
 * any other infinite animation. That is deliberate: an exception that sits
 * undeclared is indistinguishable from a mistake, and the next person to
 * read the doctrine would "fix" this.
 *
 * The doctrine's real target is ambient motion nobody asked for. This was
 * asked for, it is confined to a line that would otherwise be unreadable,
 * it never runs on a title that fits, it never runs under reduced motion,
 * and it pauses while the queue drawer is open. Those five conditions are
 * what make it an exception rather than a hole. */

/**
 * Sub-pixel slop, in CSS pixels.
 *
 * `scrollWidth` is an INTEGER and `clientWidth` is an integer, but the
 * layout behind them is fractional, so a line that fits exactly reports one
 * pixel of overflow about as often as not. Without this, a title that fits
 * would animate by one pixel — motion with no purpose, which is the worst
 * kind.
 */
export const MARQUEE_SLOP_PX = 2

/**
 * Does this line need to move?
 *
 * Reduced motion is checked FIRST and is absolute: a member who has asked
 * for less motion gets ellipsis, always, and no amount of overflow changes
 * that. It is not a preference the app gets to weigh against legibility.
 */
export function shouldMarquee(input: {
  scrollWidth: number
  clientWidth: number
  reducedMotion: boolean
}): boolean {
  const { scrollWidth, clientWidth, reducedMotion } = input
  if (reducedMotion) return false
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) return false
  // A zero-width box is a node that is hidden or not laid out yet. Every
  // measurement against it is meaningless and would report the whole text
  // as overflow.
  if (clientWidth <= 0) return false
  return scrollWidth - clientWidth > MARQUEE_SLOP_PX
}

/**
 * The name pans faster than the status strip: 80 px/s against 50.
 *
 * They are different jobs. The strip gets ONE pass and a member has to read
 * it while it moves, so it crawls. The name comes back — that is the whole
 * point of cycling — so the pan is a reveal rather than the reading itself,
 * and the reading happens during the dwell at each end.
 */
export const NAME_PX_PER_MS = 0.08

/**
 * The keyframe shape, as fractions of one cycle:
 *
 *   0% – 25%    hold at the start   (the words that matter most)
 *   25% – 50%   pan to the end
 *   50% – 75%   hold at the end
 *   75% – 100%  pan back
 *
 * Fixed in the stylesheet, which is what lets ONE `@keyframes` block serve
 * every length — only the duration and the distance vary, and both are
 * custom properties. Symmetric on purpose: an out-pan and a back-pan at
 * different speeds reads as a stutter.
 *
 * THERE-AND-BACK RATHER THAN SNAP-AND-REPEAT, which is the one place this
 * departs from a literal car stereo. A cycle that jumps from the end of the
 * text back to its start has a hard cut in it; panning back means the loop
 * has no seam at all, and the dwell the owner asked for lands naturally at
 * the top of every cycle instead of immediately after a jump.
 */
export const NAME_PAN_FRACTION = 0.25

/**
 * Bounds, and they are chosen for the DWELL rather than for the pan.
 *
 * The owner asked for "a dwell at the start of each cycle (~2s) so the
 * beginning is readable rather than perpetually sliding". The dwell is a
 * fixed quarter of the cycle (see NAME_PAN_FRACTION and the keyframe shape
 * it describes), so a cycle between 8s and 16s puts that dwell between 2s
 * and 4s — right where it was asked to be at the short end, and generously
 * long for a title so long that reading its opening takes a while anyway.
 *
 * Inside the window the pan speed is constant, which is what makes a long
 * title and a slightly long one feel like the same object. Outside it the
 * clamp wins on purpose: below it the cycle would twitch, above it a single
 * pass would take most of a minute and stop being a marquee.
 */
export const NAME_CYCLE_MIN_MS = 8000
export const NAME_CYCLE_MAX_MS = 16_000

/**
 * One there-and-back cycle, in milliseconds, for a line overflowing by
 * `overflowPx`. Zero means "does not move".
 *
 * Derived from the pan speed rather than picked: the pan occupies a fixed
 * quarter of the cycle, so `cycle = panMs / 0.25`, and the dwells fall out
 * of the same arithmetic. That is what keeps a long title and a slightly
 * long one moving at the SAME speed instead of the same duration.
 */
export function nameMarqueeMs(overflowPx: number): number {
  if (!Number.isFinite(overflowPx) || overflowPx <= 0) return 0
  const panMs = overflowPx / NAME_PX_PER_MS
  const cycle = Math.round(panMs / NAME_PAN_FRACTION)
  return Math.min(Math.max(cycle, NAME_CYCLE_MIN_MS), NAME_CYCLE_MAX_MS)
}
