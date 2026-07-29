// src/lib/play-meter.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

export type PlayMeter = {
  /** Feed the current playback position, in seconds. */
  tick(tSeconds: number): void
  /** Re-arm for a new track: clears accumulated progress and the fired flag. */
  reset(): void
}

export type PlayMeterOptions = {
  /** Cumulative seconds of real listening needed to count as a play. */
  thresholdS?: number
  /** Largest forward jump between two ticks still treated as playback. */
  maxDeltaS?: number
  /** Called exactly once, the moment cumulative progress reaches threshold. */
  onQualify: () => void
}

const DEFAULT_THRESHOLD_S = 30
const DEFAULT_MAX_DELTA_S = 5

/**
 * Anti-scrub play counting — port of butternutcrack's `listens.ts` (PRD
 * §13 salvage). Pure module state, no DOM, same testability shape as
 * `debounce.ts`: a caller feeds it a stream of `currentTime` samples and it
 * decides, on its own, when enough of the track was actually listened to
 * for the play to count.
 *
 * The core problem: `<audio>.currentTime` jumps around for reasons that are
 * NOT listening — seeking to the end to skip a track, scrubbing back and
 * forth, a stalled connection that later resyncs far ahead. Only forward
 * jumps no bigger than `maxDeltaS` are trusted as real elapsed playback
 * time; anything bigger (a scrub) or non-positive (a rewind, or a duplicate
 * tick at the same position) is discarded from the running total, though
 * the meter still re-anchors on the new position so playback immediately
 * after a scrub/rewind resumes counting normally rather than staying wedged
 * against the pre-jump position forever.
 *
 * `tick` after `onQualify` has already fired is a deliberate no-op —
 * `onQualify` fires exactly once per `reset()` cycle, which is what makes it
 * safe for a caller to wire straight to a fire-and-forget "count this play"
 * network call without its own de-duplication.
 */
export function createPlayMeter(opts: PlayMeterOptions): PlayMeter {
  const thresholdS = opts.thresholdS ?? DEFAULT_THRESHOLD_S
  const maxDeltaS = opts.maxDeltaS ?? DEFAULT_MAX_DELTA_S
  const onQualify = opts.onQualify

  let lastT: number | null = null
  let accumulated = 0
  let fired = false

  function tick(tSeconds: number): void {
    if (fired) return

    if (lastT === null) {
      // First sample after creation/reset: nothing to compare against yet,
      // just anchor the running position.
      lastT = tSeconds
      return
    }

    const delta = tSeconds - lastT
    lastT = tSeconds // re-anchor unconditionally, scrub or not

    if (delta > 0 && delta <= maxDeltaS) {
      accumulated += delta
      if (accumulated >= thresholdS) {
        fired = true
        onQualify()
      }
    }
    // else: a scrub jump forward (delta > maxDeltaS) or any non-positive
    // delta (rewind, or a duplicate tick) — discarded, no accumulation.
  }

  function reset(): void {
    lastT = null
    accumulated = 0
    fired = false
  }

  return { tick, reset }
}
