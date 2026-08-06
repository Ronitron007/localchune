// src/lib/queue-view.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { QUEUE_MAX, emptyState, type QueueEntry, type QueueState } from './queue-model'
import {
  CRATE_TRACK_KEYS, LOOKAHEAD_S, appendReport, entryTitle, nextSourceLookahead,
  readListContext, renderQueueSections, toCrateTrack, toQueueEntry, truncationLine,
  type QueueRowData,
} from './queue-view'

const row = (over: Partial<QueueRowData> & { file_id: string }): QueueRowData => ({
  artist: 'Artist',
  title: 'Title',
  duration_ms: '240000',
  bpm: '128',
  key_camelot: '8A',
  ...over,
})

describe('toQueueEntry — dataset strings onto the model', () => {
  it('parses the numeric fields out of their string form', () => {
    const e = toQueueEntry(row({ file_id: 'a' }), 'list', 'pool')
    expect(e).toEqual({
      file_id: 'a',
      display_artist: 'Artist',
      display_title: 'Title',
      duration_ms: 240000,
      bpm: 128,
      key_camelot: '8A',
      origin: 'list',
      source_label: 'pool',
    } satisfies QueueEntry)
  })

  it('takes numbers as readily as strings — a JSON route sends numbers', () => {
    const e = toQueueEntry(
      { file_id: 'a', title: 'T', artist: null, duration_ms: 1000, bpm: 90, key_camelot: null },
      'crate', 'warehouse',
    )
    expect(e.duration_ms).toBe(1000)
    expect(e.bpm).toBe(90)
    expect(e.display_artist).toBeNull()
    expect(e.key_camelot).toBeNull()
  })

  // An unanalysed track has no bpm and no key, and its row renders empty
  // strings for both. Neither may become NaN or "" on the entry: §1.3 case 5
  // needs `bpm === null` to be a real null so the strategies can price it.
  it.each([
    ['empty string', ''],
    ['whitespace', '  '],
    ['unparseable', 'n/a'],
    ['absent', undefined],
    ['null', null],
  ])('an %s bpm/duration becomes null, never NaN', (_name, raw) => {
    const e = toQueueEntry(
      { file_id: 'a', title: 'T', bpm: raw as string, duration_ms: raw as string },
      'list', null,
    )
    expect(e.bpm).toBeNull()
    expect(e.duration_ms).toBeNull()
  })

  // A key is NOT a number: an off-wheel string survives as itself and is
  // priced by UNKNOWN_KEY_PENALTY downstream, exactly as pool_list's own
  // key column would deliver it. Only "no value at all" becomes null.
  it.each([['empty string', ''], ['whitespace', '  '], ['absent', undefined], ['null', null]])(
    'an %s key becomes null', (_name, raw) => {
      expect(toQueueEntry({ file_id: 'a', key_camelot: raw as string }, 'list', null).key_camelot)
        .toBeNull()
    },
  )

  it('keeps an off-wheel key string rather than discarding it', () => {
    expect(toQueueEntry({ file_id: 'a', key_camelot: 'n/a' }, 'list', null).key_camelot).toBe('n/a')
  })

  it('a missing title degrades to the empty string rather than "undefined"', () => {
    const e = toQueueEntry({ file_id: 'a' }, 'add', null)
    expect(e.display_title).toBe('')
    expect(e.display_artist).toBeNull()
  })
})

describe('toCrateTrack — the crate route\'s wire projection', () => {
  // crate_get returns pool_get's entire column list. The queue needs six
  // fields. This is the same guard queue-candidates.test.ts puts on
  // toTrackFeatures, on the same migration-20 argument: a projection that
  // leaks is a narrowing undone.
  it('emits exactly the six queue fields and drops every other column', () => {
    const out = toCrateTrack({
      position: 3,
      file_id: 'f1',
      display_artist: 'A',
      display_title: 'T',
      duration_ms: 1000,
      bpm: 128,
      key_camelot: '8A',
      // everything below must not survive
      uploaded_by: 'u1',
      uploader_name: 'someone',
      original_filename: 'private-name.flac',
      r2_key: 'audio/f1',
      preview_key: 'derived/f1/preview.opus',
      provenance: 'secret',
      integrated_lufs: -9.2,
      liked_by_me: true,
    })
    expect(Object.keys(out).sort()).toEqual([...CRATE_TRACK_KEYS].sort())
    expect(out).toEqual({
      file_id: 'f1', artist: 'A', title: 'T', duration_ms: 1000, bpm: 128, key_camelot: '8A',
    })
  })

  it('survives a row with nulls where the analysis never landed', () => {
    const out = toCrateTrack({
      file_id: 'f2', display_artist: null, display_title: 'T2',
      duration_ms: null, bpm: null, key_camelot: null,
    })
    expect(out).toEqual({
      file_id: 'f2', artist: null, title: 'T2', duration_ms: null, bpm: null, key_camelot: null,
    })
  })
})

