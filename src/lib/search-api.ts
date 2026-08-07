// src/lib/search-api.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The pure half of search: what a query means, what a result looks like on
 * the wire, and the one fetch the overlay makes. No DOM and no `document`,
 * so this file's test runs in plain node — the same split queue-model.ts
 * and sheet.ts already use.
 *
 * WHY THE PROJECTION IS NARROWER THAN THE RPC. `search_tracks` returns
 * fourteen columns; the overlay renders eight of them. `toSearchResult`
 * drops the rest before anything reaches the browser, for the same reason
 * queue-candidates.ts does it: migrations 20 and 28 exist to have narrowed
 * what leaves the database, and a route that forwards `data` verbatim is
 * one `select *` away from re-widening it silently. The test feeds this
 * function a row carrying `raw_tags` and `r2_key` to prove they are
 * dropped even if a future migration hands them over.
 */

import { SessionExpiredError } from './org-api'

/**
 * Below this, the overlay makes NO REQUEST AT ALL.
 *
 * Two characters is also where the trigram index stops being able to help:
 * `gin_trgm_ops` matches on three-character trigrams, so a one- or
 * two-character `LIKE '%ab%'` degrades to a sequential scan. The floor is
 * therefore both a UX decision (one letter matches most of the pool, which
 * is not an answer) and the point where the query stops being cheap.
 */
export const MIN_QUERY_LENGTH = 2

/** What the overlay asks for. `search_tracks` clamps to 50 server-side. */
export const SEARCH_LIMIT = 10

/**
 * The eight fields a result row renders, in one place, so the route, the
 * projection, the renderer and the test cannot drift apart.
 */
export const SEARCH_RESULT_KEYS = [
  'file_id', 'display_artist', 'display_title', 'bpm', 'key_camelot',
  'quality_tier', 'has_thumb', 'duration_ms',
] as const

export type SearchResult = {
  file_id: string
  display_artist: string | null
  display_title: string
  bpm: number | null
  key_camelot: string | null
  quality_tier: number | null
  has_thumb: boolean
  duration_ms: number | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One `search_tracks` row, narrowed. Total rather than validating: a null
 * bpm or a missing key is ordinary data, not a malformed row, and a search
 * that 500s because one track was never analysed is worse than one that
 * renders it without a tempo.
 */
export function toSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    file_id: String(row.file_id ?? ''),
    display_artist: str(row.display_artist),
    // display_title is the one field the database promises is never null —
    // migration 11's fallback chain ends at the filename stem. `??` rather
    // than a throw for the same reason as above.
    display_title: str(row.display_title) ?? 'Untitled',
    bpm: num(row.bpm),
    key_camelot: str(row.key_camelot),
    quality_tier: num(row.quality_tier),
    has_thumb: row.has_thumb === true,
    duration_ms: num(row.duration_ms),
  }
}

/**
 * Whether a raw input is worth a round trip. Trims first: three spaces is
 * an empty query, and `search_tracks` would agree, but agreeing costs a
 * request.
 */
export function isSearchable(raw: string): boolean {
  return raw.trim().length >= MIN_QUERY_LENGTH
}

/**
 * The `q` a request should carry, or null when the input does not earn one.
 * Shared by the route (which must not trust the client) and the overlay
 * (which should not send what the route would refuse).
 */
export function parseSearchQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const q = raw.trim()
  if (q.length < MIN_QUERY_LENGTH) return null
  // A cap, because the RPC tokenises every word and a member cannot mean
  // anything by the 200th one. Not an error: truncating is invisible and
  // 400-ing a long paste is not.
  return q.slice(0, 120)
}

/**
 * GET /api/search.
 *
 * `signal` is not optional in practice — the overlay passes an
 * AbortController's, and the whole point is that the answer to a query the
 * member has already typed past never lands. An aborted fetch rejects with
 * an AbortError; callers test it with `isAbortError` rather than swallowing
 * every failure, so a real outage still reaches the status line.
 *
 * Throws SessionExpiredError on a non-JSON response, the same convention
 * toggleLike and addToCrate use: src/middleware.ts redirects a request with
 * no live member to /login, and fetch() follows it, so a dead session
 * arrives here as 200 text/html rather than as a 401.
 */
export async function fetchSearch(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
    headers: { accept: 'application/json' },
    signal,
  })
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new SessionExpiredError()

  const body = (await res.json()) as { results?: unknown; error?: string; message?: string }
  if (!res.ok) throw new Error(body.message ?? body.error ?? `search failed (${res.status})`)
  if (!Array.isArray(body.results)) return []
  return body.results.map((r) => toSearchResult(r as Record<string, unknown>))
}

/** An aborted fetch is the expected outcome of typing, not a failure. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
