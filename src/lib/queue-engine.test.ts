// src/lib/queue-engine.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  confirmMessage, HISTORY_MAX, reduce, regenerate, requiresClearConfirm, seedFor,
  type CandidatePort, type QueueEvent,
} from './queue-engine'
import {
  emptyState, QUEUE_MAX, type QueueEntry, type QueueState,
} from './queue-model'
import { STRATEGIES, type TrackFeatures } from './queue-strategies'

const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  file_id: id,
  display_artist: null,
  display_title: id,
  duration_ms: null,
  bpm: 128,
  key_camelot: '8A',
  origin: 'list',
  source_label: 'pool',
  ...over,
})

const many = (n: number, prefix = 'e'): QueueEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`))

const feature = (id: string, over: Partial<TrackFeatures> = {}): TrackFeatures => ({
  file_id: id,
  display_artist: null,
  display_title: id,
  duration_ms: null,
  bpm: 128,
  key_camelot: '8A',
  like_count: 0,
  play_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

const state = (over: Partial<QueueState> = {}): QueueState => ({ ...emptyState(), ...over })

/** Typed through CandidatePort so `.mock.calls` keeps its argument tuple. */
const port$ = (impl: CandidatePort) => vi.fn(impl)

const frozen = (s: QueueState): QueueState => {
  Object.freeze(s.intent)
  Object.freeze(s.history)
  Object.freeze(s.failed)
  Object.freeze(s.suppressed)
  if (s.current !== null) Object.freeze(s.current)
  return Object.freeze(s)
}

/** The array the drawer rendered — what an index in a click event refers to. */
const rendered = (s: QueueState, auto: QueueEntry[] = []): QueueEntry[] =>
  [...(s.current === null ? [] : [s.current]), ...s.intent, ...auto]

afterEach(() => {
  vi.restoreAllMocks()
})

// ------------------------------------------------------- §1.5 the confirm

describe('requiresClearConfirm — the pure predicate, in the engine on purpose', () => {
  const withQueue = state({ current: entry('c'), intent: many(7) })
  const bare = state({ current: entry('c') })

  const play: QueueEvent = {
    type: 'PLAY_TRACK', file_id: 'n0', list: many(3, 'n'), index: 0, source_label: 'pool',
  }
  const playCrate: QueueEvent = {
    type: 'PLAY_CRATE', crate_id: 'cr', items: many(3, 'n'), start: 0, source_label: 'warehouse',
  }

  it('is TRUE for PLAY_TRACK with a non-empty intent layer', () => {
    expect(requiresClearConfirm(withQueue, play)).toBe(true)
  })

  it('is TRUE for PLAY_CRATE with a non-empty intent layer', () => {
    expect(requiresClearConfirm(withQueue, playCrate)).toBe(true)
  })

  it('is FALSE when the intent layer is empty — nothing is lost, so nothing is asked', () => {
    expect(requiresClearConfirm(bare, play)).toBe(false)
    expect(requiresClearConfirm(emptyState(), playCrate)).toBe(false)
  })

  it('is FALSE for every other event, even with a full queue', () => {
    const others: QueueEvent[] = [
      { type: 'SELECT_QUEUE_ENTRY', index: 3, queue: rendered(withQueue) },
      { type: 'ADD_TO_QUEUE', entries: many(2, 'x') },
      { type: 'SKIP', queue: rendered(withQueue) },
      { type: 'TRACK_ENDED', queue: rendered(withQueue) },
      { type: 'REMOVE_QUEUE_ENTRY', index: 2, queue: rendered(withQueue) },
      { type: 'TRACK_FAILED', file_id: 'c', queue: rendered(withQueue) },
      { type: 'SET_METHOD', method: 'harmonic' },
      { type: 'CLEAR_QUEUE' },
    ]
    for (const e of others) expect(requiresClearConfirm(withQueue, e)).toBe(false)
  })

  it('clicking something ALREADY QUEUED is not a replace', () => {
    expect(requiresClearConfirm(withQueue, {
      type: 'SELECT_QUEUE_ENTRY', index: 4, queue: rendered(withQueue),
    })).toBe(false)
  })
})

describe('confirmMessage — names what is lost, because "Are you sure?" is unanswerable', () => {
  it('names the source and the count', () => {
    const s = state({ current: entry('c'), intent: many(7) })
    const msg = confirmMessage(s, {
      type: 'PLAY_CRATE', crate_id: 'cr', items: many(3, 'n'), start: 0, source_label: 'warehouse',
    })
    expect(msg).toContain('warehouse')
    expect(msg).toContain('7 tracks')
    expect(msg).toBe('Playing "warehouse" clears your queue of 7 tracks. Continue?')
  })

  it('uses the singular for one track', () => {
    const s = state({ current: entry('c'), intent: many(1) })
    const msg = confirmMessage(s, {
      type: 'PLAY_TRACK', file_id: 'n0', list: many(2, 'n'), index: 0, source_label: 'pool',
    })
    expect(msg).toBe('Playing "pool" clears your queue of 1 track. Continue?')
  })

  it('falls back to a neutral noun when the source has no label', () => {
    const s = state({ intent: many(2) })
    const msg = confirmMessage(s, {
      type: 'PLAY_TRACK', file_id: 'n0', list: many(2, 'n'), index: 0, source_label: null,
    })
    expect(msg).toContain('2 tracks')
    expect(msg).not.toContain('null')
  })

  it('is empty for an event that never prompts', () => {
    expect(confirmMessage(state({ intent: many(3) }), { type: 'CLEAR_QUEUE' })).toBe('')
  })
})

// ------------------------------------------------------- §1.4 the reducer

describe('PLAY_TRACK', () => {
  it('replaces the intent layer with the rest of the list after the index', () => {
    const list = many(5, 'n')
    const { state: next } = reduce(emptyState(), {
      type: 'PLAY_TRACK', file_id: 'n1', list, index: 1, source_label: 'pool',
    })
    expect(next.current?.file_id).toBe('n1')
    expect(next.intent.map((e) => e.file_id)).toEqual(['n2', 'n3', 'n4'])
  })

  it('pushes the outgoing current onto history, most-recent-first', () => {
    const prev = state({ current: entry('old'), history: ['older'] })
    const { state: next } = reduce(prev, {
      type: 'PLAY_TRACK', file_id: 'n0', list: many(2, 'n'), index: 0, source_label: 'pool',
    })
    expect(next.history).toEqual(['old', 'older'])
  })

  it('discards the queue it replaced — that is what the prompt was about', () => {
    const prev = state({ current: entry('old'), intent: many(7) })
    const { state: next } = reduce(prev, {
      type: 'PLAY_TRACK', file_id: 'n0', list: many(2, 'n'), index: 0, source_label: 'pool',
    })
    expect(next.intent.map((e) => e.file_id)).toEqual(['n1'])
  })

  it('TRUNCATES TO SLOTS — a 60-track list plays its first 24 and reports the rest', () => {
    const list = many(60, 'n')
    const { state: next, added, offered } = reduce(emptyState(), {
      type: 'PLAY_TRACK', file_id: 'n0', list, index: 0, source_label: 'warehouse',
    })
    expect(next.intent).toHaveLength(24)
    expect(next.intent.length + 1).toBe(QUEUE_MAX)
    expect(added).toBe(24)
    expect(offered).toBe(60)
  })

  it('stamps the playing entry as current and the tail with the list origin and label', () => {
    const { state: next } = reduce(emptyState(), {
      type: 'PLAY_TRACK', file_id: 'n0', list: many(3, 'n'), index: 0, source_label: 'pool',
    })
    expect(next.current?.origin).toBe('current')
    expect(next.current?.source_label).toBe('pool')
    expect(next.intent.every((e) => e.origin === 'list')).toBe(true)
    expect(next.intent.every((e) => e.source_label === 'pool')).toBe(true)
  })

  it('finds the track by file_id when the index disagrees with the list', () => {
    const { state: next } = reduce(emptyState(), {
      type: 'PLAY_TRACK', file_id: 'n2', list: many(4, 'n'), index: 0, source_label: 'pool',
    })
    expect(next.current?.file_id).toBe('n2')
    expect(next.intent.map((e) => e.file_id)).toEqual(['n3'])
  })

  it('is a no-op when the track is not in the list at all', () => {
    const prev = state({ current: entry('old'), intent: many(2) })
    const { state: next } = reduce(prev, {
      type: 'PLAY_TRACK', file_id: 'ghost', list: many(3, 'n'), index: 0, source_label: 'pool',
    })
    expect(next.current?.file_id).toBe('old')
    expect(next.intent).toHaveLength(2)
  })

  it('never lets the same track sit in the tail as well as in current', () => {
    const list = [entry('a'), entry('b'), entry('a')]
    const { state: next } = reduce(emptyState(), {
      type: 'PLAY_TRACK', file_id: 'a', list, index: 0, source_label: 'pool',
    })
    expect(next.intent.map((e) => e.file_id)).toEqual(['b'])
  })
})

describe('PLAY_CRATE', () => {
  it('replaces with the crate\'s remaining items in position order', () => {
    const items = many(5, 'c')
    const { state: next } = reduce(state({ intent: many(3) }), {
      type: 'PLAY_CRATE', crate_id: 'cr', items, start: 2, source_label: 'warehouse',
    })
    expect(next.current?.file_id).toBe('c2')
    expect(next.intent.map((e) => e.file_id)).toEqual(['c3', 'c4'])
    expect(next.intent.every((e) => e.origin === 'crate')).toBe(true)
    expect(next.intent.every((e) => e.source_label === 'warehouse')).toBe(true)
  })

  it('starts at the top by default and truncates a 60-track crate to 24', () => {
    const { state: next, added, offered } = reduce(emptyState(), {
      type: 'PLAY_CRATE', crate_id: 'cr', items: many(60, 'c'), start: 0, source_label: 'warehouse',
    })
    expect(next.current?.file_id).toBe('c0')
    expect(next.intent).toHaveLength(24)
    expect({ added, offered }).toEqual({ added: 24, offered: 60 })
  })

  it('is a no-op for an empty crate', () => {
    const prev = state({ current: entry('old') })
    const { state: next } = reduce(prev, {
      type: 'PLAY_CRATE', crate_id: 'cr', items: [], start: 0, source_label: 'warehouse',
    })
    expect(next.current?.file_id).toBe('old')
  })
})

describe('ADD_TO_QUEUE', () => {
  it('APPENDS rather than replacing', () => {
    const prev = state({ current: entry('c'), intent: many(2) })
    const { state: next } = reduce(prev, {
      type: 'ADD_TO_QUEUE', entries: [entry('x', { origin: 'add', source_label: null })],
    })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'x'])
  })

  it('keeps the caller\'s origin and source_label — a crate append is not a track add', () => {
    const { state: next } = reduce(state({ current: entry('c') }), {
      type: 'ADD_TO_QUEUE',
      entries: [entry('x', { origin: 'crate', source_label: 'warehouse' })],
    })
    expect(next.intent[0]).toMatchObject({ origin: 'crate', source_label: 'warehouse' })
  })

  it('REPORTS A PARTIAL APPEND — 17 offered onto 20 queued returns {added: 4, offered: 17}', () => {
    const prev = state({ current: entry('c'), intent: many(20) })
    const result = reduce(prev, { type: 'ADD_TO_QUEUE', entries: many(17, 'x') })
    expect(result.added).toBe(4)
    expect(result.offered).toBe(17)
    expect(result.state.intent).toHaveLength(24)
  })

  it('reports adding nothing when the queue is already full', () => {
    const prev = state({ current: entry('c'), intent: many(24) })
    const result = reduce(prev, { type: 'ADD_TO_QUEUE', entries: many(3, 'x') })
    expect(result.added).toBe(0)
    expect(result.offered).toBe(3)
    expect(result.state.intent).toHaveLength(24)
  })

  it('dedupes against the current track and the existing intent layer', () => {
    const prev = state({ current: entry('c'), intent: [entry('a')] })
    const result = reduce(prev, {
      type: 'ADD_TO_QUEUE', entries: [entry('c'), entry('a'), entry('b')],
    })
    expect(result.state.intent.map((e) => e.file_id)).toEqual(['a', 'b'])
    expect(result.added).toBe(1)
    expect(result.offered).toBe(3)
  })

  it('dedupes the offered list against itself', () => {
    const result = reduce(state({ current: entry('c') }), {
      type: 'ADD_TO_QUEUE', entries: [entry('a'), entry('a')],
    })
    expect(result.state.intent.map((e) => e.file_id)).toEqual(['a'])
  })

  it('lets a track that already played be queued again — history is not a ban list here', () => {
    const prev = state({ current: entry('c'), history: ['a'] })
    const result = reduce(prev, { type: 'ADD_TO_QUEUE', entries: [entry('a')] })
    expect(result.state.intent.map((e) => e.file_id)).toEqual(['a'])
  })
})

describe('SELECT_QUEUE_ENTRY — click-ahead drops what you jumped over', () => {
  const s = state({ current: entry('c'), intent: many(5) })
  const queue = rendered(s) // c, e0..e4

  it('consumes entries 1-2 into history and plays the third', () => {
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 3, queue })
    expect(next.current?.file_id).toBe('e2')
    expect(next.history).toEqual(['c', 'e0', 'e1'])
  })

  it('puts the outgoing current at the front of history — a future PREV wants it there', () => {
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 3, queue })
    expect(next.history[0]).toBe('c')
  })

  it('keeps the intent entries AFTER the click, in order', () => {
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 3, queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e3', 'e4'])
  })

  it('the jumped-over entries do NOT come back', () => {
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 3, queue })
    expect(next.intent.map((e) => e.file_id)).not.toContain('e0')
    expect(next.intent.map((e) => e.file_id)).not.toContain('e1')
  })

  it('clicking an AUTO entry consumes the whole intent layer — you jumped past it', () => {
    const auto = [entry('a0', { origin: 'auto' }), entry('a1', { origin: 'auto' })]
    const withAuto = rendered(s, auto)
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 6, queue: withAuto })
    expect(next.current?.file_id).toBe('a0')
    expect(next.intent).toEqual([])
    expect(next.history).toEqual(['c', 'e0', 'e1', 'e2', 'e3', 'e4'])
  })

  it('drops the auto entries after the click — they regenerate, they are not held', () => {
    const auto = [entry('a0', { origin: 'auto' }), entry('a1', { origin: 'auto' })]
    const { state: next } = reduce(s, {
      type: 'SELECT_QUEUE_ENTRY', index: 6, queue: rendered(s, auto),
    })
    expect(next.intent.map((e) => e.file_id)).not.toContain('a1')
  })

  it('stamps the newly playing entry as current', () => {
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 2, queue })
    expect(next.current?.origin).toBe('current')
  })

  it('is a no-op on index 0 — that is already playing', () => {
    const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 0, queue })
    expect(next.current?.file_id).toBe('c')
    expect(next.intent).toHaveLength(5)
    expect(next.history).toEqual([])
  })

  it('is a no-op for an out-of-range index — it never nulls out current', () => {
    for (const index of [-1, 99]) {
      const { state: next } = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index, queue })
      expect(next.current?.file_id).toBe('c')
      expect(next.intent).toHaveLength(5)
    }
  })
})

describe('SKIP and TRACK_ENDED', () => {
  const s = state({ current: entry('c'), intent: many(3) })
  const queue = rendered(s)

  it('SKIP advances to queue[1]', () => {
    const { state: next } = reduce(s, { type: 'SKIP', queue })
    expect(next.current?.file_id).toBe('e0')
    expect(next.intent.map((e) => e.file_id)).toEqual(['e1', 'e2'])
    expect(next.history).toEqual(['c'])
  })

  it('SKIP is SELECT_QUEUE_ENTRY {index: 1} in state terms', () => {
    const bySkip = reduce(s, { type: 'SKIP', queue }).state
    const bySelect = reduce(s, { type: 'SELECT_QUEUE_ENTRY', index: 1, queue }).state
    expect(bySkip).toEqual(bySelect)
  })

  it('TRACK_ENDED produces the SAME STATE as SKIP — the difference is the marking', () => {
    expect(reduce(s, { type: 'TRACK_ENDED', queue }).state)
      .toEqual(reduce(s, { type: 'SKIP', queue }).state)
  })

  it('and the marking is reported: played, not skipped', () => {
    expect(reduce(s, { type: 'TRACK_ENDED', queue }).advance)
      .toEqual({ file_id: 'c', reason: 'played' })
    expect(reduce(s, { type: 'SKIP', queue }).advance)
      .toEqual({ file_id: 'c', reason: 'skipped' })
  })

  it('STOPS PLAYBACK when the queue is exhausted — method off, nothing left', () => {
    const last = state({ current: entry('last') })
    const { state: next } = reduce(last, { type: 'SKIP', queue: rendered(last) })
    expect(next.current).toBeNull()
    expect(next.intent).toEqual([])
    expect(next.history).toEqual(['last'])
  })

  it('is a no-op when nothing is playing at all', () => {
    const { state: next, advance } = reduce(emptyState(), { type: 'SKIP', queue: [] })
    expect(next.current).toBeNull()
    expect(advance).toBeUndefined()
  })
})

describe('REMOVE_QUEUE_ENTRY', () => {
  const s = state({ current: entry('c'), intent: many(3) })
  const auto = [entry('a0', { origin: 'auto' }), entry('a1', { origin: 'auto' })]
  const queue = rendered(s, auto)

  it('drops an INTENT entry from the intent layer', () => {
    const { state: next } = reduce(s, { type: 'REMOVE_QUEUE_ENTRY', index: 2, queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e0', 'e2'])
    expect(next.suppressed).toEqual([])
  })

  it('SUPPRESSES an AUTO entry instead — or the next regeneration puts it straight back', () => {
    const { state: next } = reduce(s, { type: 'REMOVE_QUEUE_ENTRY', index: 4, queue })
    expect(next.suppressed).toEqual(['a0'])
    expect(next.intent).toHaveLength(3)
  })

  it('refuses to remove what is playing — index 0 is a no-op', () => {
    const { state: next } = reduce(s, { type: 'REMOVE_QUEUE_ENTRY', index: 0, queue })
    expect(next.current?.file_id).toBe('c')
    expect(next.intent).toHaveLength(3)
    expect(next.suppressed).toEqual([])
  })

  it('is a no-op for an out-of-range index', () => {
    for (const index of [-2, 42]) {
      const { state: next } = reduce(s, { type: 'REMOVE_QUEUE_ENTRY', index, queue })
      expect(next.intent).toHaveLength(3)
      expect(next.suppressed).toEqual([])
    }
  })

  it('never suppresses the same id twice', () => {
    const once = reduce(s, { type: 'REMOVE_QUEUE_ENTRY', index: 4, queue }).state
    const twice = reduce(once, { type: 'REMOVE_QUEUE_ENTRY', index: 4, queue }).state
    expect(twice.suppressed).toEqual(['a0'])
  })
})

// `queue[0]` is `current` ONLY WHEN SOMETHING IS PLAYING. A member who uses
// `+ queue` before pressing play — an ordinary thing to do — has a queue whose
// first row is a PIN, and every addressing event must reach it. Guarding on a
// bare `index <= 0` made the drawer render ✕ / ↑ / ↓ on that row and then
// ignore every click; this is the regression suite for that.
describe('index 0 is addressable when nothing is playing', () => {
  const idle = state({ current: null, intent: many(3) })
  const queue = rendered(idle)

  it('renders the first pin at index 0, with no `current` above it', () => {
    expect(queue.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
  })

  it('SELECT_QUEUE_ENTRY {0} plays the first pin', () => {
    const { state: next } = reduce(idle, { type: 'SELECT_QUEUE_ENTRY', index: 0, queue })
    expect(next.current?.file_id).toBe('e0')
    expect(next.intent.map((e) => e.file_id)).toEqual(['e1', 'e2'])
    expect(next.history).toEqual([])
  })

  it('REMOVE_QUEUE_ENTRY {0} drops the first pin', () => {
    const { state: next } = reduce(idle, { type: 'REMOVE_QUEUE_ENTRY', index: 0, queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e1', 'e2'])
  })

  it('MOVE_QUEUE_ENTRY {0, down} moves the first pin', () => {
    const { state: next } = reduce(idle, { type: 'MOVE_QUEUE_ENTRY', index: 0, dir: 'down', queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e1', 'e0', 'e2'])
  })

  it('still refuses index 0 the moment something IS playing', () => {
    const busy = state({ current: entry('c'), intent: many(3) })
    const q = rendered(busy)
    expect(reduce(busy, { type: 'REMOVE_QUEUE_ENTRY', index: 0, queue: q }).state.intent)
      .toHaveLength(3)
    expect(reduce(busy, { type: 'SELECT_QUEUE_ENTRY', index: 0, queue: q }).state.current?.file_id)
      .toBe('c')
    expect(reduce(busy, { type: 'MOVE_QUEUE_ENTRY', index: 0, dir: 'down', queue: q })
      .state.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
  })

  it('still refuses a negative index either way', () => {
    expect(reduce(idle, { type: 'REMOVE_QUEUE_ENTRY', index: -1, queue }).state.intent)
      .toHaveLength(3)
  })
})

describe('MOVE_QUEUE_ENTRY — the drawer\'s ↑ / ↓', () => {
  const s = state({ current: entry('c'), intent: many(3) })
  const auto = [entry('a0', { origin: 'auto' }), entry('a1', { origin: 'auto' })]
  const queue = rendered(s, auto)

  it('swaps a pin with the one above it', () => {
    const { state: next } = reduce(s, { type: 'MOVE_QUEUE_ENTRY', index: 3, dir: 'up', queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e0', 'e2', 'e1'])
  })

  it('swaps a pin with the one below it', () => {
    const { state: next } = reduce(s, { type: 'MOVE_QUEUE_ENTRY', index: 1, dir: 'down', queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e1', 'e0', 'e2'])
  })

  // Layer 2 has no identity across regenerations: an auto entry that "moved"
  // would be re-ranked into a different place by the very next strategy run,
  // so the button would appear to work at random. Only layer 1 has an order
  // the user owns.
  it('refuses to move an AUTO entry — layer 2 has no order to own', () => {
    const { state: next } = reduce(s, { type: 'MOVE_QUEUE_ENTRY', index: 4, dir: 'up', queue })
    expect(next.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
  })

  it('is a no-op at either boundary', () => {
    expect(reduce(s, { type: 'MOVE_QUEUE_ENTRY', index: 1, dir: 'up', queue })
      .state.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
    expect(reduce(s, { type: 'MOVE_QUEUE_ENTRY', index: 3, dir: 'down', queue })
      .state.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
  })

  it('refuses to move what is playing, and any out-of-range index', () => {
    for (const index of [0, -1, 99]) {
      const { state: next } = reduce(s, { type: 'MOVE_QUEUE_ENTRY', index, dir: 'up', queue })
      expect(next.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
      expect(next.current?.file_id).toBe('c')
    }
  })

  it('never mutates the input state', () => {
    const input = frozen(state({ current: entry('c'), intent: many(3) }))
    const { state: next } = reduce(input, { type: 'MOVE_QUEUE_ENTRY', index: 3, dir: 'up', queue })
    expect(input.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
    expect(next.intent).not.toBe(input.intent)
  })

  it('never prompts — reordering is not a replace', () => {
    expect(requiresClearConfirm(s, { type: 'MOVE_QUEUE_ENTRY', index: 3, dir: 'up', queue }))
      .toBe(false)
  })
})

describe('TRACK_FAILED', () => {
  const s = state({ current: entry('c'), intent: many(2) })
  const queue = rendered(s)

  it('excludes and advances in ONE step', () => {
    const { state: next } = reduce(s, { type: 'TRACK_FAILED', file_id: 'c', queue })
    expect(next.failed).toEqual(['c'])
    expect(next.current?.file_id).toBe('e0')
  })

  it('marks the advance as a failure, not as a play', () => {
    expect(reduce(s, { type: 'TRACK_FAILED', file_id: 'c', queue }).advance)
      .toEqual({ file_id: 'c', reason: 'failed' })
  })

  it('never records the failed id twice', () => {
    const once = reduce(s, { type: 'TRACK_FAILED', file_id: 'c', queue }).state
    const twice = reduce(once, { type: 'TRACK_FAILED', file_id: 'c', queue: rendered(once) }).state
    expect(twice.failed).toEqual(['c'])
  })

  it('stops playback when the failure was the last entry', () => {
    const last = state({ current: entry('x') })
    const { state: next } = reduce(last, {
      type: 'TRACK_FAILED', file_id: 'x', queue: rendered(last),
    })
    expect(next.current).toBeNull()
    expect(next.failed).toEqual(['x'])
  })
})

describe('SET_METHOD — a strategy switch NEVER touches layer 1', () => {
  it('changes exactly one field', () => {
    const prev = state({ current: entry('c'), intent: many(6), history: ['h'], failed: ['f'] })
    const { state: next } = reduce(prev, { type: 'SET_METHOD', method: 'harmonic' })
    expect(next.method).toBe('harmonic')
    expect(next.current).toEqual(prev.current)
    expect(next.history).toEqual(prev.history)
    expect(next.failed).toEqual(prev.failed)
  })

  it('LEAVES THE PINS IDENTICAL BY VALUE — the pins-survive-a-switch proof', () => {
    const prev = state({ current: entry('c'), intent: many(6) })
    const { state: next } = reduce(prev, { type: 'SET_METHOD', method: 'shuffle' })
    expect(next.intent).toEqual(prev.intent)
    expect(next.intent).toStrictEqual(prev.intent)
  })

  it('survives a round trip through every method', () => {
    let s = state({ current: entry('c'), intent: many(4) })
    for (const method of ['harmonic', 'bpm', 'shuffle', 'off'] as const) {
      s = reduce(s, { type: 'SET_METHOD', method }).state
      expect(s.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2', 'e3'])
    }
  })
})

describe('CLEAR_QUEUE', () => {
  it('empties layer 1 and keeps playing', () => {
    const prev = state({ current: entry('c'), intent: many(9) })
    const { state: next } = reduce(prev, { type: 'CLEAR_QUEUE' })
    expect(next.intent).toEqual([])
    expect(next.current?.file_id).toBe('c')
  })

  it('leaves history and suppression alone', () => {
    const prev = state({ current: entry('c'), intent: many(2), history: ['h'], suppressed: ['s'] })
    const { state: next } = reduce(prev, { type: 'CLEAR_QUEUE' })
    expect(next.history).toEqual(['h'])
    expect(next.suppressed).toEqual(['s'])
  })
})

describe('the reducer is pure', () => {
  const s = frozen(state({ current: entry('c'), intent: many(4), history: ['h'], failed: ['f'], suppressed: ['s'] }))
  const queue = rendered(s)

  const events: QueueEvent[] = [
    { type: 'PLAY_TRACK', file_id: 'n0', list: many(3, 'n'), index: 0, source_label: 'pool' },
    { type: 'PLAY_CRATE', crate_id: 'cr', items: many(3, 'n'), start: 0, source_label: 'w' },
    { type: 'ADD_TO_QUEUE', entries: many(2, 'x') },
    { type: 'SELECT_QUEUE_ENTRY', index: 2, queue },
    { type: 'SKIP', queue },
    { type: 'TRACK_ENDED', queue },
    { type: 'REMOVE_QUEUE_ENTRY', index: 1, queue },
    { type: 'TRACK_FAILED', file_id: 'c', queue },
    { type: 'SET_METHOD', method: 'harmonic' },
    { type: 'CLEAR_QUEUE' },
  ]

  for (const e of events) {
    it(`${e.type} produces a NEW state and never mutates the old one`, () => {
      const { state: next } = reduce(s, e)
      expect(next).not.toBe(s)
      expect(next.intent).not.toBe(s.intent)
      expect(next.history).not.toBe(s.history)
      expect(s.intent).toHaveLength(4)
      expect(s.history).toEqual(['h'])
    })

    it(`${e.type} never leaves the intent layer over the cap`, () => {
      const { state: next } = reduce(s, e)
      const slots = QUEUE_MAX - (next.current === null ? 0 : 1)
      expect(next.intent.length).toBeLessThanOrEqual(slots)
    })
  }

  it('bounds history so a long session cannot grow localStorage without limit', () => {
    let s2 = state({ current: entry('c'), history: Array.from({ length: HISTORY_MAX }, (_, i) => `h${i}`) })
    s2 = reduce(s2, { type: 'SKIP', queue: rendered(s2) }).state
    expect(s2.history).toHaveLength(HISTORY_MAX)
    expect(s2.history[0]).toBe('c')
  })
})

// ------------------------------------------------------- §3.3 / regenerate

describe('seedFor — the seed is the LAST forward entry, not current', () => {
  it('is the last pin when the intent layer is non-empty', () => {
    const s = state({
      current: entry('c', { key_camelot: '8A' }),
      intent: [entry('p0', { key_camelot: '1A' }), entry('p1', { key_camelot: '3B' })],
    })
    expect(seedFor(s)?.file_id).toBe('p1')
    expect(seedFor(s)?.key_camelot).toBe('3B')
  })

  it('falls back to current when nothing is pinned', () => {
    expect(seedFor(state({ current: entry('c') }))?.file_id).toBe('c')
  })

  it('is null when nothing is playing and nothing is pinned', () => {
    expect(seedFor(emptyState())).toBeNull()
  })
})

describe('regenerate', () => {
  const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => feature(`k${i}`, { bpm: 128 + i * 0.1 }))

  it('METHOD OFF CALLS NO PORT — the default path issues zero requests', async () => {
    const port = port$(async () => candidates(10))
    const s = state({ current: entry('c') })
    expect(s.method).toBe('off')
    const queue = await regenerate(s, port)
    expect(port).not.toHaveBeenCalled()
    expect(queue.map((e) => e.file_id)).toEqual(['c'])
  })

  it('calls no port when need is 0 — the user\'s choices won the cap outright', async () => {
    const port = port$(async () => candidates(10))
    const s = state({ current: entry('c'), intent: many(24), method: 'harmonic' })
    const queue = await regenerate(s, port)
    expect(port).not.toHaveBeenCalled()
    expect(queue).toHaveLength(25)
  })

  it('CALLS THE PORT WITH THE LAST PIN, not with current (§3.3)', async () => {
    const port = port$(async () => candidates(4))
    const s = state({
      current: entry('c', { key_camelot: '8A', bpm: 128 }),
      intent: [
        entry('p0', { key_camelot: '1A' }),
        entry('p1', { key_camelot: '5B' }),
        entry('p2', { key_camelot: '11A', bpm: 96 }),
      ],
      method: 'harmonic',
    })
    await regenerate(s, port)
    expect(port).toHaveBeenCalledTimes(1)
    const [seed, need] = port.mock.calls[0]
    expect(seed?.file_id).toBe('p2')
    expect(seed?.key_camelot).toBe('11A')
    expect(seed?.bpm).toBe(96)
    expect(need).toBe(21)
  })

  it('fills the tail up to need and no further', async () => {
    const port = port$(async () => candidates(50))
    const s = state({ current: entry('c'), intent: many(4), method: 'harmonic' })
    const queue = await regenerate(s, port)
    expect(queue).toHaveLength(QUEUE_MAX)
    expect(queue.filter((e) => e.origin === 'auto')).toHaveLength(20)
  })

  it('labels auto entries with the active method, for the drawer\'s third section', async () => {
    const port = port$(async () => candidates(3))
    const s = state({ current: entry('c'), method: 'shuffle' })
    const queue = await regenerate(s, port)
    const auto = queue.filter((e) => e.origin === 'auto')
    expect(auto.length).toBeGreaterThan(0)
    expect(auto.every((e) => e.source_label === 'SHUFFLE')).toBe(true)
  })

  it('EXCLUDES current, intent, history, failed and suppressed before the strategy sees them', async () => {
    const port = port$(async () => [
      feature('c'), feature('e0'), feature('h'), feature('f'), feature('s'), feature('good'),
    ])
    const st = state({
      current: entry('c'), intent: [entry('e0')],
      history: ['h'], failed: ['f'], suppressed: ['s'], method: 'harmonic',
    })
    const queue = await regenerate(st, port)
    expect(queue.map((e) => e.file_id)).toEqual(['c', 'e0', 'good'])
  })

  it('returns a SHORT queue when exclusions ate the candidates — §1.3 case 4', async () => {
    const port = port$(async () => [feature('h0'), feature('h1')])
    const st = state({ current: entry('c'), history: ['h0', 'h1'], method: 'harmonic' })
    expect(await regenerate(st, port)).toHaveLength(1)
  })

  it('SUPPRESSION HOLDS — a removed auto entry is not re-picked by the very next regenerate', async () => {
    const port = port$(async () => [feature('a0'), feature('a1')])
    const before = state({ current: entry('c'), method: 'harmonic' })
    const queue = await regenerate(before, port)
    expect(queue.map((e) => e.file_id)).toContain('a0')

    const { state: after } = reduce(before, {
      type: 'REMOVE_QUEUE_ENTRY',
      index: queue.findIndex((e) => e.file_id === 'a0'),
      queue,
    })
    expect(after.suppressed).toEqual(['a0'])
    const requeued = await regenerate(after, port)
    expect(requeued.map((e) => e.file_id)).not.toContain('a0')
  })

  it('FALLS BACK FROM HARMONIC TO BPM EXACTLY ONCE — two strategy calls, ONE port call', async () => {
    const pool = candidates(3)
    const port = port$(async () => pool)
    const harmonic = vi.spyOn(STRATEGIES.harmonic, 'select')
    const bpm = vi.spyOn(STRATEGIES.bpm, 'select')
    // harmonic returns short on purpose; the engine must top up ONCE.
    harmonic.mockReturnValue(['k0'])

    const s = state({ current: entry('c'), method: 'harmonic' })
    const queue = await regenerate(s, port)

    expect(port).toHaveBeenCalledTimes(1)
    expect(harmonic).toHaveBeenCalledTimes(1)
    expect(bpm).toHaveBeenCalledTimes(1)
    expect(queue.map((e) => e.file_id)).toEqual(['c', 'k0', 'k1', 'k2'])
  })

  it('does not re-pick what the first strategy already chose during the fallback', async () => {
    const port = port$(async () => candidates(3))
    vi.spyOn(STRATEGIES.harmonic, 'select').mockReturnValue(['k2'])
    const queue = await regenerate(state({ current: entry('c'), method: 'harmonic' }), port)
    const ids = queue.map((e) => e.file_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[1]).toBe('k2')
  })

  it('does NOT fall back when the strategy filled its need', async () => {
    const port = port$(async () => candidates(30))
    const bpm = vi.spyOn(STRATEGIES.bpm, 'select')
    await regenerate(state({ current: entry('c'), method: 'harmonic' }), port)
    expect(bpm).not.toHaveBeenCalled()
  })

  it('does NOT fall back from bpm or shuffle — the map declares one hop, not a chain', async () => {
    const port = port$(async () => candidates(2))
    const harmonic = vi.spyOn(STRATEGIES.harmonic, 'select')
    await regenerate(state({ current: entry('c'), method: 'bpm' }), port)
    await regenerate(state({ current: entry('c'), method: 'shuffle' }), port)
    expect(harmonic).not.toHaveBeenCalled()
  })

  it('survives a port that throws — a dead tail must never break what is playing', async () => {
    const port = port$(async () => { throw new Error('offline') })
    const s = state({ current: entry('c'), intent: many(2), method: 'harmonic' })
    const queue = await regenerate(s, port)
    expect(queue.map((e) => e.file_id)).toEqual(['c', 'e0', 'e1'])
  })

  it('does not mutate the state it regenerates from', async () => {
    const port = port$(async () => candidates(5))
    const s = frozen(state({ current: entry('c'), intent: many(2), method: 'harmonic' }))
    await expect(regenerate(s, port)).resolves.toBeDefined()
    expect(s.intent).toHaveLength(2)
  })

  it('is deterministic — the same state and candidates give the same queue', async () => {
    const port = port$(async () => candidates(30))
    const s = state({ current: entry('c'), method: 'harmonic' })
    const a = await regenerate(s, port)
    const b = await regenerate(s, port)
    expect(a.map((e) => e.file_id)).toEqual(b.map((e) => e.file_id))
  })
})
