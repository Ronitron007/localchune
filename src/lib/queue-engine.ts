// src/lib/queue-engine.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * M6b — THE ONE QUEUE ENGINE. "there is a hook that processes like playing a
 * new track, skipping a track, adding a track in the queue, clicking a track
 * in the queue etc call the engine to regenerate this queue" — the owner.
 *
 * This is that hook, and it is the only one. Every surface — pool table,
 * crate page, track page, the drawer, the lock screen — routes through
 * `reduce` and then `regenerate`. No second code path builds a play order.
 *
 * THE QUEUE IS DERIVED, NOT MUTATED. Every event produces a NEW state and the
 * array is recomputed from it. There is no `queue.splice()` in this milestone.
 *
 * WHAT THIS MODULE OWNS (§3.2): the 25 cap and the slot arithmetic, layer 1
 * (never exposed to a strategy at all), exclusions, the confirm predicate,
 * regeneration on every event, the single candidate fetch, and the fallback
 * when a strategy returns short. A strategy owns ranking, within `need`, and
 * nothing else.
 *
 * WHY EVENTS CARRY `queue`. `SELECT_QUEUE_ENTRY {index}` refers to the array
 * the drawer RENDERED — which includes the auto tail, and the auto tail is
 * not in `QueueState`. Passing the rendered array with the click is what
 * makes "the user clicked row 4" mean row 4 of what they were looking at,
 * rather than row 4 of an array re-derived a moment later from a strategy
 * that may now rank differently. It also keeps `reduce` pure and synchronous,
 * which is the whole reason it is testable under `environment: 'node'`.
 *
 * Pure and DOM-free. `regenerate` is the only async surface and it takes the
 * candidate fetch by injection (`CandidatePort`), so no test here stubs
 * `fetch`.
 */

import {
  assembleQueue, excludedKeys, HISTORY_MAX, identityTokens, isTaken, QUEUE_MAX,
  recordingOf, slotsFor, truncateIntent,
  type AutoMethod, type QueueEntry, type QueueState,
} from './queue-model'
import {
  FALLBACK_METHOD, STRATEGIES, type StrategyContext, type TrackFeatures,
} from './queue-strategies'
import { moveItem } from './reorder'

/**
 * The events of §1.4, plus `RESTORE_CURRENT`. The four that advance or address
 * a row carry the rendered `queue` — see this file's header for why.
 *
 * RESTORE_CURRENT IS NOT IN §1.4 AND IS NOT A PLAY. It exists because UX.9
 * resume loads a remembered track into the <audio> element without anybody
 * pressing anything, and before this event there was no sentence in the
 * grammar for "the transport is holding this". The consequence shipped: the
 * drawer said "Nothing playing." over audible audio, `ended` reduced to
 * nothing so autoplay never advanced, and the lock screen's next button was
 * inert — three symptoms of the one missing fact.
 */
export type QueueEvent =
  | {
    type: 'PLAY_TRACK'
    file_id: string
    list: readonly QueueEntry[]
    index: number
    source_label: string | null
  }
  | {
    type: 'PLAY_CRATE'
    crate_id: string
    items: readonly QueueEntry[]
    start: number
    source_label: string | null
  }
  | { type: 'ADD_TO_QUEUE'; entries: readonly QueueEntry[] }
  | { type: 'SELECT_QUEUE_ENTRY'; index: number; queue: readonly QueueEntry[] }
  | { type: 'SKIP'; queue: readonly QueueEntry[] }
  | { type: 'TRACK_ENDED'; queue: readonly QueueEntry[] }
  | { type: 'REMOVE_QUEUE_ENTRY'; index: number; queue: readonly QueueEntry[] }
  /**
   * A DESTINATION, NOT A DIRECTION. Both indices address the RENDERED array,
   * like every other addressing event above. See the `reduce` case for why
   * `dir: 'up' | 'down'` was removed rather than kept alongside.
   */
  | {
    type: 'MOVE_QUEUE_ENTRY'
    index: number
    to: number
    queue: readonly QueueEntry[]
  }
  | { type: 'TRACK_FAILED'; file_id: string; queue: readonly QueueEntry[] }
  | { type: 'SET_METHOD'; method: AutoMethod }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'RESTORE_CURRENT'; entry: QueueEntry }

