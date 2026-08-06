// src/lib/queue-model.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * M6b — THE QUEUE MODEL. Types, the cap, and the layer algebra, and nothing
 * else. This module does not know that strategies exist, does not fetch, and
 * does not touch the DOM: it is the arithmetic the engine (queue-engine.ts),
 * the store (queue-store.ts) and the drawer all have to agree on.
 *
 * THREE PARTS, TWO LAYERS. `current` belongs to neither layer. That one
 * decision dissolves the "does clicking an auto entry promote it to the user
 * layer?" question — a clicked entry LEAVES its layer and becomes `current`,
 * so there is nothing to promote and no special case to write. It also makes
 * the drawer's three sections (NOW PLAYING / YOUR QUEUE / UP NEXT · AUTO)
 * three real fields rather than three CSS classes over one array.
 *
 *   LAYER 1 `intent`  the user's explicit choices, in their order. The engine
 *                     never reorders, re-ranks or drops one. Persisted.
 *   LAYER 2 the auto tail — recomputed from scratch on every regeneration by
 *                     the selected `method`, never stored, never persisted. It
 *                     has no identity across regenerations: an entry that
 *                     survives two events survives because the strategy picked
 *                     it twice, not because anything held onto it.
 *
 * 25 IS THE WHOLE TRUTH. There is exactly one number and nothing is stored
 * beyond it. An earlier draft kept a 500-entry stored intent layer and
 * rendered its first 24 — a hidden 476-entry backlog IS more than 25, whatever
 * the drawer chooses to show. So `INTENT_MAX` does not exist, truncation
 * happens at the moment of the write (`truncateIntent`, called from `reduce`),
 * and the count it drops is RETURNED so the caller can tell the user. A silent
 * partial append is the one outcome this model must not have.
 */

/** The owner's number. The whole array, `current` included. The only cap. */
export const QUEUE_MAX = 25

/**
 * `history` is CONSUMED tracks, not queued ones. Nothing in it is playable, so
 * the 25 cap has no opinion about it and this is not the hidden backlog §1.2
 * bans. It is bounded anyway: it is persisted, it only grows, and an unbounded
 * array in localStorage is a slow leak. 200 is far past the point where
 * recency-aware ranking or a future PREV would care.
 *
 * It lives HERE rather than in queue-engine.ts because queue-store.ts also
 * bounds history on the way in, and the store must not import the engine —
 * that would pull the strategies and the candidate client into every page's
 * graph through Shell.astro. Two constants that have to agree is worse.
 */
export const HISTORY_MAX = 200

/** The v1 methods. A future genre/artist strategy adds an id here and a file
 *  in queue-strategies.ts — §3.6's whole extensibility claim. */
export const AUTO_METHODS = ['off', 'harmonic', 'bpm', 'shuffle'] as const
export type AutoMethod = (typeof AUTO_METHODS)[number]

/** Autoplay is OPT-IN. A drained queue stops playing until a member taps a
 *  method in the drawer, and `off` short-circuits before the candidate port —
 *  so a member who never opens the drawer issues zero queue-related
 *  requests. */
export const DEFAULT_METHOD: AutoMethod = 'off'

/**
 * What each method is CALLED, in the drawer's method selector and in the
 * `UP NEXT · AUTO — MIX` section title.
 *
 * It lives here, not in queue-strategies.ts, for the reason HISTORY_MAX lives
 * here: the drawer renders the label on every page and must not import the
 * strategy registry to learn it — that would pull the Camelot scorer into the
 * render path. queue-strategies.ts reads these for its own `Strategy.label`,
 * so there is one string per method and not two that have to agree.
 */
export const METHOD_LABELS: Record<AutoMethod, string> = {
  off: 'OFF',
  harmonic: 'MIX',
  bpm: 'TEMPO',
  shuffle: 'SHUFFLE',
}

/**
 * Where an entry came from. `source_label` (the crate name, "pool", or a
 * filter description) is the only way a reader can tell layer 1 from layer 2
 * without reading this file, so it is part of the entry, not of the render.
 */
export type QueueOrigin = 'current' | 'list' | 'crate' | 'add' | 'auto'

export interface QueueEntry {
  file_id: string
  display_artist: string | null
  display_title: string
  duration_ms: number | null
  bpm: number | null
  key_camelot: string | null
  origin: QueueOrigin
  source_label: string | null
}

