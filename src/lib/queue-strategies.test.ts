// src/lib/queue-strategies.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  BPM_PCT_DIVISOR, BPM_WINDOW, bpmPenalty, FALLBACK_METHOD, KEY_FREE_HOURS, keyPenalty,
  MODE_SWAP_PENALTY, RELATIVE_PENALTY, score, STRATEGIES, UNKNOWN_BPM_PENALTY,
  UNKNOWN_KEY_PENALTY, type StrategyContext, type TrackFeatures,
} from './queue-strategies'
import { AUTO_METHODS } from './queue-model'

const track = (id: string, over: Partial<TrackFeatures> = {}): TrackFeatures => ({
  file_id: id,
  display_artist: null,
  display_title: id,
  duration_ms: 300_000,
  bpm: 128,
  key_camelot: '8A',
  like_count: 0,
  play_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

const ctx = (over: Partial<StrategyContext> = {}): StrategyContext => ({
  seed: null,
  candidates: [],
  history: [],
  need: 5,
  ...over,
})

describe('the tuning constants are named exports, so the owner can tune them', () => {
  it('holds §3.5 exactly', () => {
    expect(KEY_FREE_HOURS).toBe(1)
    expect(MODE_SWAP_PENALTY).toBe(1.5)
    expect(RELATIVE_PENALTY).toBe(0.5)
    expect(UNKNOWN_KEY_PENALTY).toBe(3.0)
    expect(UNKNOWN_BPM_PENALTY).toBe(2.0)
    expect(BPM_WINDOW).toBe(0.06)
    expect(BPM_PCT_DIVISOR).toBe(3)
  })
})

describe('keyPenalty — the §3.5 table, every pair', () => {
  const table: Array<[string, string | null, number, string]> = [
    ['8A', '8A', 0, 'same key'],
    ['8A', '9A', 0, 'perfect fifth — free'],
    ['8A', '7A', 0, 'subdominant — free'],
    ['8A', '8B', 0.5, 'relative major'],
    ['8A', '9B', 1.5, 'mode swap at distance'],
    ['8A', '10A', 1.0, 'two hours'],
    ['8A', '2A', 5.0, 'across the wheel'],
    ['8A', null, 3.0, 'unanalysed'],
  ]

  for (const [a, b, want, why] of table) {
    it(`${a} -> ${b ?? 'null'} = ${want} (${why})`, () => {
      expect(keyPenalty(a, b)).toBeCloseTo(want, 10)
    })

    it(`${a} -> ${b ?? 'null'} is SYMMETRIC — asserted, not assumed`, () => {
      expect(keyPenalty(b, a)).toBeCloseTo(keyPenalty(a, b), 10)
    })
  }

  it('wraps the wheel: 12A -> 1A is ONE hour and therefore free, not eleven', () => {
    expect(keyPenalty('12A', '1A')).toBe(0)
    expect(keyPenalty('1A', '12A')).toBe(0)
  })

  it('wraps for the mode swap too: 12A -> 1B is a mode swap at distance', () => {
    expect(keyPenalty('12A', '1B')).toBeCloseTo(1.5, 10)
  })

  it('measures the far side of the wheel, never the long way round', () => {
    // 1A -> 7A is six hours either way; 1A -> 8A is five, not seven.
    expect(keyPenalty('1A', '7A')).toBeCloseTo(5.0, 10)
    expect(keyPenalty('1A', '8A')).toBeCloseTo(4.0, 10)
  })

  it('treats an off-wheel or malformed key as unanalysed', () => {
    expect(keyPenalty('13A', '8A')).toBe(UNKNOWN_KEY_PENALTY)
    expect(keyPenalty('garbage', '8A')).toBe(UNKNOWN_KEY_PENALTY)
    expect(keyPenalty(null, null)).toBe(UNKNOWN_KEY_PENALTY)
  })

  it('keeps ±1 hour free in BOTH directions at every point on the wheel', () => {
    for (let n = 1; n <= 12; n++) {
      const up = (n % 12) + 1
      const down = ((n + 10) % 12) + 1
      expect(keyPenalty(`${n}A`, `${up}A`)).toBe(0)
      expect(keyPenalty(`${n}A`, `${down}A`)).toBe(0)
    }
  })
})

describe('bpmPenalty', () => {
  it('is 0 for an identical tempo', () => {
    expect(bpmPenalty(128, 128)).toBe(0)
  })

  it('costs 2.0 at the edge of the ±6 % window — the same order as a mode swap', () => {
    expect(bpmPenalty(128, 128 * (1 + BPM_WINDOW))).toBeCloseTo(2.0, 10)
  })

  it('costs 2.0 at the bottom of the window too', () => {
    expect(bpmPenalty(128, 128 * (1 - BPM_WINDOW))).toBeCloseTo(2.0, 10)
  })

  it('scales linearly between', () => {
    expect(bpmPenalty(128, 128 * 1.03)).toBeCloseTo(1.0, 10)
  })

  it('is UNKNOWN_BPM_PENALTY when either side is missing or not a tempo', () => {
    expect(bpmPenalty(null, 128)).toBe(UNKNOWN_BPM_PENALTY)
    expect(bpmPenalty(128, null)).toBe(UNKNOWN_BPM_PENALTY)
    expect(bpmPenalty(0, 128)).toBe(UNKNOWN_BPM_PENALTY)
    expect(bpmPenalty(128, 0)).toBe(UNKNOWN_BPM_PENALTY)
    expect(bpmPenalty(128, -4)).toBe(UNKNOWN_BPM_PENALTY)
    expect(bpmPenalty(Number.NaN, 128)).toBe(UNKNOWN_BPM_PENALTY)
  })
})

describe('score', () => {
  it('is the sum of the two penalties', () => {
    const seed = track('s', { key_camelot: '8A', bpm: 128 })
    const cand = track('c', { key_camelot: '10A', bpm: 128 * 1.03 })
    expect(score(seed, cand)).toBeCloseTo(1.0 + 1.0, 10)
  })

  it('treats a null seed as unknown on both axes', () => {
    expect(score(null, track('c'))).toBeCloseTo(UNKNOWN_KEY_PENALTY + UNKNOWN_BPM_PENALTY, 10)
  })
})

describe('STRATEGIES — the registry is the extension point', () => {
  it('ships exactly the four v1 methods', () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual([...AUTO_METHODS].sort())
  })

  it('gives every strategy an id matching its registry key and a UI label', () => {
    for (const key of AUTO_METHODS) {
      expect(STRATEGIES[key].id).toBe(key)
      expect(STRATEGIES[key].label).toMatch(/^[A-Z]+$/)
    }
  })

  it('labels them OFF / MIX / TEMPO / SHUFFLE', () => {
    expect(STRATEGIES.off.label).toBe('OFF')
    expect(STRATEGIES.harmonic.label).toBe('MIX')
    expect(STRATEGIES.bpm.label).toBe('TEMPO')
    expect(STRATEGIES.shuffle.label).toBe('SHUFFLE')
  })

  it('falls back from harmonic to bpm, and from nothing else', () => {
    expect(FALLBACK_METHOD.harmonic).toBe('bpm')
    expect(FALLBACK_METHOD.bpm).toBeUndefined()
    expect(FALLBACK_METHOD.shuffle).toBeUndefined()
    expect(FALLBACK_METHOD.off).toBeUndefined()
  })
})

describe('off.select', () => {
  it('returns nothing, for any context at all', () => {
    expect(STRATEGIES.off.select(ctx())).toEqual([])
    expect(STRATEGIES.off.select(ctx({
      seed: track('s'), candidates: [track('a'), track('b')], need: 24,
    }))).toEqual([])
  })
})

describe('harmonic.select', () => {
  // seed 8A@128. From the seed:   X 0.0  <  Z 0.5  <  Y 1.0
  //                From X (9A):   Y 0.0  <  Z 1.5
  // So a chain that re-seeds gives X, Y, Z; one that does not gives X, Z, Y.
  const seed = track('seed', { key_camelot: '8A', bpm: 128 })
  const X = track('X', { key_camelot: '9A', bpm: 128 })
  const Y = track('Y', { key_camelot: '10A', bpm: 128 })
  const Z = track('Z', { key_camelot: '8B', bpm: 128 })

  it('RE-SEEDS FROM ITS OWN LAST PICK — each step continues the chain', () => {
    const picked = STRATEGIES.harmonic.select(ctx({ seed, candidates: [Y, Z, X], need: 3 }))
    expect(picked).toEqual(['X', 'Y', 'Z'])
  })

  it('is not merely ranking everything against the original seed', () => {
    const picked = STRATEGIES.harmonic.select(ctx({ seed, candidates: [Y, Z, X], need: 3 }))
    expect(picked).not.toEqual(['X', 'Z', 'Y'])
  })

  it('is deterministic — ten runs, byte-identical output', () => {
    const c = ctx({ seed, candidates: [Y, Z, X], need: 3 })
    const first = STRATEGIES.harmonic.select(c)
    for (let i = 0; i < 10; i++) {
      expect(STRATEGIES.harmonic.select(c)).toEqual(first)
    }
  })

  it('never exceeds need', () => {
    expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [X, Y, Z], need: 2 }))).toHaveLength(2)
    expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [X, Y, Z], need: 0 }))).toEqual([])
    expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [X, Y, Z], need: -3 }))).toEqual([])
  })

  it('RETURNS SHORT when candidates run out — no padding, no repeat, no widening', () => {
    const picked = STRATEGIES.harmonic.select(ctx({ seed, candidates: [X, Y], need: 24 }))
    expect(picked).toEqual(['X', 'Y'])
    expect(new Set(picked).size).toBe(picked.length)
  })

  it('returns nothing when there are no candidates at all', () => {
    expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [], need: 24 }))).toEqual([])
  })

  it('never repeats an id even when the candidate list does', () => {
    const picked = STRATEGIES.harmonic.select(ctx({ seed, candidates: [X, X, X, Y], need: 4 }))
    expect(picked).toEqual(['X', 'Y'])
  })

  it('does not mutate its inputs', () => {
    const candidates = Object.freeze([X, Y, Z]) as readonly TrackFeatures[]
    Object.freeze(X); Object.freeze(Y); Object.freeze(Z)
    expect(() => STRATEGIES.harmonic.select(ctx({ seed, candidates, need: 3 }))).not.toThrow()
    expect(candidates).toHaveLength(3)
  })

  it('still ranks by tempo when the seed is unanalysed — §1.3 case 5', () => {
    const blind = track('blind', { key_camelot: null, bpm: 128 })
    const near = track('near', { key_camelot: '2A', bpm: 128 })
    const far = track('far', { key_camelot: '8A', bpm: 134 })
    expect(STRATEGIES.harmonic.select(ctx({ seed: blind, candidates: [far, near], need: 1 })))
      .toEqual(['near'])
  })

  it('still returns a deterministic order for a null seed', () => {
    const a = track('a')
    const b = track('b')
    expect(STRATEGIES.harmonic.select(ctx({ seed: null, candidates: [b, a], need: 2 })))
      .toEqual(['a', 'b'])
  })

  describe('the total tie-break order', () => {
    const tied = (id: string, over: Partial<TrackFeatures>) =>
      track(id, { key_camelot: '8A', bpm: 128, ...over })

    it('breaks an equal penalty by HIGHER like_count first', () => {
      const cold = tied('cold', { like_count: 1 })
      const hot = tied('hot', { like_count: 9 })
      expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [cold, hot], need: 2 })))
        .toEqual(['hot', 'cold'])
    })

    it('then by NEWER created_at', () => {
      const old = tied('old', { like_count: 3, created_at: '2020-01-01T00:00:00Z' })
      const fresh = tied('fresh', { like_count: 3, created_at: '2026-06-01T00:00:00Z' })
      expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [old, fresh], need: 2 })))
        .toEqual(['fresh', 'old'])
    })

    it('then by file_id ASCENDING — a total order, so the output is never arbitrary', () => {
      const zz = tied('zz', {})
      const aa = tied('aa', {})
      expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [zz, aa], need: 2 })))
        .toEqual(['aa', 'zz'])
    })

    it('NEVER breaks a tie by play_count — §2.2, the discovery feedback loop', () => {
      // Identical on every real axis. `zz` is far more played; if play_count
      // were a tiebreak it would come first. It must not.
      const zz = tied('zz', { play_count: 900 })
      const aa = tied('aa', { play_count: 0 })
      expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [zz, aa], need: 2 })))
        .toEqual(['aa', 'zz'])
    })
  })
})