/** Why a track left `current`. `played` vs `skipped` is the ONLY difference
 *  between TRACK_ENDED and SKIP — the two produce identical states, and
 *  `QueueState` has no field that could hold the distinction. Task 6 reads
 *  this to reset the play meter on every advance (§2.2: a play is a play). */
export type AdvanceReason = 'played' | 'skipped' | 'selected' | 'failed'

export interface ReduceResult {
  state: QueueState
  /** ADD_TO_QUEUE and the two replacing events: how many entries ENTERED the
   *  intent layer. Read with `offered` it is the whole truth about a
   *  truncation, and rendering it is not optional — a partial append that
   *  reports nothing is the failure mode §1.2 exists to prevent. */
  added?: number
  /** How many the caller offered. `warehouse · 24 of 60` is `added of offered`. */
  offered?: number
  /** Set when `current` changed to a different track (or to nothing). */
  advance?: { file_id: string; reason: AdvanceReason }
}

/** One fetch per regeneration, hard rule. The engine passes the seed and the
 *  slot count; the implementation (queue-candidates.ts) owns the window. */
export type CandidatePort = (
  seed: TrackFeatures | null, need: number,
) => Promise<TrackFeatures[]>

// -------------------------------------------------------------- helpers

const copy = (s: QueueState): QueueState => ({
  current: s.current,
  intent: s.intent.slice(),
  method: s.method,
  history: s.history.slice(),
  failed: s.failed.slice(),
  suppressed: s.suppressed.slice(),
})

/** Most-recent-first, deduped, bounded. Takes IDENTITY TOKENS, not file ids —
 *  see queue-model.ts's `identityTokens`. A consumed entry contributes two of
 *  them when it knows its recording, so `history` remembers the SONG and not
 *  just the encode. */
const pushFront = (list: readonly string[], ids: readonly string[], max: number): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...ids, ...list]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

const asCurrent = (e: QueueEntry): QueueEntry => ({ ...e, origin: 'current' })

const stamp = (
  entries: readonly QueueEntry[], origin: QueueEntry['origin'], label: string | null,
): QueueEntry[] => entries.map((e) => ({ ...e, origin, source_label: label }))

/**
 * The shared replace path for PLAY_TRACK and PLAY_CRATE. One rule: play
 * REPLACES layer 1, `+ queue` appends. The truncation happens here, on the
 * write, and its count is returned — nothing is stored beyond the cap and
 * nothing is dropped silently.
 */
function replaceWith(
  prev: QueueState,
  list: readonly QueueEntry[],
  at: number,
  origin: QueueEntry['origin'],
  label: string | null,
): ReduceResult {
  const chosen = list[at]
  const next = copy(prev)
  const outgoing = prev.current

  next.current = asCurrent({ ...chosen, source_label: label })
  next.history = outgoing === null
    ? next.history
    : pushFront(next.history, identityTokens(outgoing), HISTORY_MAX)

  const { slots } = slotsFor({ ...next, intent: [] })
  const tail = stamp(list.slice(at + 1), origin, label)
    .filter((e) => e.file_id !== chosen.file_id)
  const { kept } = truncateIntent(dedupe(tail), slots)
  next.intent = kept

  return {
    state: next,
    added: kept.length,
    offered: list.length,
    advance: outgoing === null || outgoing.file_id === chosen.file_id
      ? undefined
      : { file_id: outgoing.file_id, reason: 'selected' },
  }
}