export interface QueueState {
  /** What is loaded in <audio> right now. In neither layer. */
  current: QueueEntry | null
  /** LAYER 1 — explicit choices, in the user's order. */
  intent: QueueEntry[]
  /** Which strategy fills LAYER 2. */
  method: AutoMethod
  /** file_ids consumed this session, most-recent-first. */
  history: string[]
  /** file_ids whose source fetch or decode failed. */
  failed: string[]
  /** Auto entries the user removed by hand this session. Without this the
   *  regeneration that immediately follows a remove re-picks the track and
   *  the button looks broken. Session-scoped, never persisted. */
  suppressed: string[]
}

/** Narrows a hand-edited or future-schema value. queue-store.ts needs this
 *  and must not import the strategy registry to get it — the drawer reads the
 *  queue on every page and has no business pulling the strategies in. */
export function isAutoMethod(v: unknown): v is AutoMethod {
  return typeof v === 'string' && (AUTO_METHODS as readonly string[]).includes(v)
}

/** A fresh state. Fresh ARRAYS too — a shared empty array between two callers
 *  would be a cross-session write waiting to happen. */
export function emptyState(): QueueState {
  return {
    current: null,
    intent: [],
    method: DEFAULT_METHOD,
    history: [],
    failed: [],
    suppressed: [],
  }
}

/**
 * Everything a strategy may not pick. The engine applies this BEFORE any
 * strategy sees the candidate set, which is why `Strategy.select` is
 * documented as "must not re-filter exclusions".
 */
export function excludedIds(s: QueueState): Set<string> {
  const out = new Set<string>()
  if (s.current !== null) out.add(s.current.file_id)
  for (const e of s.intent) out.add(e.file_id)
  for (const id of s.history) out.add(id)
  for (const id of s.failed) out.add(id)
  for (const id of s.suppressed) out.add(id)
  return out
}

/**
 * `slots` is how many entries may sit BEHIND `current` — 24 while something
 * plays, 25 when nothing does. `need` is how many the auto layer is allowed
 * to contribute, and it is never negative: an over-long intent layer (which
 * `reduce` makes unreachable, but a hand-edited localStorage payload does not)
 * reports 0 rather than a number that would make `slice` count backwards.
 */
export function slotsFor(s: QueueState): { slots: number; need: number } {
  const slots = QUEUE_MAX - (s.current === null ? 0 : 1)
  return { slots, need: Math.max(0, slots - s.intent.length) }
}

/**
 * THE ONLY WRITER OF LAYER 1. Keeps the first `slots` entries and reports how
 * many were dropped, because the drawer's `warehouse · 24 of 60` line and the
 * `added 4 of 17 … queue is full (25)` status both read that number. A
 * negative or zero `slots` keeps nothing and drops everything — the queue is
 * full and the caller has to say so.
 */
export function truncateIntent(
  entries: readonly QueueEntry[], slots: number,
): { kept: QueueEntry[]; dropped: number } {
  const room = Math.max(0, slots)
  const kept = entries.slice(0, room)
  return { kept, dropped: entries.length - kept.length }
}

/**
 * The derived array. `[current, ...intent, ...auto]`, capped.
 *
 * The auto layer is re-filtered and re-truncated HERE rather than trusted,
 * because a strategy that returns 400 ids or an id already in `history` is a
 * bug in the strategy that must not become a bug in the cap. §3.2: the engine
 * silently corrects it, and the correction is asserted in this module's tests
 * so a future strategy cannot break the cap even if it tries.
 *
 * Never mutates `s` or `auto`; the returned array is new.
 */
export function assembleQueue(s: QueueState, auto: readonly QueueEntry[]): QueueEntry[] {
  const { slots, need } = slotsFor(s)
  const head: QueueEntry[] = s.current === null ? [] : [s.current]
  const intent = s.intent.slice(0, slots)

  const taken = excludedIds(s)
  const tail: QueueEntry[] = []
  for (const e of auto) {
    if (tail.length >= need) break
    if (taken.has(e.file_id)) continue
    taken.add(e.file_id)
    tail.push(e)
  }

  return [...head, ...intent, ...tail].slice(0, QUEUE_MAX)
}
