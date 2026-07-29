// src/lib/play-meter.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { createPlayMeter } from './play-meter'

describe('createPlayMeter', () => {
  it('accumulates deltas <= maxDelta and discards a scrub jump', () => {
    const calls: string[] = []
    const meter = createPlayMeter({ thresholdS: 20, maxDeltaS: 5, onQualify: () => calls.push('q') })
    meter.tick(0)
    meter.tick(4) // +4 -> accum 4
    meter.tick(8) // +4 -> accum 8
    meter.tick(200) // scrub: delta 192 > maxDelta, discarded — accum stays 8
    expect(calls).toEqual([])
    // Playback resumes normally from the scrubbed position — these deltas
    // must still count, proving the scrub only discarded its own delta and
    // did not wedge future accumulation.
    meter.tick(203) // +3 -> accum 11
    meter.tick(207) // +4 -> accum 15
    meter.tick(211) // +4 -> accum 19
    expect(calls).toEqual([])
    meter.tick(215) // +4 -> accum 23 >= 20 -> fires
    expect(calls).toEqual(['q'])
  })

  it('fires exactly once at >= threshold cumulative', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 10, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(0)
    meter.tick(5) // accum 5
    meter.tick(10) // accum 10 -> fires
    expect(count).toBe(1)
  })

  it('never re-fires on ticks after qualifying', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 10, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(0)
    meter.tick(5)
    meter.tick(10) // fires
    expect(count).toBe(1)
    meter.tick(15)
    meter.tick(20)
    meter.tick(25)
    expect(count).toBe(1)
  })

  it('reset() re-arms for the next track', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 10, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(0)
    meter.tick(5)
    meter.tick(10) // fires
    expect(count).toBe(1)

    meter.reset()
    meter.tick(0)
    meter.tick(5)
    meter.tick(10) // fires again after reset
    expect(count).toBe(2)
  })

  it('ticks going backward (rewind) do not accumulate negative or fire', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 10, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(10)
    meter.tick(15) // +5 -> accum 5
    meter.tick(3) // rewind: delta -12, discarded
    meter.tick(8) // +5 (from the rewound 3) -> accum 10 -> fires
    expect(count).toBe(1)
  })

  it('a rewind never erases prior accumulated progress', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 10, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(0)
    meter.tick(5) // accum 5
    meter.tick(5) // delta 0, discarded (not > 0)
    meter.tick(2) // rewind: delta -3, discarded
    meter.tick(6) // +4 (from 2) -> accum 9
    expect(count).toBe(0)
    meter.tick(10) // +4 -> accum 13 -> fires
    expect(count).toBe(1)
  })

  it('accepts a delta exactly equal to maxDelta', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 5, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(0)
    meter.tick(5) // delta exactly 5 -> accum 5 -> fires
    expect(count).toBe(1)
  })

  it('discards a delta that exceeds maxDelta even slightly', () => {
    let count = 0
    const meter = createPlayMeter({ thresholdS: 5, maxDeltaS: 5, onQualify: () => count++ })
    meter.tick(0)
    meter.tick(5.001) // delta 5.001 > maxDelta -> discarded
    expect(count).toBe(0)
  })

  it('uses default threshold 30s and maxDelta 5s when not specified', () => {
    let count = 0
    const meter = createPlayMeter({ onQualify: () => count++ })
    meter.tick(0)
    for (let t = 5; t <= 25; t += 5) meter.tick(t) // 5 ticks of +5 -> accum 25
    expect(count).toBe(0)
    meter.tick(31) // scrub: delta 6 > default maxDelta 5, discarded
    expect(count).toBe(0)
    meter.tick(35) // +4 -> accum 29
    expect(count).toBe(0)
    meter.tick(40) // +5 -> accum 34 >= 30 -> fires
    expect(count).toBe(1)
  })
})
