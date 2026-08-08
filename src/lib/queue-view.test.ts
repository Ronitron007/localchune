// src/lib/queue-view.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { QUEUE_MAX, emptyState, type QueueEntry, type QueueState } from './queue-model'
import {
  CRATE_TRACK_KEYS, LOOKAHEAD_S, appendReport, entryTitle, nextSourceLookahead,
  readListContext, renderQueueSections, resumedEntry, toCrateTrack, toQueueEntry,
  truncationFor, truncationLine, type QueueRowData,
} from './queue-view'

const row = (over: Partial<QueueRowData> & { file_id: string }): QueueRowData => ({
  artist: 'Artist',
  title: 'Title',
  duration_ms: '240000',
  bpm: '128',
  key_camelot: '8A',
  ...over,
})

describe('the recording rides in on data-recording-id', () => {
  it('carries a recording through onto the entry', () => {
    expect(toQueueEntry(row({ file_id: 'a', track_id: 'r1' }), 'list', null).track_id).toBe('r1')
  })

  for (const [why, value] of [
    ['absent (a surface not yet taught to emit one)', undefined],
    ['null', null],
    ['the empty string (an Astro template rendering a null)', ''],
    ['whitespace', '   '],
  ] as Array<[string, string | null | undefined]>) {
    it(`reads ${why} as NO recording, never as a shared one`, () => {
      expect(toQueueEntry(row({ file_id: 'a', track_id: value }), 'list', null).track_id)
        .toBeNull()
    })
  }

  it('DOES NOT READ THE FILE ID INTO IT — the two attributes are one letter apart', () => {
    // `data-track-id` is the FILE (the M6b selector); `data-recording-id` is
    // the recording. Crossing them makes the queue exclude by the wrong id,
    // which looks like nothing at all until the same song plays twice.
    const e = toQueueEntry(row({ file_id: 'the-file' }), 'list', null)
    expect(e.file_id).toBe('the-file')
    expect(e.track_id).toBeNull()
  })
})