/**
 * LAYER 1 DEDUPES BY FILE, NOT BY RECORDING, AND THAT IS DELIBERATE.
 *
 * The auto tail collapses encodes because nobody asked for three copies of one
 * song — it is the strategy's arithmetic, and the member never chose it. Layer
 * 1 is the opposite: "the user's explicit choices, in their order", and a
 * member who queues a specific encode off /track/[id]'s formats list has made
 * a choice this function has no business overruling. Silently dropping their
 * FLAC because the 320 is already pinned would be a worse bug than the one
 * QUEUE.dedupe fixes, and it would be invisible.
 *
 * The tail still refuses to ADD a recording layer 1 already holds — that is
 * `excludedKeys`, and it is the half that matters.
 */
const dedupe = (entries: readonly QueueEntry[]): QueueEntry[] => {
  const seen = new Set<string>()
  const out: QueueEntry[] = []
  for (const e of entries) {
    if (seen.has(e.file_id)) continue
    seen.add(e.file_id)
    out.push(e)
  }
  return out
}

/**
 * The shared advance path: everything up to `index` is consumed into history,
 * `queue[index]` becomes current, and the intent entries after it survive in
 * order.
 *
 * CLICK-AHEAD DROPS WHAT YOU JUMPED OVER. Entries 1..index-1 go to history and
 * do not come back — which is what every player anyone has used does, and
 * holding them would make "click the fourth track" mean "play the fourth track
 * and then the two you just skipped".
 *
 * `index >= queue.length` means the queue is exhausted: `current` becomes null
 * and PLAYBACK STOPS. That is the ordinary case with the default method, not
 * an edge — which is why SKIP takes this path and SELECT_QUEUE_ENTRY range-
 * checks first (a click on a stale row must never silently stop the music).
 */
function advanceTo(
  prev: QueueState, queue: readonly QueueEntry[], index: number, reason: AdvanceReason,
): ReduceResult {
  const next = copy(prev)
  const consumed = queue.slice(0, Math.min(index, queue.length))
  const incoming = index < queue.length ? queue[index] : null

  // Ordered so the OUTGOING current lands at history[0] — the most recently
  // played thing, which is where a future PREV will look for it.
  // `flatMap`, because a consumed entry that knows its recording remembers
  // BOTH: the file it was, and the song it is.
  next.history = pushFront(next.history, consumed.flatMap(identityTokens), HISTORY_MAX)
  next.current = incoming === null ? null : asCurrent(incoming)

  const pinned = new Set(prev.intent.map((e) => e.file_id))
  next.intent = queue.slice(index + 1).filter((e) => pinned.has(e.file_id))

  const outgoing = prev.current
  return {
    state: next,
    advance: outgoing === null ? undefined : { file_id: outgoing.file_id, reason },
  }
}

// -------------------------------------------------------------- §1.5

/**
 * The lowest index in the rendered array that an addressing event may touch.
 *
 * `queue[0]` is `current` ONLY WHEN SOMETHING IS PLAYING. With `current` null
 * — a member who used `+ queue` before pressing play, which is an ordinary
 * thing to do — `queue[0]` is the first PIN, and it must be selectable,
 * removable and movable like any other. Guarding on a bare `index <= 0` made
 * the drawer render ✕ / ↑ / ↓ on that row and then ignore every click, which
 * is exactly how the bug was found.
 */
const firstAddressable = (state: QueueState): number => (state.current === null ? 0 : 1)

/**
 * Where LAYER 1 begins in the rendered array — the offset that turns a row the
 * drawer reported into an index into `intent`.
 *
 * It is the same number as `firstAddressable`, and deliberately the same
 * expression rather than a second one that has to agree. The coincidence is
 * structural, not luck: `current` is rendered at index 0 when it exists, it is
 * the only row in neither layer, and it is the only row no addressing event
 * may touch. "The first row anyone may address" and "the first row of layer 1"
 * are therefore the same row, always. Two names because the two readings are
 * both worth having at their call sites; one binding because a future change
 * to the rendered head must move both at once or neither.
 */
const intentBase = firstAddressable

