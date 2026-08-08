// src/lib/queue-store.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getState, isStale, parseState, QUEUE_MEMORY_KEY, QUEUE_MEMORY_TTL_MS,
  QUEUE_SCHEMA_VERSION, restoredState, serializeState, setState, stateFromEntry, subscribe,
  type QueueMemoryEntry,
} from './queue-store'
import {
  emptyState, HISTORY_MAX, QUEUE_MAX, type QueueEntry, type QueueState,
} from './queue-model'
import { PLAYER_MEMORY_TTL_MS } from './player-memory'

const NOW = Date.parse('2026-08-05T12:00:00.000Z')

const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  file_id: id,
  // Explicitly null rather than absent: `projectEntry` normalises an absent
  // recording to null on the way out, so a fixture that omitted it would make
  // every round-trip assertion below fail for the wrong reason.
  track_id: null,
  display_artist: 'artist',
  display_title: id,
  duration_ms: 300_000,
  bpm: 128,
  key_camelot: '8A',
  origin: 'list',
  source_label: 'pool',
  ...over,
})

const many = (n: number, prefix = 'e'): QueueEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`))

const state = (over: Partial<QueueState> = {}): QueueState => ({ ...emptyState(), ...over })

beforeEach(() => {
  setState(emptyState())
})

// UX.12's paid-for lesson, made into a build failure rather than a comment.
// The upload chip's store was split from its engine because Shell.astro mounts
// it on every page; the queue drawer has the same problem and the same fix.
// A commit message cannot fail a build — astro-forms.test.ts is the precedent.
describe('THE STORE MUST NOT DRAG THE ENGINE INTO EVERY PAGE', () => {
  const source = readFileSync(new URL('./queue-store.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])

  it('imports queue-model and nothing else', () => {
    expect(imports).toEqual(['./queue-model'])
  })

  it('names neither the strategies nor the engine nor the candidate client', () => {
    // Shell.astro renders the drawer on EVERY page. Pulling the engine in here
    // would ship the harmonic scorer and the Camelot wheel to /login.
    for (const forbidden of ['./queue-engine', './queue-strategies', './queue-candidates']) {
      expect(imports).not.toContain(forbidden)
    }
  })

  it('touches localStorage nowhere — this is the pure half, site.ts owns get/setItem', () => {
    // Comments stripped first: the header DISCUSSES localStorage at length,
    // which is the point. What must not exist is a call.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('localStorage')
    expect(code).not.toContain('document')
    expect(code).not.toContain('fetch(')
  })
})

describe('the key and the TTL match player-memory\'s conventions', () => {
  it('sits beside localchune:player:v1', () => {
    expect(QUEUE_MEMORY_KEY).toBe('localchune:queue:v1')
  })

  it('ages out after the same 14 days', () => {
    expect(QUEUE_MEMORY_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(QUEUE_MEMORY_TTL_MS).toBe(PLAYER_MEMORY_TTL_MS)
  })
})

describe('serializeState / parseState round trip', () => {
  const rich = state({
    current: entry('cur', { origin: 'current' }),
    intent: [entry('i0'), entry('i1', { origin: 'crate', source_label: 'warehouse' })],
    method: 'harmonic',
    history: ['h0', 'h1'],
    failed: ['f0'],
    suppressed: ['s0'],
  })

  it('restores current, intent, method and history — and NOTHING else', () => {
    const parsed = parseState(serializeState(rich, NOW))
    expect(parsed).not.toBeNull()
    expect(stateFromEntry(parsed as QueueMemoryEntry)).toEqual({
      ...rich,
      // The auto layer is not in the state at all — it is derived. `failed`
      // and `suppressed` are session-scoped: §5 enumerates exactly four
      // restored fields, and a track that failed to decode a fortnight ago
      // deserves another chance.
      failed: [],
      suppressed: [],
    })
  })

  it('drops suppressed and failed from the payload entirely, not just from the parse', () => {
    const raw = serializeState(rich, NOW)
    expect(raw).not.toContain('s0')
    expect(raw).not.toContain('f0')
    expect(raw).not.toContain('suppressed')
  })

  it('stamps updated_at and the schema version', () => {
    const parsed = parseState(serializeState(rich, NOW)) as QueueMemoryEntry
    expect(parsed.v).toBe(QUEUE_SCHEMA_VERSION)
    expect(Date.parse(parsed.updated_at)).toBe(NOW)
  })

  it('round-trips an empty state', () => {
    const parsed = parseState(serializeState(emptyState(), NOW)) as QueueMemoryEntry
    expect(stateFromEntry(parsed)).toEqual(emptyState())
  })

  it('round-trips a null current', () => {
    const s = state({ intent: many(2), method: 'shuffle' })
    const parsed = parseState(serializeState(s, NOW)) as QueueMemoryEntry
    expect(stateFromEntry(parsed).current).toBeNull()
    expect(stateFromEntry(parsed).method).toBe('shuffle')
  })
})

describe('NO URL EVER REACHES localStorage', () => {
  it('carries no http and no X-Amz for an ordinary queue', () => {
    const raw = serializeState(state({
      current: entry('cur'), intent: many(4), history: ['h'],
    }), NOW)
    expect(raw).not.toContain('http')
    expect(raw).not.toContain('X-Amz')
  })

  it('STRIPS a rogue url property rather than trusting the entry it was handed', () => {
    // A presigned GET lives one hour; this payload lives fourteen days. The
    // rule player-memory.ts states in prose is enforced here by projection:
    // serialize writes the known fields and nothing else.
    const contaminated = {
      ...entry('cur'),
      url: 'https://r2.example/x?X-Amz-Signature=deadbeef',
      signed_url: 'https://r2.example/y',
    } as QueueEntry
    const raw = serializeState(state({ current: contaminated, intent: [contaminated] }), NOW)
    expect(raw).not.toContain('http')
    expect(raw).not.toContain('X-Amz')
    expect(raw).not.toContain('signed_url')
  })

  it('keeps the fields the drawer actually renders', () => {
    const raw = serializeState(state({ current: entry('cur') }), NOW)
    const parsed = parseState(raw) as QueueMemoryEntry
    expect(parsed.current).toEqual(entry('cur'))
  })
})

describe('parseState is total — it returns null, it never throws', () => {
  const bad: Array<[string, string | null]> = [
    ['a missing key', null],
    ['an empty string', ''],
    ['corrupt JSON', '{"v":1,'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['JSON null', 'null'],
    ['a number', '42'],
    ['no version', JSON.stringify({ current: null, intent: [], method: 'off', history: [] })],
    ['a FUTURE schema version', JSON.stringify({
      v: QUEUE_SCHEMA_VERSION + 1, current: null, intent: [], method: 'off',
      history: [], updated_at: new Date(NOW).toISOString(),
    })],
    ['an older schema version', JSON.stringify({
      v: 0, current: null, intent: [], method: 'off', history: [],
      updated_at: new Date(NOW).toISOString(),
    })],
    ['intent that is not an array', JSON.stringify({
      v: 1, current: null, intent: 'nope', method: 'off', history: [],
      updated_at: new Date(NOW).toISOString(),
    })],
    ['history holding non-strings', JSON.stringify({
      v: 1, current: null, intent: [], method: 'off', history: [1, 2],
      updated_at: new Date(NOW).toISOString(),
    })],
    ['an entry with no file_id', JSON.stringify({
      v: 1, current: null, intent: [{ display_title: 'x' }], method: 'off',
      history: [], updated_at: new Date(NOW).toISOString(),
    })],
    ['an entry with a numeric title', JSON.stringify({
      v: 1, current: null, intent: [{ ...entry('a'), display_title: 7 }], method: 'off',
      history: [], updated_at: new Date(NOW).toISOString(),
    })],
    ['an unparseable updated_at', JSON.stringify({
      v: 1, current: null, intent: [], method: 'off', history: [], updated_at: 'whenever',
    })],
    ['a missing updated_at', JSON.stringify({ v: 1, current: null, intent: [], method: 'off', history: [] })],
  ]

  for (const [name, raw] of bad) {
    it(`returns null for ${name}`, () => {
      expect(() => parseState(raw)).not.toThrow()
      expect(parseState(raw)).toBeNull()
    })
  }

  it('repairs a bad origin rather than losing the queue over it', () => {
    const raw = JSON.stringify({
      v: 1, current: null, intent: [{ ...entry('a'), origin: 'telepathy' }],
      method: 'off', history: [], updated_at: new Date(NOW).toISOString(),
    })
    const parsed = parseState(raw) as QueueMemoryEntry
    expect(parsed.intent[0].origin).toBe('list')
  })

  it('accepts the nulls the schema genuinely allows', () => {
    const s = state({ current: entry('c', { display_artist: null, duration_ms: null, bpm: null, key_camelot: null, source_label: null }) })
    expect(parseState(serializeState(s, NOW))).not.toBeNull()
  })
})

describe('an unknown method falls back to off, never to a strategy the build no longer ships', () => {
  const withMethod = (method: unknown) => JSON.stringify({
    v: 1, current: null, intent: [], method, history: [],
    updated_at: new Date(NOW).toISOString(),
  })

  it('repairs a method this build has never heard of', () => {
    expect((parseState(withMethod('genre')) as QueueMemoryEntry).method).toBe('off')
    expect((parseState(withMethod('artist_map')) as QueueMemoryEntry).method).toBe('off')
  })

  it('repairs a non-string method', () => {
    expect((parseState(withMethod(7)) as QueueMemoryEntry).method).toBe('off')
    expect((parseState(withMethod(null)) as QueueMemoryEntry).method).toBe('off')
  })

  it('keeps every method the build DOES ship', () => {
    for (const m of ['off', 'harmonic', 'bpm', 'shuffle']) {
      expect((parseState(withMethod(m)) as QueueMemoryEntry).method).toBe(m)
    }
  })
})

describe('THE CAP IS ENFORCED ON THE WAY IN', () => {
  const handEdited = (n: number, withCurrent: boolean) => JSON.stringify({
    v: 1,
    current: withCurrent ? entry('cur') : null,
    intent: Array.from({ length: n }, (_, i) => entry(`e${i}`)),
    method: 'off',
    history: [],
    updated_at: new Date(NOW).toISOString(),
  })

  it('a hand-edited payload with 10 000 intent entries parses to 24 with a current', () => {
    const parsed = parseState(handEdited(10_000, true)) as QueueMemoryEntry
    expect(parsed.intent).toHaveLength(24)
    expect(parsed.intent.length + 1).toBe(QUEUE_MAX)
  })

  it('and to 25 with nothing playing', () => {
    expect((parseState(handEdited(10_000, false)) as QueueMemoryEntry).intent).toHaveLength(25)
  })

  it('keeps the first entries, so a restored queue starts where it left off', () => {
    const parsed = parseState(handEdited(50, true)) as QueueMemoryEntry
    expect(parsed.intent[0].file_id).toBe('e0')
  })

  it('bounds a hand-edited history too', () => {
    const raw = JSON.stringify({
      v: 1, current: null, intent: [], method: 'off',
      history: Array.from({ length: 5_000 }, (_, i) => `h${i}`),
      updated_at: new Date(NOW).toISOString(),
    })
    expect((parseState(raw) as QueueMemoryEntry).history).toHaveLength(HISTORY_MAX)
  })

  it('never writes more than the cap either', () => {
    const parsed = parseState(serializeState(state({
      current: entry('cur'), intent: many(200),
    }), NOW)) as QueueMemoryEntry
    expect(parsed.intent.length).toBeLessThanOrEqual(24)
  })
})

describe('isStale — separate from unparseable, exactly as player-memory does it', () => {
  const fresh = parseState(serializeState(state({ current: entry('c') }), NOW)) as QueueMemoryEntry

  it('is fresh the moment it is written', () => {
    expect(isStale(fresh, NOW)).toBe(false)
  })

  it('is fresh at exactly the TTL', () => {
    expect(isStale(fresh, NOW + QUEUE_MEMORY_TTL_MS)).toBe(false)
  })

  it('is STALE one millisecond past it', () => {
    expect(isStale(fresh, NOW + QUEUE_MEMORY_TTL_MS + 1)).toBe(true)
  })

  it('treats an unparseable timestamp as stale — the safe default', () => {
    expect(isStale({ ...fresh, updated_at: 'whenever' }, NOW)).toBe(true)
  })

  it('a stale payload still PARSES — staleness is the caller\'s decision', () => {
    const old = serializeState(state({ current: entry('c') }), NOW - QUEUE_MEMORY_TTL_MS - 1)
    const parsed = parseState(old)
    expect(parsed).not.toBeNull()
    expect(isStale(parsed as QueueMemoryEntry, NOW)).toBe(true)
  })
})

describe('restoredState — UX.9 resume, and what it deliberately does not do', () => {
  const saved = (over: Partial<QueueState> = {}): string =>
    serializeState(state({ current: entry('c'), intent: many(3), ...over }), NOW)

  it('restores exactly the four persisted fields', () => {
    const { state: s } = restoredState(saved({ method: 'harmonic', history: ['h1'] }), NOW)
    expect(s.current?.file_id).toBe('c')
    expect(s.intent.map((e) => e.file_id)).toEqual(['e0', 'e1', 'e2'])
    expect(s.method).toBe('harmonic')
    expect(s.history).toEqual(['h1'])
  })

  // §5 enumerates four restored fields. `failed` is not one of them, and the
  // reason is better than symmetry: a track that failed to decode a fortnight
  // ago deserves another go. `suppressed` is session-scoped by definition.
  it('starts `failed` and `suppressed` empty, every time', () => {
    const { state: s } = restoredState(saved(), NOW)
    expect(s.failed).toEqual([])
    expect(s.suppressed).toEqual([])
  })

  // THE AUTO TAIL IS NOT PERSISTED AND NOT RECOMPUTED AT LOAD. A 14-day-old
  // harmonic tail is stale — the pool grew — and recomputing it on load would
  // put a pool_list call on every returning member's first paint for a drawer
  // they may never open.
  it('needs hydration only when a method is actually selected', () => {
    expect(restoredState(saved({ method: 'harmonic' }), NOW).needsHydration).toBe(true)
    expect(restoredState(saved({ method: 'bpm' }), NOW).needsHydration).toBe(true)
    expect(restoredState(saved({ method: 'shuffle' }), NOW).needsHydration).toBe(true)
  })

  // THE DEFAULT PATH COSTS NOTHING. With `off`, there is no tail to hydrate,
  // so a returning member who never touches the drawer issues zero
  // queue-related requests — not one deferred, ZERO.
  it('is false for the default method — nothing to hydrate at all', () => {
    expect(restoredState(saved({ method: 'off' }), NOW).needsHydration).toBe(false)
  })

  it('returns a fresh empty state for a stale payload, and asks for no hydration', () => {
    const old = serializeState(state({ current: entry('c'), method: 'harmonic' }), NOW)
    const result = restoredState(old, NOW + QUEUE_MEMORY_TTL_MS + 1)
    expect(result.state).toEqual(emptyState())
    expect(result.needsHydration).toBe(false)
    expect(result.stale).toBe(true)
  })

  it.each([
    ['null', null],
    ['empty', ''],
    ['corrupt JSON', '{oh no'],
    ['an array', '[]'],
    ['a future schema', JSON.stringify({ v: 99, current: null, intent: [], history: [], method: 'off', updated_at: new Date(NOW).toISOString() })],
  ])('returns an empty state for %s, and never throws', (_name, raw) => {
    const result = restoredState(raw, NOW)
    expect(result.state).toEqual(emptyState())
    expect(result.needsHydration).toBe(false)
  })

  it('distinguishes "nothing saved" from "saved but expired"', () => {
    expect(restoredState(null, NOW).stale).toBe(false)
    const old = serializeState(state({ current: entry('c') }), NOW)
    expect(restoredState(old, NOW + QUEUE_MEMORY_TTL_MS + 1).stale).toBe(true)
  })

  // localStorage is the one place a backlog could sneak past §1.2, and
  // restoredState is the door it would come through.
  it('re-applies the cap on the way in', () => {
    const huge = JSON.stringify({
      v: QUEUE_SCHEMA_VERSION,
      current: entry('c'),
      intent: many(10000),
      method: 'off',
      history: [],
      updated_at: new Date(NOW).toISOString(),
    })
    expect(restoredState(huge, NOW).state.intent.length).toBe(QUEUE_MAX - 1)
  })

  it('composes the pieces rather than reimplementing them', () => {
    const raw = saved({ method: 'harmonic' })
    const parsed = parseState(raw)
    expect(parsed).not.toBeNull()
    expect(restoredState(raw, NOW).state).toEqual(stateFromEntry(parsed as QueueMemoryEntry))
  })
})

describe('the module singleton', () => {
  it('starts empty, with autoplay off', () => {
    expect(getState()).toEqual(emptyState())
    expect(getState().method).toBe('off')
  })

  it('setState replaces what getState returns', () => {
    const next = state({ current: entry('c') })
    setState(next)
    expect(getState().current?.file_id).toBe('c')
  })

  it('notifies every subscriber with the new state', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribe(a)
    subscribe(b)
    const next = state({ current: entry('c') })
    setState(next)
    expect(a).toHaveBeenCalledWith(next)
    expect(b).toHaveBeenCalledWith(next)
  })

  it('does not fire on subscribe — the caller renders once itself', () => {
    const fn = vi.fn()
    subscribe(fn)
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns an unsubscribe that actually stops the notifications', () => {
    const fn = vi.fn()
    const off = subscribe(fn)
    setState(state({ current: entry('a') }))
    off()
    setState(state({ current: entry('b') }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('A THROWING LISTENER DOES NOT STOP THE OTHERS — a bad render must not stop the music', () => {
    const boom = vi.fn(() => { throw new Error('render failed') })
    const ok = vi.fn()
    subscribe(boom)
    subscribe(ok)
    expect(() => setState(state({ current: entry('c') }))).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing twice is harmless', () => {
    const off = subscribe(vi.fn())
    off()
    expect(() => off()).not.toThrow()
  })
})
