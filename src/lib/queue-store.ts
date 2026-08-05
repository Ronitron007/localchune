// src/lib/queue-store.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * M6b — THE QUEUE'S STATE, AND ONLY ITS STATE, plus the localStorage codec.
 *
 * THE SPLIT IS THE POINT, and it is UX.12's lesson applied a second time.
 * upload-store.ts is separate from upload-engine.ts because Shell.astro mounts
 * the upload chip on EVERY page, and whatever the chip imports is shipped in
 * every page's client bundle. The queue drawer has exactly the same problem
 * and exactly the same fix: it lives in Shell.astro, it needs to READ the
 * queue, and it has no business being able to compute one.
 *
 * So this module imports queue-model.ts and NOTHING ELSE. Not the engine, not
 * the strategies, not the candidate client. Were it to import the engine,
 * every page in the app — /login included — would carry the harmonic scorer
 * and the Camelot wheel to render a drawer nobody opened. (HISTORY_MAX lives
 * in queue-model.ts for exactly this reason; two constants that have to agree
 * would be worse than one import.)
 *
 * NO `localStorage` ACCESS HERE. This is the pure half — vitest runs
 * `environment: 'node'`, the same reasoning player-memory.ts and
 * upload-journal.ts already record. site.ts owns get/setItem.
 *
 * WHAT IS PERSISTED, AND WHAT IS NOT. §5: resume restores `current`, `intent`,
 * `method` and `history` — layer 1 and its context. Not persisted:
 *   - the AUTO TAIL, which is not in the state at all because it is derived. A
 *     14-day-old harmonic tail is stale (the pool grew), and recomputing it at
 *     page load would put a pool_list call on every returning member's first
 *     paint for a drawer they may never open.
 *   - `suppressed`, which is session-scoped by §1.4's definition.
 *   - `failed`, for the same reason plus a better one: a track that failed to
 *     decode a fortnight ago deserves another chance.
 *
 * AND NEVER A URL. Presigned GETs live one hour; this payload lives fourteen
 * days, so a stored URL is a dead link by construction. player-memory.ts states
 * that rule in prose; here `serializeState` ENFORCES it by projecting the known
 * fields and dropping everything else, and a test hands it a contaminated entry
 * to prove it.
 */

import {
  emptyState, HISTORY_MAX, isAutoMethod, slotsFor, truncateIntent,
  type AutoMethod, type QueueEntry, type QueueOrigin, type QueueState,
} from './queue-model'

export const QUEUE_MEMORY_KEY = 'localchune:queue:v1'

/** The same fortnight player-memory.ts uses, for the same reason: longer than
 *  this, "pick up where you left off" stops being useful and starts being
 *  surprising. */
export const QUEUE_MEMORY_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Bumped only for a shape change. A payload from any OTHER version parses to
 *  null rather than being coerced — a queue is a thirty-minute artefact and
 *  losing one costs nothing next to guessing at a shape. */
export const QUEUE_SCHEMA_VERSION = 1

export interface QueueMemoryEntry {
  v: typeof QUEUE_SCHEMA_VERSION
  current: QueueEntry | null
  intent: QueueEntry[]
  method: AutoMethod
  history: string[]
  /** ISO 8601. */
  updated_at: string
}

const ORIGINS: readonly QueueOrigin[] = ['current', 'list', 'crate', 'add', 'auto']

/** Projection, not a copy: an unknown property on the input is DROPPED, which
 *  is what keeps a signed URL out of localStorage even if a caller ever puts
 *  one on an entry. */
const projectEntry = (e: QueueEntry): QueueEntry => ({
  file_id: e.file_id,
  display_artist: e.display_artist,
  display_title: e.display_title,
  duration_ms: e.duration_ms,
  bpm: e.bpm,
  key_camelot: e.key_camelot,
  origin: e.origin,
  source_label: e.source_label,
})

export function serializeState(s: QueueState, now: number = Date.now()): string {
  const { slots } = slotsFor(s)
  const { kept } = truncateIntent(s.intent, slots)
  const payload: QueueMemoryEntry = {
    v: QUEUE_SCHEMA_VERSION,
    current: s.current === null ? null : projectEntry(s.current),
    intent: kept.map(projectEntry),
    method: s.method,
    history: s.history.slice(0, HISTORY_MAX),
    updated_at: new Date(now).toISOString(),
  }
  return JSON.stringify(payload)
}

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isNullableNumber = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v))

/**
 * STRICT on shape, FORGIVING on enums — and the difference is deliberate.
 *
 * A malformed entry is corruption: something wrote a shape this build cannot
 * read, and guessing at it is how a queue full of `undefined` reaches the
 * <audio> element. The whole payload goes.
 *
 * An unrecognised `method` or `origin` is a VERSION artefact — a member who
 * used a build with a genre strategy, or who will. Those repair to the safe
 * default, because losing a good queue over a label the UI could simply not
 * highlight would be the wrong trade.
 */
