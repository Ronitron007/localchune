// src/lib/player-memory.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * "Have a localStorage which stores the last track the user was listening
 * to and the timestamp" — the owner's ask, verbatim. This module is the
 * pure half: serialising an entry, and validating/aging one read back out
 * of localStorage. It never touches `localStorage` itself (vitest here runs
 * `environment: 'node'`, same reasoning as upload-journal.ts's split) — the
 * DOM boundary (get/setItem, wiring to the <audio> element) lives in
 * site.ts, kept thin on purpose so this carries the tests.
 *
 * The entry deliberately never carries the signed R2 URL — that URL expires
 * on its own schedule, unrelated to this module's 14-day one, and a stale
 * one is a dead link. Restoring instead re-requests
 * `/api/track/<file_id>/source`, the same cookie-authed route the play
 * button already uses, so a resume always re-checks session and pool
 * visibility instead of trusting 14-day-old bytes.
 */

export const PLAYER_MEMORY_KEY = 'localchune:player:v1'

/** Longer than this, a "resume where you left off" stops being useful and
 *  starts being surprising — the owner asked for "last track", not "any
 *  track from the last two weeks". */
export const PLAYER_MEMORY_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface PlayerMemoryEntry {
  file_id: string
  title: string
  position_s: number
  /** ISO 8601, e.g. `new Date().toISOString()`. */
  updated_at: string
}

/**
 * Builds the entry to persist. `positionS` is floored — sub-second seek
 * precision buys nothing here and only makes fixtures harder to eyeball.
 */
export function makeEntry(
  fileId: string, title: string, positionS: number, now: number = Date.now(),
): PlayerMemoryEntry {
  return {
    file_id: fileId,
    title,
    position_s: Math.max(0, Math.floor(positionS)),
    updated_at: new Date(now).toISOString(),
  }
}

export function serializeEntry(entry: PlayerMemoryEntry): string {
  return JSON.stringify(entry)
}

/**
 * Parses and shape-checks a raw `localStorage.getItem` result. Returns
 * `null` for anything that is not a well-formed entry — missing key,
 * corrupt JSON, a future/older schema, a hand-edited value — never throws.
 * Staleness is a SEPARATE check (`isStale`): a parsed-but-stale entry is
 * still a valid entry, just one the restore path should not act on.
 */
export function parseEntry(raw: string | null): PlayerMemoryEntry | null {
  if (raw === null) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { file_id, title, position_s, updated_at } = data as Record<string, unknown>
  if (typeof file_id !== 'string' || file_id.length === 0) return null
  if (typeof title !== 'string') return null
  if (typeof position_s !== 'number' || !Number.isFinite(position_s) || position_s < 0) return null
  if (typeof updated_at !== 'string' || Number.isNaN(Date.parse(updated_at))) return null
  return { file_id, title, position_s, updated_at }
}

/** True once an entry is older than `PLAYER_MEMORY_TTL_MS`. An entry whose
 *  `updated_at` fails to parse is treated as stale — `parseEntry` already
 *  rejects that shape, but a caller building an entry by hand (tests) can
 *  still hit this path, and "stale" is the safe default over "fresh". */
export function isStale(entry: PlayerMemoryEntry, now: number = Date.now()): boolean {
  const ts = Date.parse(entry.updated_at)
  if (Number.isNaN(ts)) return true
  return now - ts > PLAYER_MEMORY_TTL_MS
}