describe('toQueueEntry — dataset strings onto the model', () => {
  it('parses the numeric fields out of their string form', () => {
    const e = toQueueEntry(row({ file_id: 'a' }), 'list', 'pool')
    expect(e).toEqual({
      file_id: 'a',
      track_id: null,
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
  it('emits exactly the seven queue fields and drops every other column', () => {
    const out = toCrateTrack({
      position: 3,
      file_id: 'f1',
      track_id: 'r1',
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
      file_id: 'f1', track_id: 'r1', artist: 'A', title: 'T', duration_ms: 1000,
      bpm: 128, key_camelot: '8A',
    })
  })

  // THE WIRE SHAPE IS ALREADY A QueueRowData. The route projects once,
  // server-side, and the browser feeds the result straight to toQueueEntry.
  it('feeds toQueueEntry directly, with no second projection in between', () => {
    const wire = toCrateTrack({
      file_id: 'f1', display_artist: 'A', display_title: 'T',
      duration_ms: 1000, bpm: 128, key_camelot: '8A',
    })
    const entry = toQueueEntry(wire, 'crate', 'warehouse')
    expect(entry.display_title).toBe('T')
    expect(entry.display_artist).toBe('A')
    expect(entry.bpm).toBe(128)
    expect(entry.source_label).toBe('warehouse')
  })

  // APPLYING IT TWICE LOSES EVERYTHING, and this test exists because the
  // client did exactly that: the route projected `display_title` -> `title`,
  // then site.ts ran the projection AGAIN over the wire rows, read
  // `display_title` off an object that no longer had one, and queued six
  // entries with blank names. Nothing threw. queue-wiring.test.ts keeps this
  // function out of site.ts entirely; this documents why.
  it('is deliberately NOT idempotent — a double projection is silent data loss', () => {
    const once = toCrateTrack({ file_id: 'f1', display_artist: 'A', display_title: 'T', bpm: 128 })
    const twice = toCrateTrack(once as unknown as Record<string, unknown>)
    expect(once.title).toBe('T')
    expect(once.artist).toBe('A')
    // Only the RENAMED fields die — display_title -> title, display_artist ->
    // artist. That is exactly what made the bug quiet: bpm, duration_ms and
    // key_camelot keep their names and survive, so the rows looked populated
    // in every way except the two the drawer actually renders.
    expect(twice.title).toBe('')
    expect(twice.artist).toBeNull()
    expect(twice.bpm).toBe(128)
    expect(twice.file_id).toBe('f1')
  })

  it('survives a row with nulls where the analysis never landed', () => {
    const out = toCrateTrack({
      file_id: 'f2', display_artist: null, display_title: 'T2',
      duration_ms: null, bpm: null, key_camelot: null,
    })
    expect(out).toEqual({
      file_id: 'f2', track_id: null, artist: null, title: 'T2', duration_ms: null,
      bpm: null, key_camelot: null,
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

  it('marks reorderable rows: ONLY a pin, which is the only layer with an order', () => {
    // The drawer renders a drag handle off this flag, so it is the answer to
    // "may MOVE_QUEUE_ENTRY act on this row?" and must agree with the engine
    // exactly. Layer 2 is rebuilt from scratch on every regeneration and has
    // no order anyone owns; `current` is in neither layer.
    const s = state({ current: entry('a', { origin: 'current' }), intent: [entry('b')] })
    const out = renderQueueSections(
      [entry('a', { origin: 'current' }), entry('b'), entry('c', { origin: 'auto' })], s, {},
    )
    expect(out[0].rows[0].reorderable).toBe(false) // NOW PLAYING
    expect(out[1].rows[0].reorderable).toBe(true) //  YOUR QUEUE
    expect(out[2].rows[0].reorderable).toBe(false) // UP NEXT · AUTO
  })

  it('is not the same question as removable — an auto row can go but cannot move', () => {
    // Rendering the handle off `removable` is how the drawer came to ship ↑/↓
    // on auto rows that the engine then refused: a control drawn, looking
    // enabled, and inert.
    const s = state({ current: null, intent: [entry('b')] })
    const out = renderQueueSections([entry('b'), entry('c', { origin: 'auto' })], s, {})
    const autoRow = out[2].rows[0]
    expect(autoRow.removable).toBe(true)
    expect(autoRow.reorderable).toBe(false)
  })

  it('marks the first pin reorderable when nothing is playing', () => {
    // Rendered index 0 is a PIN with no `current` above it, and it must be
    // draggable like any other — the same off-by-one that made ✕ / ↑ / ↓ inert
    // on that row once already.
    const s = state({ current: null, intent: [entry('b'), entry('c')] })
    const out = renderQueueSections([entry('b'), entry('c')], s, {})
    expect(out[1].rows.map((r) => r.index)).toEqual([0, 1])
    expect(out[1].rows.every((r) => r.reorderable)).toBe(true)
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

describe('resumedEntry — player memory onto the model', () => {
  it('carries the file id and the stored label', () => {
    const e = resumedEntry('f1', 'Paul Kalkbrenner — Press On')
    expect(e.file_id).toBe('f1')
    expect(e.display_title).toBe('Paul Kalkbrenner — Press On')
  })

  it('has NO recording — player memory never held one, and that degrades cleanly', () => {
    // The bound is exact: the tail will not re-queue this FILE, but it may
    // offer another encode of the same song once. The first real engine event
    // restores the recording from the DOM.
    expect(resumedEntry('f1', 'label').track_id).toBeNull()
  })

  it('renders in the drawer EXACTLY as the player bar wrote it', () => {
    // player-memory stores the joined label, so re-splitting it would mean
    // guessing at an em dash that can appear inside either half. A null artist
    // makes entryTitle a no-op over the stored string instead.
    const label = 'Paul Kalkbrenner — Press On'
    expect(entryTitle(resumedEntry('f1', label))).toBe(label)
  })

  it('is stamped `current` — it is what the transport holds', () => {
    expect(resumedEntry('f1', 'x').origin).toBe('current')
  })

  it('admits the metadata it does not have rather than inventing it', () => {
    // A resumed seed scores every candidate the same, so only the FIRST auto
    // pick is arbitrary; greedyWalk re-seeds from each pick after that. The
    // alternative was a metadata request on a returning member's first paint.
    const e = resumedEntry('f1', 'x')
    expect(e.bpm).toBeNull()
    expect(e.key_camelot).toBeNull()
    expect(e.duration_ms).toBeNull()
    expect(e.display_artist).toBeNull()
    expect(e.source_label).toBeNull()
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

describe('truncationFor — only the CAP earns a truncation line', () => {
  // The bug this exists to prevent, found by driving the real drawer:
  // clicking the third row of an eight-row table adds five of eight offered
  // and truncates NOTHING — the two rows above the clicked one were never
  // candidates. `added < offered` alone reported "pool · 5 of 8".
  it('is null for a mid-list play with room to spare', () => {
    expect(truncationFor({ added: 5, offered: 8 }, 'pool', false)).toBeNull()
  })

  it('reports a play that really did hit the cap', () => {
    expect(truncationFor({ added: 24, offered: 60 }, 'warehouse', true))
      .toEqual({ label: 'warehouse', added: 24, offered: 60 })
  })

  it('reports a partial append at the cap', () => {
    expect(truncationFor({ added: 4, offered: 17 }, 'warehouse', true))
      .toEqual({ label: 'warehouse', added: 4, offered: 17 })
  })

  // A queue that is exactly full but took everything offered has nothing to
  // report: the cap is reached, but it truncated nothing.
  it('is null when everything offered was taken, cap or no cap', () => {
    expect(truncationFor({ added: 24, offered: 24 }, 'warehouse', true)).toBeNull()
  })

  it('is null for an event that reports no counts at all', () => {
    expect(truncationFor({}, 'pool', true)).toBeNull()
    expect(truncationFor({ added: 3 }, 'pool', true)).toBeNull()
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