describe('readListContext — the clicked row and everything after it', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => row({ file_id: id }))

  it('finds the clicked entry and stamps the whole list', () => {
    const ctx = readListContext(rows, 'c', 'pool')
    expect(ctx.index).toBe(2)
    expect(ctx.list.map((e) => e.file_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(ctx.source_label).toBe('pool')
    expect(ctx.list.every((e) => e.origin === 'list')).toBe(true)
    expect(ctx.list.every((e) => e.source_label === 'pool')).toBe(true)
  })

  // A row rendered twice (it cannot be, today) or a list scraped across two
  // tables must not put the same file in the queue twice: `reduce` dedupes
  // the intent layer, but the INDEX would already be wrong by then.
  it('dedupes by file_id, keeping the first occurrence', () => {
    const ctx = readListContext([...rows, row({ file_id: 'b' })], 'b', 'pool')
    expect(ctx.list.map((e) => e.file_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(ctx.index).toBe(1)
  })

  // The play link on /track/[id] and on /review sits in no list container at
  // all. That is a one-entry list, not an error — and index 0 with a
  // one-entry list is exactly "play this, queue nothing".
  it('an empty row set still yields the clicked track alone when given one', () => {
    const ctx = readListContext([], 'z', null)
    expect(ctx.list).toEqual([])
    expect(ctx.index).toBe(-1)
  })

  it('reports index -1 when the clicked id is not in the rows', () => {
    expect(readListContext(rows, 'zz', 'pool').index).toBe(-1)
  })

  it('drops rows with no file_id rather than queueing a blank entry', () => {
    const ctx = readListContext([row({ file_id: '' }), ...rows], 'a', 'pool')
    expect(ctx.list.map((e) => e.file_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(ctx.index).toBe(0)
  })
})

describe('nextSourceLookahead — the T-20 s band', () => {
  it('is false outside the band and true inside it', () => {
    expect(nextSourceLookahead(199, 240)).toBe(false)
    expect(nextSourceLookahead(220 - LOOKAHEAD_S - 0.5, 240)).toBe(false)
    expect(nextSourceLookahead(240 - LOOKAHEAD_S, 240)).toBe(true)
    expect(nextSourceLookahead(239, 240)).toBe(true)
  })

  it('is false at or past the end — `ended` owns that moment, not the lookahead', () => {
    expect(nextSourceLookahead(240, 240)).toBe(false)
    expect(nextSourceLookahead(241, 240)).toBe(false)
  })

  // `audio.duration` is NaN until loadedmetadata and Infinity for a live
  // stream. Neither may fire a prefetch.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -10],
  ])('is false for a %s duration', (_name, duration) => {
    expect(nextSourceLookahead(1, duration)).toBe(false)
  })

  it('is true from the first second of a track shorter than the band', () => {
    expect(nextSourceLookahead(0, 10)).toBe(true)
  })
})

describe('renderQueueSections — the layer seam is visible', () => {
  const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
    file_id: id,
    display_artist: 'Artist',
    display_title: `Title ${id}`,
    duration_ms: 240000,
    bpm: 128,
    key_camelot: '8A',
    origin: 'list',
    source_label: 'pool',
    ...over,
  })

  const state = (over: Partial<QueueState> = {}): QueueState => ({ ...emptyState(), ...over })

  it('renders three sections, always, in play order', () => {
    const s = state({ current: entry('a', { origin: 'current' }), intent: [entry('b')] })
    const queue = [entry('a', { origin: 'current' }), entry('b'), entry('c', { origin: 'auto' })]
    const out = renderQueueSections(queue, s, {})
    expect(out.map((sec) => sec.id)).toEqual(['now', 'yours', 'auto'])
  })

  // A user must be able to see at a glance which part survives a strategy
  // switch. Three real fields, not three CSS classes over one array.
  it('puts each entry in the section its origin says, with its queue index', () => {
    const s = state({ current: entry('a', { origin: 'current' }), intent: [entry('b'), entry('c')] })
    const queue = [
      entry('a', { origin: 'current' }), entry('b'), entry('c'),
      entry('d', { origin: 'auto' }), entry('e', { origin: 'auto' }),
    ]
    const [now, yours, auto] = renderQueueSections(queue, s, {})
    expect(now.rows.map((r) => r.entry.file_id)).toEqual(['a'])
    expect(yours.rows.map((r) => r.entry.file_id)).toEqual(['b', 'c'])
    expect(auto.rows.map((r) => r.entry.file_id)).toEqual(['d', 'e'])
    // The index is the drawer's whole contract with the reducer: row 3 must
    // mean queue[3], or a click plays the wrong track.
    expect([...now.rows, ...yours.rows, ...auto.rows].map((r) => r.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('titles the auto section with the live method label', () => {
    const s = state({ current: entry('a', { origin: 'current' }), method: 'harmonic' })
    const out = renderQueueSections([entry('a', { origin: 'current' })], s, {})
    expect(out[2].title).toBe('UP NEXT · AUTO — MIX')
  })

  it('says autoplay is off under an empty auto section, rather than nothing', () => {
    const s = state({ current: entry('a', { origin: 'current' }) })
    const out = renderQueueSections([entry('a', { origin: 'current' })], s, {})
    expect(out[2].title).toBe('UP NEXT · AUTO — OFF')
    expect(out[2].note).toBe('Autoplay is off. Playback stops when the queue runs out.')
    expect(out[2].rows).toEqual([])
  })

  it('carries the truncation line on the section it belongs to', () => {
    const s = state({ current: entry('a', { origin: 'current' }), intent: [entry('b')] })
    const out = renderQueueSections([entry('a', { origin: 'current' }), entry('b')], s, {
      truncation: { label: 'warehouse', added: 24, offered: 60 },
    })
    expect(out[1].note).toBe('warehouse · 24 of 60')
  })

  // regenerate() swallows a port failure and returns a tail-less queue with
  // no exception. If the drawer does not say so, an empty MIX section reads
  // as "the pool has nothing for you" rather than "the request failed".
  it('explains an empty auto section caused by an unreachable pool', () => {
    const s = state({ current: entry('a', { origin: 'current' }), method: 'harmonic' })
    const out = renderQueueSections([entry('a', { origin: 'current' })], s, {
      candidateError: 'Could not reach the pool — no auto tail.',
    })
    expect(out[2].note).toBe('Could not reach the pool — no auto tail.')
  })

  it('prefers the failure note to the harmonic dead-end note', () => {
    const s = state({ current: entry('a', { origin: 'current' }), method: 'harmonic' })
    const withError = renderQueueSections([entry('a', { origin: 'current' })], s, {
      candidateError: 'Could not reach the pool — no auto tail.',
    })
    const without = renderQueueSections([entry('a', { origin: 'current' })], s, {})
    expect(withError[2].note).not.toBe(without[2].note)
    expect(without[2].note).toContain('Nothing harmonically close')
  })

  it('renders an empty queue as three empty sections, not an error', () => {
    const out = renderQueueSections([], state(), {})
    expect(out.map((sec) => sec.rows.length)).toEqual([0, 0, 0])
    expect(out[0].note).toBe('Nothing playing.')
  })

  it('marks removable rows: an auto entry and a pin can go, the current track cannot', () => {
    const s = state({ current: entry('a', { origin: 'current' }), intent: [entry('b')] })
    const out = renderQueueSections(
      [entry('a', { origin: 'current' }), entry('b'), entry('c', { origin: 'auto' })], s, {},
    )
    expect(out[0].rows[0].removable).toBe(false)
    expect(out[1].rows[0].removable).toBe(true)
    expect(out[2].rows[0].removable).toBe(true)
  })

  it('carries each entry\'s own source label so layer 1 is legible', () => {
    const s = state({
      current: entry('a', { origin: 'current' }),
      intent: [entry('b', { source_label: 'warehouse' }), entry('c', { source_label: 'pool' })],
    })
    const out = renderQueueSections(
      [entry('a', { origin: 'current' }),
        entry('b', { source_label: 'warehouse' }), entry('c', { source_label: 'pool' })], s, {},
    )
    expect(out[1].rows.map((r) => r.entry.source_label)).toEqual(['warehouse', 'pool'])
  })
})

describe('entryTitle — one line per row', () => {
  it('joins artist and title the way the player bar does', () => {
    expect(entryTitle({
      file_id: 'a', display_artist: 'Artist', display_title: 'Title',
      duration_ms: null, bpm: null, key_camelot: null, origin: 'list', source_label: null,
    })).toBe('Artist — Title')
  })

  it('drops the dash when there is no artist', () => {
    expect(entryTitle({
      file_id: 'a', display_artist: null, display_title: 'Title',
      duration_ms: null, bpm: null, key_camelot: null, origin: 'list', source_label: null,
    })).toBe('Title')
  })
})

describe('truncationLine — the plan\'s string, not a corrected one', () => {
  it('reads exactly as §1.2 specifies', () => {
    expect(truncationLine({ label: 'warehouse', added: 24, offered: 60 }))
      .toBe('warehouse · 24 of 60')
  })

  // The queue really holds 25 of the 60 — 24 pinned plus `current`. The line
  // counts the INTENT layer, which is what `reduce` reports, and a "fix" to
  // 25 would put this string out of step with the reducer.
  it('counts the intent layer, not the whole queue', () => {
    expect(truncationLine({ label: 'warehouse', added: 24, offered: 60 })).toContain('24 of 60')
    expect(truncationLine({ label: 'warehouse', added: 24, offered: 60 })).not.toContain('25')
  })

  it('drops the source clause when there is no label', () => {
    expect(truncationLine({ label: null, added: 4, offered: 17 })).toBe('4 of 17')
  })
})

describe('appendReport — a truncated append is never silent', () => {
  it('reports a full append', () => {
    expect(appendReport({ added: 17, offered: 17, label: 'warehouse' }))
      .toBe('added 17 tracks from warehouse')
  })

  it('uses the singular for one track', () => {
    expect(appendReport({ added: 1, offered: 1, label: 'pool' }))
      .toBe('added 1 track from pool')
  })

  // THE STRING THE PLAN SPECIFIES, character for character. §1.2: "Silent
  // partial success is the one outcome this must not have."
  it('reports a partial append with both numbers and the cap', () => {
    expect(appendReport({ added: 4, offered: 17, label: 'warehouse' }))
      .toBe('added 4 of 17 from warehouse — queue is full (25)')
  })

  it('names the cap from QUEUE_MAX rather than a literal', () => {
    expect(appendReport({ added: 4, offered: 17, label: 'warehouse' }))
      .toContain(`(${QUEUE_MAX})`)
  })

  it('reports adding nothing at all', () => {
    expect(appendReport({ added: 0, offered: 17, label: 'warehouse' }))
      .toBe('queue is full (25) — nothing added from warehouse')
  })

  it('says so when there was nothing to add — an empty crate is not a full queue', () => {
    expect(appendReport({ added: 0, offered: 0, label: 'warehouse' }))
      .toBe('nothing to add from warehouse')
  })

  it('omits the source clause when there is no label', () => {
    expect(appendReport({ added: 3, offered: 3, label: null })).toBe('added 3 tracks')
    expect(appendReport({ added: 1, offered: 4, label: null }))
      .toBe('added 1 of 4 — queue is full (25)')
  })

  // A duplicate the reducer deduped is an "added 0 of 1" that has nothing to
  // do with the cap — saying "queue is full" there would be a lie.
  it('does not blame the cap when the queue has room', () => {
    expect(appendReport({ added: 0, offered: 1, label: 'pool', full: false }))
      .toBe('already in the queue')
    expect(appendReport({ added: 2, offered: 3, label: 'pool', full: false }))
      .toBe('added 2 of 3 from pool')
  })
})