/**
 * May this event address `queue[index]` at all?
 *
 * THE INTEGER CHECK IS NOT DECORATION, and it was missing. Every addressing
 * event reaches its target through `event.queue[event.index]`, and a bare
 * range comparison lets two non-integers straight through: `NaN` fails BOTH
 * `< firstAddressable` and `>= length` (every comparison with NaN is false),
 * and a fractional index passes both honestly. Either one indexes the array
 * with a key that is not there, and `undefined` then reaches code that reads
 * `.file_id` off it — a TypeError from inside the one reducer, or, on the
 * SELECT path, a `current` spread from `undefined` into an entry with no id
 * at all. That second one is the bad shape: no exception, and the transport
 * holding a track that does not exist.
 *
 * `Number(el.dataset.index)` is `NaN` for a row whose attribute went missing,
 * which is one typo in a template away, and a drag reports indices derived
 * from the DOM rather than from a literal. site.ts guards every dispatch site
 * with `Number.isInteger`, and it should — but `reduce` documents itself as
 * total, and total has to be true here rather than upstream of here.
 */
const addressable = (
  state: QueueState, queue: readonly QueueEntry[], index: number,
): boolean => Number.isInteger(index)
  && index >= firstAddressable(state)
  && index < queue.length

const isReplacing = (e: QueueEvent): e is Extract<QueueEvent, { type: 'PLAY_TRACK' | 'PLAY_CRATE' }> =>
  e.type === 'PLAY_TRACK' || e.type === 'PLAY_CRATE'

/**
 * "User gets a modal…asking clear queue…and cancel." The PREDICATE lives here
 * rather than in site.ts, which is what keeps it testable and keeps the DOM
 * half a one-line call. It is true only for the two replacing events, and only
 * when there is actually something to lose.
 *
 * Never true for SELECT_QUEUE_ENTRY: clicking something already queued is not
 * a replace.
 */
export function requiresClearConfirm(state: QueueState, event: QueueEvent): boolean {
  return isReplacing(event) && state.intent.length > 0
}

/** Names what is lost, because "Are you sure?" is not a question anyone can
 *  answer. Empty for an event that never prompts. */
export function confirmMessage(state: QueueState, event: QueueEvent): string {
  // Same predicate as requiresClearConfirm, spelled out rather than called:
  // a boolean-returning function does not narrow `event`, and only the two
  // replacing events carry `source_label`.
  if (!isReplacing(event) || state.intent.length === 0) return ''
  const n = state.intent.length
  const noun = n === 1 ? 'track' : 'tracks'
  const label = event.source_label ?? 'this'
  return `Playing "${label}" clears your queue of ${n} ${noun}. Continue?`
}

// -------------------------------------------------------------- reduce

/** THE ONE REDUCER. Pure, synchronous, total: an out-of-range index or an
 *  unknown track is a no-op that still returns a new state object. */
