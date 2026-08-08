// src/lib/queue-model.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  assembleQueue, AUTO_METHODS, DEFAULT_METHOD, emptyState, excludedKeys, identityTokens,
  isAutoMethod, isTaken, QUEUE_MAX, RECORDING_TOKEN, recordingOf, slotsFor, take,
  truncateIntent, type QueueEntry, type QueueState,
} from './queue-model'

const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  file_id: id,
  display_artist: null,
  display_title: id,
  duration_ms: null,
  bpm: null,
  key_camelot: null,
  origin: 'list',
  source_label: 'pool',
  ...over,
})

const many = (n: number, prefix = 'e'): QueueEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`))

const state = (over: Partial<QueueState> = {}): QueueState => ({
  ...emptyState(),
  ...over,
})

/** Deep-freezes a state so any in-place write throws under ESM strict mode. */
const frozen = (s: QueueState): QueueState => {
  Object.freeze(s.intent)
  Object.freeze(s.history)
  Object.freeze(s.failed)
  Object.freeze(s.suppressed)
  if (s.current !== null) Object.freeze(s.current)
  return Object.freeze(s)
}

describe('constants', () => {
  it('caps the whole queue at 25 — the owner\'s number, and the only cap', () => {
    expect(QUEUE_MAX).toBe(25)
  })

  it('defaults to the off method, so autoplay is opt-in', () => {
    expect(DEFAULT_METHOD).toBe('off')
    expect(emptyState().method).toBe('off')
  })

  it('names exactly the four v1 methods', () => {
    expect([...AUTO_METHODS].sort()).toEqual(['bpm', 'harmonic', 'off', 'shuffle'])
  })

  it('guards a hand-edited method value', () => {
    expect(isAutoMethod('harmonic')).toBe(true)
    expect(isAutoMethod('genre')).toBe(false)
    expect(isAutoMethod(null)).toBe(false)
    expect(isAutoMethod(7)).toBe(false)
  })
})

describe('emptyState', () => {
  it('is empty in every field', () => {
    const s = emptyState()
    expect(s.current).toBeNull()
    expect(s.intent).toEqual([])
    expect(s.history).toEqual([])
    expect(s.failed).toEqual([])
    expect(s.suppressed).toEqual([])
  })

  it('returns a fresh object each call — no shared arrays between two callers', () => {
    const a = emptyState()
    const b = emptyState()
    expect(a).not.toBe(b)
    expect(a.intent).not.toBe(b.intent)
  })
})

describe('slotsFor', () => {
  it('gives 25 slots when nothing is playing', () => {
    expect(slotsFor(emptyState())).toEqual({ slots: 25, need: 25 })
  })

  it('gives 24 slots while something plays — current counts against the cap', () => {
    expect(slotsFor(state({ current: entry('c') }))).toEqual({ slots: 24, need: 24 })
  })

  it('subtracts the intent layer from need', () => {
    const s = state({ current: entry('c'), intent: many(10) })
    expect(slotsFor(s)).toEqual({ slots: 24, need: 14 })
  })

  it('reports need 0 — never negative — when intent already fills the slots', () => {
    const s = state({ current: entry('c'), intent: many(24) })
    expect(slotsFor(s)).toEqual({ slots: 24, need: 0 })
  })

  it('reports need 0 for an over-long intent layer rather than a negative number', () => {
    const s = state({ current: entry('c'), intent: many(40) })
    expect(slotsFor(s).need).toBe(0)
  })
})

describe('truncateIntent — the cap is enforced ON WRITE', () => {
  const cases: Array<{ name: string; offered: number; slots: number; kept: number; dropped: number }> = [
    { name: '30 offered into 24 slots (something playing)', offered: 30, slots: 24, kept: 24, dropped: 6 },
    { name: '30 offered into 25 slots (nothing playing)', offered: 30, slots: 25, kept: 25, dropped: 5 },
    { name: 'a 60-track crate into 24 slots', offered: 60, slots: 24, kept: 24, dropped: 36 },
    { name: 'everything fits', offered: 5, slots: 24, kept: 5, dropped: 0 },
    { name: 'exactly full', offered: 24, slots: 24, kept: 24, dropped: 0 },
    { name: 'no slots left at all', offered: 17, slots: 0, kept: 0, dropped: 17 },
    { name: 'negative slots are treated as none', offered: 3, slots: -4, kept: 0, dropped: 3 },
    { name: 'nothing offered', offered: 0, slots: 24, kept: 0, dropped: 0 },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const result = truncateIntent(many(c.offered), c.slots)
      expect(result.kept).toHaveLength(c.kept)
      expect(result.dropped).toBe(c.dropped)
      expect(result.kept.length).toBeLessThanOrEqual(Math.max(0, c.slots))
    })
  }

  it('keeps the FIRST n, in order — a truncated crate plays its opening tracks', () => {
    const { kept } = truncateIntent(many(30), 3)
    expect(kept.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
  })

  it('never mutates the offered array', () => {
    const offered = Object.freeze(many(30)) as QueueEntry[]
    expect(() => truncateIntent(offered, 4)).not.toThrow()
    expect(offered).toHaveLength(30)
  })

  it('returns a new array, not the input', () => {
    const offered = many(3)
    expect(truncateIntent(offered, 24).kept).not.toBe(offered)
  })
})

describe('excludedKeys', () => {
  it('is empty for an empty state', () => {
    expect(excludedKeys(emptyState()).size).toBe(0)
  })

  it('covers current, intent, history, failed and suppressed', () => {
    const s = state({
      current: entry('cur'),
      intent: [entry('i1'), entry('i2')],
      history: ['h1'],
      failed: ['f1'],
      suppressed: ['s1'],
    })
    expect([...excludedKeys(s)].sort()).toEqual(['cur', 'f1', 'h1', 'i1', 'i2', 's1'])
  })

  it('dedupes an id that appears in more than one source', () => {
    const s = state({ current: entry('x'), history: ['x'], failed: ['x'], suppressed: ['x'] })
    expect(excludedKeys(s).size).toBe(1)
  })

  it('does not mutate the state it reads', () => {
    const s = frozen(state({ current: entry('c'), history: ['h'] }))
    expect(() => excludedKeys(s)).not.toThrow()
    expect(s.history).toEqual(['h'])
  })

  it('adds the RECORDING of current and of every pin, not just the file', () => {
    const s = state({
      current: entry('cur', { track_id: 'rc' }),
      intent: [entry('i1', { track_id: 'r1' })],
    })
    expect([...excludedKeys(s)].sort())
      .toEqual(['cur', 'i1', 'rec:r1', 'rec:rc'])
  })

  it('takes history, failed and suppressed VERBATIM — reduce already tokenised them', () => {
    const s = state({ history: ['h1', 'rec:rh'], failed: ['f1'], suppressed: ['rec:rs'] })
    expect([...excludedKeys(s)].sort()).toEqual(['f1', 'h1', 'rec:rh', 'rec:rs'])
  })
})

// ---------------------------------------------------------------------------
// QUEUE.dedupe — the arithmetic that makes "same song 2-4 times" impossible.
// ---------------------------------------------------------------------------

describe('the two names a track answers to', () => {
  it('marks a recording and leaves a file id bare — the no-schema-bump rule', () => {
    expect(RECORDING_TOKEN).toBe('rec:')
    expect(identityTokens({ file_id: 'f', track_id: 'r' })).toEqual(['f', 'rec:r'])
  })

  it('puts the FILE first, so history[0] is still the most recent file', () => {
    expect(identityTokens({ file_id: 'f', track_id: 'r' })[0]).toBe('f')
  })

  for (const [why, value] of [
    ['null', null], ['absent', undefined], ['the empty string', ''],
  ] as Array<[string, string | null | undefined]>) {
    it(`treats ${why} as NO recording — the file is its own identity`, () => {
      const e = { file_id: 'f', track_id: value }
      expect(recordingOf(e)).toBeNull()
      expect(identityTokens(e)).toEqual(['f'])
    })
  }

  it('never collapses two unmatched files into one — null is not a shared bucket', () => {
    const taken = new Set<string>()
    take(taken, { file_id: 'a', track_id: null })
    expect(isTaken(taken, { file_id: 'b', track_id: null })).toBe(false)
  })

  it('is taken when the FILE is taken', () => {
    const taken = new Set<string>()
    take(taken, { file_id: 'a', track_id: 'r' })
    expect(isTaken(taken, { file_id: 'a', track_id: 'r' })).toBe(true)
  })

  it('IS TAKEN WHEN THE RECORDING IS TAKEN — this is the whole bug, in one line', () => {
    const taken = new Set<string>()
    take(taken, { file_id: 'the-flac', track_id: 'r' })
    expect(isTaken(taken, { file_id: 'the-320', track_id: 'r' })).toBe(true)
  })

  it('still excludes a file whose recording is unknown but whose id is spoken for', () => {
    // The UX.9 resume shape: `current` came from player memory and has no
    // recording, so only its file id can defend it. It must still defend it.
    const taken = new Set<string>()
    take(taken, { file_id: 'a', track_id: null })
    expect(isTaken(taken, { file_id: 'a', track_id: 'r' })).toBe(true)
  })
})

describe('assembleQueue', () => {
  it('lays out current, then intent, then auto', () => {
    const s = state({ current: entry('c'), intent: [entry('i1'), entry('i2')] })
    const q = assembleQueue(s, [entry('a1', { origin: 'auto' })])
    expect(q.map((e) => e.file_id)).toEqual(['c', 'i1', 'i2', 'a1'])
  })

  it('carries origin and source_label through untouched — the drawer reads them', () => {
    const s = state({ current: entry('c', { origin: 'current' }) })
    const q = assembleQueue(s, [entry('a', { origin: 'auto', source_label: 'MIX' })])
    expect(q[0].origin).toBe('current')
    expect(q[1]).toMatchObject({ origin: 'auto', source_label: 'MIX' })
  })

  it('is 25 long with a current and 24 intent entries, and takes no auto at all', () => {
    const s = state({ current: entry('c'), intent: many(24) })
    expect(slotsFor(s).need).toBe(0)
    const q = assembleQueue(s, many(10, 'a'))
    expect(q).toHaveLength(25)
    expect(q.some((e) => e.file_id.startsWith('a'))).toBe(false)
  })

  it('TRUNCATES A STRATEGY THAT OVER-RETURNS — 40 auto entries against need 3', () => {
    const s = state({ current: entry('c'), intent: many(21) })
    expect(slotsFor(s).need).toBe(3)
    const q = assembleQueue(s, many(40, 'a'))
    expect(q).toHaveLength(25)
    expect(q.filter((e) => e.file_id.startsWith('a'))).toHaveLength(3)
  })

  it('RE-FILTERS ids the engine already excluded, however the strategy misbehaves', () => {
    const s = state({
      current: entry('cur'),
      intent: [entry('i1')],
      history: ['h1'],
      failed: ['f1'],
      suppressed: ['s1'],
    })
    const auto = ['cur', 'i1', 'h1', 'f1', 's1', 'good'].map((id) => entry(id, { origin: 'auto' }))
    const q = assembleQueue(s, auto)
    expect(q.map((e) => e.file_id)).toEqual(['cur', 'i1', 'good'])
  })

  it('dedupes an auto layer that repeats itself', () => {
    const s = state({ current: entry('c') })
    const auto = [entry('a'), entry('a'), entry('b')].map((e) => ({ ...e, origin: 'auto' as const }))
    expect(assembleQueue(s, auto).map((e) => e.file_id)).toEqual(['c', 'a', 'b'])
  })

  // ---------------------------------------------------------------------
  // QUEUE.dedupe — the owner's bug, at the level it has to be impossible.
  // ---------------------------------------------------------------------

  it('THE REGRESSION — four encodes of one recording in one batch yield ONE entry', () => {
    const s = state({ current: entry('c') })
    const auto = ['flac', 'mp3-320', 'm4a', 'mp3-192'].map((id) =>
      entry(id, { origin: 'auto', track_id: 'the-song' }))
    expect(assembleQueue(s, auto).map((e) => e.file_id)).toEqual(['c', 'flac'])
  })

  it('never renders two entries with the same recording — the invariant, stated', () => {
    const s = state({ current: entry('c', { track_id: 'r0' }) })
    // Twelve rows over four recordings, interleaved so no naive first-wins
    // pass over a sorted list could accidentally pass this.
    const auto = Array.from({ length: 12 }, (_, i) =>
      entry(`f${i}`, { origin: 'auto', track_id: `r${i % 4}` }))
    const recordings = assembleQueue(s, auto).map((e) => e.track_id)
    expect(new Set(recordings).size).toBe(recordings.length)
    // r0 is what is playing, so only r1..r3 survive.
    expect(recordings).toEqual(['r0', 'r1', 'r2', 'r3'])
  })

  it('never re-queues the recording that is PLAYING, under a different file id', () => {
    const s = state({ current: entry('the-flac', { track_id: 'r' }) })
    const auto = [entry('the-320', { origin: 'auto', track_id: 'r' })]
    expect(assembleQueue(s, auto).map((e) => e.file_id)).toEqual(['the-flac'])
  })

  it('never adds a recording the INTENT LAYER already holds', () => {
    const s = state({ current: entry('c'), intent: [entry('pinned', { track_id: 'r' })] })
    const auto = [
      entry('other-encode', { origin: 'auto', track_id: 'r' }),
      entry('fresh', { origin: 'auto', track_id: 'r2' }),
    ]
    expect(assembleQueue(s, auto).map((e) => e.file_id)).toEqual(['c', 'pinned', 'fresh'])
  })

  it('never adds a recording HISTORY already consumed, under a different file id', () => {
    const s = state({ current: entry('c'), history: ['played-flac', 'rec:r'] })
    const auto = [
      entry('same-song-320', { origin: 'auto', track_id: 'r' }),
      entry('fresh', { origin: 'auto', track_id: 'r2' }),
    ]
    expect(assembleQueue(s, auto).map((e) => e.file_id)).toEqual(['c', 'fresh'])
  })

  it('LEGACY AND NULL DEGRADE TO TODAY — four unmatched files stay four entries', () => {
    const s = state({ current: entry('c') })
    // No track_id at all (a persisted entry from a build before QUEUE.dedupe)
    // and an explicit null are the same statement, and neither collapses.
    const auto = [
      entry('a', { origin: 'auto' }),
      entry('b', { origin: 'auto', track_id: null }),
      entry('c2', { origin: 'auto' }),
      entry('d', { origin: 'auto', track_id: null }),
    ]
    expect(assembleQueue(s, auto)).toHaveLength(5)
  })

  it('an empty-string recording is nobody\'s recording, not everybody\'s', () => {
    const s = state({ current: entry('c') })
    const auto = [
      entry('a', { origin: 'auto', track_id: '' }),
      entry('b', { origin: 'auto', track_id: '' }),
    ]
    expect(assembleQueue(s, auto).map((e) => e.file_id)).toEqual(['c', 'a', 'b'])
  })

  it('DEDUPE MUST NOT STARVE THE TAIL — 24 distinct recordings still fill 24 slots', () => {
    const s = state({ current: entry('c', { track_id: 'rc' }) })
    const auto = Array.from({ length: 30 }, (_, i) =>
      entry(`f${i}`, { origin: 'auto', track_id: `r${i}` }))
    expect(assembleQueue(s, auto)).toHaveLength(QUEUE_MAX)
  })

  it('starts with the intent layer when nothing is playing', () => {
    const s = state({ intent: [entry('i1')] })
    expect(assembleQueue(s, []).map((e) => e.file_id)).toEqual(['i1'])
  })

  it('never exceeds QUEUE_MAX even if the intent layer arrives over-long', () => {
    // Defensive: reduce() truncates on write, so this state should be
    // unreachable. The cap is absolute anyway.
    const s = state({ current: entry('c'), intent: many(100) })
    expect(assembleQueue(s, many(10, 'a'))).toHaveLength(QUEUE_MAX)
  })

  it('does not mutate the state or the auto array', () => {
    const s = frozen(state({ current: entry('c'), intent: many(2) }))
    const auto = Object.freeze(many(3, 'a')) as QueueEntry[]
    expect(() => assembleQueue(s, auto)).not.toThrow()
    expect(s.intent).toHaveLength(2)
    expect(auto).toHaveLength(3)
  })

  it('returns fresh entry references nowhere shared with the state arrays', () => {
    const s = state({ current: entry('c'), intent: many(2) })
    const q = assembleQueue(s, [])
    expect(q).not.toBe(s.intent)
  })
})

// §1.3 — "sometimes less". The four cases that need no strategy to express.
describe('the queue is sometimes shorter than 25', () => {
  it('case 1 — method off: a drained crate leaves length 1, then 0', () => {
    const playing = state({ current: entry('last') })
    expect(playing.method).toBe('off')
    expect(assembleQueue(playing, [])).toHaveLength(1)
    expect(assembleQueue(emptyState(), [])).toHaveLength(0)
  })

  it('case 4 — exclusions ate the candidates: the tail is what survives them', () => {
    const s = state({ current: entry('c'), history: ['a0', 'a1'], failed: ['a2'] })
    const q = assembleQueue(s, many(4, 'a'))
    expect(q.map((e) => e.file_id)).toEqual(['c', 'a3'])
  })

  it('case 6 — intent fills the slots: the auto layer gets nothing', () => {
    const s = state({ current: entry('c'), intent: many(24) })
    expect(slotsFor(s).need).toBe(0)
  })

  it('case 7 — nothing playing and nothing queued is length 0, not an error', () => {
    expect(assembleQueue(emptyState(), [])).toEqual([])
  })
})

// The invariant that replaced the 500-entry stored layer. A future
// contributor is most likely to "optimise" a backlog back in; this is the
// assertion that stops them.
describe('nothing is stored beyond the cap', () => {
  it('every truncateIntent result fits the slots it was given', () => {
    for (let slots = 0; slots <= QUEUE_MAX; slots++) {
      const { kept, dropped } = truncateIntent(many(200), slots)
      expect(kept.length).toBe(slots)
      expect(dropped).toBe(200 - slots)
    }
  })

  it('reports every dropped entry — a truncation is never silent', () => {
    const { kept, dropped } = truncateIntent(many(60), 24)
    expect(kept.length + dropped).toBe(60)
  })
})