describe('bpm.select', () => {
  const seed = track('seed', { key_camelot: '8A', bpm: 128 })
  const closeWrongKey = track('close', { key_camelot: '2A', bpm: 128.5 })
  const farRightKey = track('far', { key_camelot: '8A', bpm: 132 })

  it('IGNORES KEY ENTIRELY — a 2A candidate beats an 8A one when its tempo is closer', () => {
    expect(STRATEGIES.bpm.select(ctx({ seed, candidates: [farRightKey, closeWrongKey], need: 1 })))
      .toEqual(['close'])
  })

  it('is the exact contrast with harmonic on the same candidates', () => {
    expect(STRATEGIES.harmonic.select(ctx({ seed, candidates: [farRightKey, closeWrongKey], need: 1 })))
      .toEqual(['far'])
  })

  it('is deterministic and never exceeds need', () => {
    const c = ctx({ seed, candidates: [farRightKey, closeWrongKey], need: 1 })
    expect(STRATEGIES.bpm.select(c)).toEqual(STRATEGIES.bpm.select(c))
    expect(STRATEGIES.bpm.select(ctx({ seed, candidates: [], need: 9 }))).toEqual([])
  })

  it('returns short rather than padding', () => {
    expect(STRATEGIES.bpm.select(ctx({ seed, candidates: [closeWrongKey], need: 24 })))
      .toEqual(['close'])
  })
})

