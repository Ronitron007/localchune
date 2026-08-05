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
  assembleQueue, excludedIds, QUEUE_MAX, slotsFor, truncateIntent,
  type AutoMethod, type QueueEntry, type QueueState,
} from './queue-model'
import {
  FALLBACK_METHOD, STRATEGIES, type StrategyContext, type TrackFeatures,
} from './queue-strategies'

/**
 * `history` is consumed tracks, not queued ones — it is NOT a backlog and
 * nothing in it is playable, so the 25 cap has no opinion about it. It is
 * bounded anyway: it is persisted, it only grows, and an unbounded array in
 * localStorage is a slow leak. 200 is far past the point where recency-aware
 * ranking or a future PREV cares.
 */
export const HISTORY_MAX = 200

/**
 * The ten events of §1.4. The four that advance or address a row carry the
 * rendered `queue` — see this file's header for why.
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
  | { type: 'TRACK_FAILED'; file_id: string; queue: readonly QueueEntry[] }
  | { type: 'SET_METHOD'; method: AutoMethod }
  | { type: 'CLEAR_QUEUE' }

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

/** Most-recent-first, deduped, bounded. */
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
    : pushFront(next.history, [outgoing.file_id], HISTORY_MAX)

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
  next.history = pushFront(next.history, consumed.map((e) => e.file_id), HISTORY_MAX)
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
      if (event.index <= 0 || event.index >= event.queue.length) return { state: copy(state) }
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
      if (event.index <= 0 || event.index >= event.queue.length) return { state: next }
      const target = event.queue[event.index]
      if (next.intent.some((e) => e.file_id === target.file_id)) {
        next.intent = next.intent.filter((e) => e.file_id !== target.file_id)
      } else {
        // An AUTO entry. Without the suppression the regeneration that
        // immediately follows re-picks it and the button looks broken.
        next.suppressed = pushFront(next.suppressed, [target.file_id], HISTORY_MAX)
      }
      return { state: next }
    }

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
    display_artist: e.display_artist,
    display_title: e.display_title,
    duration_ms: e.duration_ms,
    bpm: e.bpm,
    key_camelot: e.key_camelot,
    like_count: 0,
    play_count: 0,
    created_at: '',
  }
}

const toAutoEntry = (t: TrackFeatures, label: string): QueueEntry => ({
  file_id: t.file_id,
  display_artist: t.display_artist,
  display_title: t.display_title,
  duration_ms: t.duration_ms,
  bpm: t.bpm,
  key_camelot: t.key_camelot,
  origin: 'auto',
  source_label: label,
})

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

  const excluded = excludedIds(state)
  const candidates = fetched.filter((c) => !excluded.has(c.file_id))
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

/** Re-exported so a caller never has to import two modules to know the cap. */
export { QUEUE_MAX }