function parseEntry(v: unknown): QueueEntry | null {
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  if (typeof e.file_id !== 'string' || e.file_id.length === 0) return null
  if (typeof e.display_title !== 'string') return null
  if (!isNullableString(e.display_artist)) return null
  if (!isNullableNumber(e.duration_ms)) return null
  if (!isNullableNumber(e.bpm)) return null
  if (!isNullableString(e.key_camelot)) return null
  if (!isNullableString(e.source_label)) return null
  const origin = (ORIGINS as readonly string[]).includes(e.origin as string)
    ? (e.origin as QueueOrigin)
    : 'list'
  return {
    file_id: e.file_id,
    display_artist: e.display_artist,
    display_title: e.display_title,
    duration_ms: e.duration_ms,
    bpm: e.bpm,
    key_camelot: e.key_camelot,
    origin,
    source_label: e.source_label,
  }
}

/**
 * Parses and shape-checks a raw `localStorage.getItem` result. Returns null
 * for anything that is not a well-formed entry — corrupt JSON, a hand-edited
 * value, a schema version this build does not speak — and NEVER throws.
 *
 * Staleness is a SEPARATE check (`isStale`), same as player-memory.ts: a
 * parsed-but-stale entry is still a valid entry, just one the restore path
 * should not act on.
 *
 * THE CAP IS ENFORCED HERE TOO. A hand-edited payload holding 10 000 intent
 * entries parses to at most `slots`. localStorage is the one place a backlog
 * could sneak back past §1.2, so this is the boundary that refuses it.
 */
export function parseState(raw: string | null): QueueMemoryEntry | null {
  if (raw === null || raw === '') return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null

  const d = data as Record<string, unknown>
  if (d.v !== QUEUE_SCHEMA_VERSION) return null
  if (typeof d.updated_at !== 'string' || Number.isNaN(Date.parse(d.updated_at))) return null
  if (!Array.isArray(d.intent)) return null
  if (!Array.isArray(d.history) || d.history.some((h) => typeof h !== 'string')) return null

  let current: QueueEntry | null = null
  if (d.current !== null && d.current !== undefined) {
    current = parseEntry(d.current)
    if (current === null) return null
  }

  const intent: QueueEntry[] = []
  for (const raw of d.intent) {
    const parsed = parseEntry(raw)
    if (parsed === null) return null
    intent.push(parsed)
  }

  const { slots } = slotsFor({ ...emptyState(), current })
  return {
    v: QUEUE_SCHEMA_VERSION,
    current,
    intent: truncateIntent(intent, slots).kept,
    method: isAutoMethod(d.method) ? d.method : 'off',
    history: (d.history as string[]).slice(0, HISTORY_MAX),
    updated_at: d.updated_at,
  }
}

/** True once an entry is older than the TTL. An `updated_at` that fails to
 *  parse is stale — the safe default over "fresh". */
export function isStale(entry: QueueMemoryEntry, now: number = Date.now()): boolean {
  const ts = Date.parse(entry.updated_at)
  if (Number.isNaN(ts)) return true
  return now - ts > QUEUE_MEMORY_TTL_MS
}

/** A parsed payload back to a live state. `failed` and `suppressed` start
 *  empty by design — see this file's header. */
export function stateFromEntry(entry: QueueMemoryEntry): QueueState {
  return {
    current: entry.current,
    intent: entry.intent.slice(),
    method: entry.method,
    history: entry.history.slice(),
    failed: [],
    suppressed: [],
  }
}

// ------------------------------------------------------- the singleton

/**
 * THE SINGLETON LIVES HERE. Every caller imports THIS path, and Vite emits one
 * shared chunk for a module several entry points import, so all of them see
 * the same store. A copied module — or a second `let current` anywhere — would
 * be a second, silent queue. That is the same trap upload-batch.ts documents,
 * and it is the mechanism by which the queue survives a ClientRouter
 * navigation: ES modules are cached by URL, and a soft navigation does not
 * re-evaluate one the browser has already run.
 */
let current: QueueState = emptyState()
const listeners = new Set<(s: QueueState) => void>()

export function getState(): QueueState {
  return current
}

/**
 * Replace the state and notify. Deliberately does NOT reduce, regenerate or
 * persist — this module is the state, not the engine. site.ts calls
 * `reduce` / `regenerate` and hands the result here.
 *
 * A listener that throws is contained: a drawer that fails to render must not
 * take the transport down with it.
 */
export function setState(next: QueueState): void {
  current = next
  for (const fn of listeners) {
    try {
      fn(current)
    } catch (e) {
      console.error('queue listener:', e)
    }
  }
}

/** Returns its own unsubscribe. Does NOT fire on subscribe: the drawer renders
 *  once at init anyway, and a synchronous callback during wiring is a
 *  half-built-DOM bug waiting to happen. */
export function subscribe(fn: (s: QueueState) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