describe('shuffle.select', () => {
  const pool = Array.from({ length: 12 }, (_, i) =>
    track(`t${String(i).padStart(2, '0')}`, { bpm: 120 + i }))

  it('is seeded from the seed track, so the same context reproduces exactly', () => {
    const c = ctx({ seed: track('seedA'), candidates: pool, need: 8 })
    const first = STRATEGIES.shuffle.select(c)
    for (let i = 0; i < 10; i++) expect(STRATEGIES.shuffle.select(c)).toEqual(first)
  })

  it('gives a DIFFERENT order for a different seed — it is a shuffle, not a sort', () => {
    const a = STRATEGIES.shuffle.select(ctx({ seed: track('seedA'), candidates: pool, need: 12 }))
    const b = STRATEGIES.shuffle.select(ctx({ seed: track('seedB'), candidates: pool, need: 12 }))
    expect(a).not.toEqual(b)
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('never returns a duplicate', () => {
    const picked = STRATEGIES.shuffle.select(ctx({ seed: track('s'), candidates: [...pool, ...pool], need: 24 }))
    expect(new Set(picked).size).toBe(picked.length)
  })

  it('never exceeds need and returns short rather than padding', () => {
    expect(STRATEGIES.shuffle.select(ctx({ seed: track('s'), candidates: pool, need: 3 }))).toHaveLength(3)
    expect(STRATEGIES.shuffle.select(ctx({ seed: track('s'), candidates: pool, need: 40 }))).toHaveLength(12)
    expect(STRATEGIES.shuffle.select(ctx({ seed: track('s'), candidates: pool, need: 0 }))).toEqual([])
  })

  it('is deterministic even with no seed track', () => {
    const c = ctx({ seed: null, candidates: pool, need: 5 })
    expect(STRATEGIES.shuffle.select(c)).toEqual(STRATEGIES.shuffle.select(c))
  })

  it('does not mutate its inputs', () => {
    const candidates = Object.freeze(pool.slice()) as readonly TrackFeatures[]
    expect(() => STRATEGIES.shuffle.select(ctx({ seed: track('s'), candidates, need: 5 }))).not.toThrow()
    expect(candidates).toHaveLength(12)
  })
})

describe('every strategy honours the interface contract', () => {
  const pool = [track('a', { bpm: 126 }), track('b', { bpm: 130 }), track('c', { key_camelot: '3B' })]

  for (const id of AUTO_METHODS) {
    it(`${id} returns ids drawn only from the candidate set`, () => {
      const picked = STRATEGIES[id].select(ctx({ seed: track('s'), candidates: pool, need: 24 }))
      for (const p of picked) expect(pool.map((t) => t.file_id)).toContain(p)
    })

    it(`${id} respects need`, () => {
      expect(STRATEGIES[id].select(ctx({ seed: track('s'), candidates: pool, need: 1 })).length)
        .toBeLessThanOrEqual(1)
    })

    it(`${id} tolerates a fractional need without emitting a fractional slice`, () => {
      const picked = STRATEGIES[id].select(ctx({ seed: track('s'), candidates: pool, need: 2.7 }))
      expect(picked.length).toBeLessThanOrEqual(2)
    })
  }
})