export function reduce(state: QueueState, event: QueueEvent): ReduceResult {
  switch (event.type) {
    case 'PLAY_TRACK': {
      const at = event.list[event.index]?.file_id === event.file_id
        ? event.index
        : event.list.findIndex((e) => e.file_id === event.file_id)
      if (at < 0) return { state: copy(state) }
      return replaceWith(state, event.list, at, 'list', event.source_label)
    }

    case 'PLAY_CRATE': {
      const at = Math.max(0, Math.min(event.start, event.items.length - 1))
      if (event.items.length === 0) return { state: copy(state) }
      return replaceWith(state, event.items, at, 'crate', event.source_label)
    }

    case 'ADD_TO_QUEUE': {
      const next = copy(state)
      const { slots } = slotsFor(next)
      const taken = new Set(next.intent.map((e) => e.file_id))
      if (next.current !== null) taken.add(next.current.file_id)

      const fresh: QueueEntry[] = []
      for (const e of event.entries) {
        if (taken.has(e.file_id)) continue
        taken.add(e.file_id)
        fresh.push(e)
      }
      const { kept } = truncateIntent(fresh, slots - next.intent.length)
      next.intent = [...next.intent, ...kept]
      return { state: next, added: kept.length, offered: event.entries.length }
    }

    case 'SELECT_QUEUE_ENTRY': {
      if (!addressable(state, event.queue, event.index)) return { state: copy(state) }
      return advanceTo(state, event.queue, event.index, 'selected')
    }

    case 'SKIP':
      if (state.current === null) return { state: copy(state) }
      return advanceTo(state, event.queue, 1, 'skipped')

    case 'TRACK_ENDED':
      if (state.current === null) return { state: copy(state) }
      return advanceTo(state, event.queue, 1, 'played')

    case 'REMOVE_QUEUE_ENTRY': {
      const next = copy(state)
      if (!addressable(state, event.queue, event.index)) return { state: next }
      const target = event.queue[event.index]
      if (next.intent.some((e) => e.file_id === target.file_id)) {
        next.intent = next.intent.filter((e) => e.file_id !== target.file_id)
      } else {
        // An AUTO entry. Without the suppression the regeneration that
        // immediately follows re-picks it and the button looks broken — and
        // before QUEUE.dedupe it re-picked it as a DIFFERENT ENCODE of the
        // same recording, which looked identical in the drawer and was the
        // same broken button. Suppressing the recording is what closes that.
        next.suppressed = pushFront(next.suppressed, identityTokens(target), HISTORY_MAX)
      }
      return { state: next }
    }

    /**
     * THE REORDER. LAYER 1 ONLY, and the restriction is not a limitation but
     * the model: layer 2 has no identity across regenerations — an auto entry
     * that "moved" would be re-ranked into a different place by the very next
     * strategy run, so the gesture would appear to work at random. `intent` is
     * the one part of the queue with an order the user owns, and it is the
     * only part that can be reordered. The drawer therefore renders a drag
     * handle on layer 1 rows and on no others.
     *
     * IT TAKES A DESTINATION. This event used to be one step in a named
     * direction, because the only control was a pair of arrow buttons. A drag
     * from row 3 to row 9 through that verb is six dispatches, six reduces and
     * six regenerations, and the five intermediate orders are ones the member
     * never asked for. `dir` was deleted rather than kept as a derived
     * convenience: two shapes for one verb is how a boundary case comes to
     * mean two different things, and in this module that is a wrong song with
     * no exception and no failing test. The remaining one-step callers — the
     * arrow keys on the drag handle — compute `to` and land on exactly the
     * permutation `dir` produced, which queue-engine.test.ts asserts directly.
     *
     * BOTH INDICES ARE RENDERED INDICES, and converting them is all this case
     * does that `moveItem` does not. Layer 1 begins at rendered index
     * `intentBase` — 0 with nothing playing, 1 with `current` above it — so
     * subtracting it is the whole mapping, and CLAMPING (which `moveItem`
     * does) is what folds a destination outside layer 1 back onto its
     * boundary. That is not defensive coding, it is the feature: a member who
     * drags a pin down past the seam into the auto tail means "put it last",
     * and one who drags it above the playing track means "play it next".
     *
     * The order changes INSIDE `intent` rather than inside the rendered array,
     * because the rendered array is derived and the intent layer is what
     * persists. Every rejection — a source outside layer 1, an auto row, a
     * destination equal to the source — is a no-op that still returns a new
     * state, same total-function discipline as every case here.
     */
    case 'MOVE_QUEUE_ENTRY': {
      const next = copy(state)
      if (!addressable(state, event.queue, event.index)) return { state: next }
      const target = event.queue[event.index]
      const at = next.intent.findIndex((e) => e.file_id === target.file_id)
      if (at < 0) return { state: next }
      next.intent = moveItem(next.intent, at, event.to - intentBase(state))
      return { state: next }
    }

    /**
     * A DEAD FILE IS NOT A DEAD SONG. `failed` takes the bare file id and
     * NOTHING ELSE — `identityTokens` is deliberately not called here, and the
     * asymmetry with REMOVE_QUEUE_ENTRY above is the point. A 404 on one
     * encode says nothing about the other three, so striking the recording
     * would let one dead R2 object mark a song unplayable for good. (The
     * event carries only a file id anyway: site.ts fires it off the <audio>
     * element's `currentFileId`, which is all the transport knows.)
     *
     * The recording still lands in `history` a line later, because
     * `advanceTo` consumes the outgoing `current` exactly as it does for a
     * played track. That is the right bound: not re-queued THIS session,
     * because the member has already been through it, but not struck.
     */
    case 'TRACK_FAILED': {
      const marked = copy(state)
      marked.failed = pushFront(marked.failed, [event.file_id], HISTORY_MAX)
      if (marked.current === null) return { state: marked }
      return advanceTo(marked, event.queue, 1, 'failed')
    }

    case 'SET_METHOD': {
      // ONE FIELD. Strategies cannot reach layer 1, so the pins survive a
      // switch structurally rather than by anyone remembering to preserve them.
      const next = copy(state)
      next.method = event.method
      return { state: next }
    }

    case 'CLEAR_QUEUE': {
      const next = copy(state)
      next.intent = []
      return { state: next }
    }

    /**
     * UX.9's missing sentence: the transport is holding THIS.
     *
     * Everything it does NOT do is the specification. It does not push history
     * (nothing was consumed — a resume is not a play), it does not report an
     * `advance` (nothing LEFT current; something arrived at it), it does not
     * reorder or drop a pin, and it does not touch `method`. site.ts starts no
     * playback on it either: §5 resumes PAUSED, and a page load is not the
     * member asking to hear audio.
     *
     * THE TRANSPORT IS THE TRUTH, and the two guards below say exactly that.
     *
     * SAME TRACK → KEEP WHAT IS THERE. Queue memory carries full metadata
     * (bpm, key, artist); a resumed entry is built from player memory and has
     * only an id and a label. When both name the same file the richer one
     * wins, which is why the ordinary resume loses nothing.
     *
     * DIFFERENT TRACK → THE RESTORE WINS. The two memories are written on
     * different clocks — player memory on every timeupdate, queue memory only
     * on engine events — so they can name different tracks: two tabs racing
     * the same keys, or a `startCurrent` that bailed on a dead URL after the
     * engine had already moved. site.ts dispatches this only AFTER it has
     * actually pointed <audio> at the restored file and re-checked that no
     * click beat it there, so at that instant the transport really is holding
     * this track and a `current` naming another one is simply stale. Keeping
     * the stale one is how the drawer ends up describing a track that is not
     * playing — the exact bug this event exists to end.
     *
     * The entry LEAVES layer 1 if it was pinned there, exactly as
     * queue-model.ts's header describes a clicked entry doing: `current`
     * belongs to neither layer, so there is nothing to promote and no
     * duplicate to render.
     */
    case 'RESTORE_CURRENT': {
      const next = copy(state)
      if (next.current !== null && next.current.file_id === event.entry.file_id) {
        return { state: next }
      }
      next.current = asCurrent(event.entry)
      next.intent = next.intent.filter((e) => e.file_id !== event.entry.file_id)
      // Truncation on the write, as everywhere else: `current` takes one of the
      // 25, so a layer 1 already at the cap gives up its last entry rather than
      // becoming a 26th nobody renders and nobody persists.
      const { slots } = slotsFor(next)
      next.intent = truncateIntent(next.intent, slots).kept
      return { state: next }
    }
  }
}

// -------------------------------------------------------------- regenerate

/**
 * §3.3 — THE SEED IS THE LAST FORWARD ENTRY, NOT `current`. If three tracks
 * are pinned, the auto tail must be compatible with the THIRD pin, because
 * that is what will actually be playing when the tail starts. Seeding from
 * `current` produces a tail that mixes beautifully out of a track three
 * positions in the past and clashes with the one immediately before it.
 *
 * `like_count`/`play_count`/`created_at` are placeholders on a seed: they
 * exist in `TrackFeatures` for the tie-break between CANDIDATES and are never
 * read off the seed.
 */
export function seedFor(state: QueueState): TrackFeatures | null {
  const e = state.intent.length > 0 ? state.intent[state.intent.length - 1] : state.current
  if (!e) return null
  return {
    file_id: e.file_id,
    track_id: recordingOf(e),
    display_artist: e.display_artist,
    display_title: e.display_title,
    duration_ms: e.duration_ms,
    bpm: e.bpm,
    key_camelot: e.key_camelot,
    quality_tier: null,
    like_count: 0,
    play_count: 0,
    created_at: '',
  }
}

/** THE RECORDING TRAVELS WITH THE ENTRY. Without this line the tail's own
 *  entries know only their file, so the NEXT regeneration cannot tell that the
 *  320 it is about to add is the FLAC it added a moment ago. */
const toAutoEntry = (t: TrackFeatures, label: string): QueueEntry => ({
  file_id: t.file_id,
  track_id: t.track_id,
  display_artist: t.display_artist,
  display_title: t.display_title,
  duration_ms: t.duration_ms,
  bpm: t.bpm,
  key_camelot: t.key_camelot,
  origin: 'auto',
  source_label: label,
})

// ------------------------------------------------- the preferred copy

/**
 * WHICH ENCODE OF A RECORDING THE QUEUE PLAYS. Lower is better; a total order,
 * so the answer never flaps between two fetches that returned the same rows in
 * a different sequence.
 *
 *   1. QUALITY TIER, highest first. 1..5 from the analysis worker, and its own
 *      keep-if-better test is `b.tier > a.tier` — the same direction
 *      `pool_list(p_tier_min)` filters in. A never-analysed file (null) sorts
 *      LAST: it may well be the FLAC, but nothing has measured it, and
 *      guessing is how a 96 kbps rip wins.
 *   2. NEWEST `created_at`. This is `track_face_file()`'s own fallback arm,
 *      verbatim — "the track's newest stored file" — so when the tier cannot
 *      separate two encodes the queue picks the file the pool's face rule
 *      would have picked.
 *   3. `file_id` ASCENDING. Never reached in practice; there so that two rows
 *      identical in every measured way still have ONE answer, and the drawer
 *      shows the same encode after a reload.
 *
 * WHY NOT `track_face_file()` ITSELF. It reads `tracks.preferred_file_id`,
 * which `pool_list` does not return, so asking for it means a migration and a
 * wider projection on every regeneration. `preferred_file_id` is what
 * `dedup_resolve()` elects by keep-if-better — i.e. by tier — so term 1 is
 * that election recomputed from the row we already have, and term 2 is the
 * fallback arm copied exactly. The queue and the pool therefore agree without
 * a new column, and the one case they can disagree in is a track whose
 * preferred file an operator overrode by hand.
 */
export function preferredCopy(a: TrackFeatures, b: TrackFeatures): number {
  const ta = typeof a.quality_tier === 'number' ? a.quality_tier : -1
  const tb = typeof b.quality_tier === 'number' ? b.quality_tier : -1
  if (ta !== tb) return tb - ta

  const ca = Date.parse(a.created_at)
  const cb = Date.parse(b.created_at)
  const na = Number.isNaN(ca) ? 0 : ca
  const nb = Number.isNaN(cb) ? 0 : cb
  if (na !== nb) return nb - na

  return a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0
}

/**
 * ONE ROW PER RECORDING — the fix for "I just have same song 2-4 times".
 *
 * `/api/queue/candidates` STAYS PER-FILE ON PURPOSE (POOL.1 protected that
 * with its own `candidateArgs` and a set of absence-assertions): the engine
 * has to be able to CHOOSE which encode to play, and a feed that had already
 * collapsed would have made that choice for it, server-side, with less
 * information. So the collapse happens HERE, after the exclusion filter and
 * before any strategy sees a row.
 *
 * DOING IT HERE RATHER THAN IN `assembleQueue` ALONE IS WHAT MAKES THE TAIL
 * FILL. Rejecting the duplicate at assembly time would leave the greedy walk
 * spending picks on rows that are about to be thrown away — 24 slots asked
 * for, three distinct songs delivered. Collapsing first means every pick the
 * strategy makes is a song, so the tail fills to the cap whenever the pool has
 * the recordings to fill it.
 *
 * ORDER IS PRESERVED: the winner takes the position of the FIRST row of its
 * recording, so `p_sort: 'added_desc'` still describes the candidate list.
 * A null recording is its own group of one and is never merged with anything.
 */
export function collapseByRecording(
  candidates: readonly TrackFeatures[],
): TrackFeatures[] {
  const at = new Map<string, number>()
  const out: TrackFeatures[] = []
  for (const c of candidates) {
    const rec = recordingOf(c)
    if (rec === null) {
      out.push(c)
      continue
    }
    const seen = at.get(rec)
    if (seen === undefined) {
      at.set(rec, out.length)
      out.push(c)
    } else if (preferredCopy(c, out[seen]) < 0) {
      out[seen] = c
    }
  }
  return out
}

/**
 * Recompute the whole array. The ONLY async surface, and the only place a
 * candidate fetch happens — one per regeneration, hard rule.
 *
 * `method: 'off'` and `need === 0` SHORT-CIRCUIT BEFORE THE PORT. That is the
 * default path: a member who never opens the drawer issues zero queue-related
 * requests, and a member whose own pins fill the cap issues none either.
 *
 * A port that throws yields the queue without a tail rather than an exception.
 * The auto layer is a nicety; what is playing is not, and a dead network must
 * never take the transport down with it.
 */
export async function regenerate(
  state: QueueState, port: CandidatePort,
): Promise<QueueEntry[]> {
  const { need } = slotsFor(state)
  if (state.method === 'off' || need === 0) return assembleQueue(state, [])

  const seed = seedFor(state)
  let fetched: TrackFeatures[]
  try {
    fetched = await port(seed, need)
  } catch {
    return assembleQueue(state, [])
  }

  // EXCLUDE, THEN COLLAPSE, IN THAT ORDER. The other order would let a copy
  // that is already playing win its recording's group and then be dropped,
  // taking the playable sibling with it — a song that vanishes from the tail
  // for as long as it is in the queue.
  const excluded = excludedKeys(state)
  const candidates = collapseByRecording(
    fetched.filter((c) => !isTaken(excluded, c)))
  const ctx: StrategyContext = { seed, candidates, history: state.history, need }

  const strategy = STRATEGIES[state.method]
  let picked = [...strategy.select(ctx)]

  // ONE fallback hop, and NO second port call: §1.3 case 3 says the engine
  // does not widen the window and does not retry. FALLBACK_METHOD declares
  // the hop so a future strategy adds its own instead of editing this branch.
  const fallback = FALLBACK_METHOD[state.method]
  if (picked.length < need && fallback !== undefined) {
    const already = new Set(picked)
    picked = [...picked, ...STRATEGIES[fallback].select({
      ...ctx,
      candidates: candidates.filter((c) => !already.has(c.file_id)),
      need: need - picked.length,
    })]
  }

  const byId = new Map(candidates.map((c) => [c.file_id, c]))
  const auto: QueueEntry[] = []
  for (const id of picked) {
    const t = byId.get(id)
    if (t !== undefined) auto.push(toAutoEntry(t, strategy.label))
  }
  return assembleQueue(state, auto)
}

/** Re-exported so a caller never has to import two modules to know the bounds. */
export { HISTORY_MAX, QUEUE_MAX }
