// src/lib/queue-candidates.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * M6b — THE CANDIDATE SOURCE. The pure half: the pool_list argument builder,
 * the wire projection, the query validator, and the `CandidatePort`
 * implementation the engine takes by injection.
 *
 * NO NEW RPC, AND THAT IS A DECISION, NOT AN OVERSIGHT. §2 of the plan, and
 * the reason is worth having in front of whoever reads this next, because the
 * obvious instinct is to write `queue_candidates()` and it would be a
 * regression:
 *
 *   pool_list ALREADY IS the candidate query. Migration 11 shipped
 *   camelot_neighbours(); pool_list(p_key, p_harmonic, p_bpm_min, p_bpm_max,
 *   p_half_double, p_tier_min, p_sort, p_limit) already applies the exact
 *   narrowing the harmonic strategy needs, already enforces pool visibility
 *   through is_active_member(), already carries migration 28's provenance
 *   discipline, and is already granted to `authenticated` and to nobody else.
 *   A new RPC would restate all of that, and would re-open the column-grant
 *   question migrations 20 and 28 exist to have CLOSED.
 *
 * So: no migration, no view change, no ACL surface. One thin route over an
 * RPC that already does the work.
 *
 * THE PROJECTION IS THE POINT. pool_list returns 29 columns; a queue tail
 * needs eleven. Sending the rest to the browser on every regeneration would be
 * wasteful and a slow re-widening of exactly what migration 20 narrowed. The
 * `provenance` column that migrations 20 and 28 fought over lives on pool_get
 * rather than pool_list, and it must never arrive here either — the test
 * feeds this module a row carrying one, to prove the projection drops
 * whatever it is handed.
 *
 * THE FEED STAYS PER-FILE. `candidateArgs` still names neither `p_collapse`
 * nor `p_q_mode` (POOL.1's two new arguments), so this route still asks
 * pool_list for one row per FILE — and the vitest guards that assert those two
 * names never appear here are still green. That is deliberate and it is the
 * opposite of an oversight: the engine must be able to CHOOSE which encode of
 * a recording to play, and it can only choose between rows it can see.
 * `queue-engine.ts` collapses them, one row per recording, by a rule written
 * where the choice is made. See `collapseByRecording` and `preferredCopy`.
 */

import { parseCamelot } from './track-format'
import { SessionExpiredError } from './org-api'
import { BPM_WINDOW, type TrackFeatures } from './queue-strategies'

/** pool_list clamps p_limit to `least(greatest(p_limit,1),200)` server-side.
 *  Matching it here means the client and the server agree on what a full
 *  window is, instead of the client asking for a number it will not get. */
export const CANDIDATE_LIMIT = 200

/**
 * The eleven fields, in one place, so the route, the projection and the test
 * cannot drift apart.
 *
 * IT WAS NINE UNTIL QUEUE.dedupe, AND THE TWO IT GAINED ARE THE BUG FIX.
 * `track_id` is what makes the FLAC, the 320 and the m4a of one recording one
 * song instead of three candidates that score identically and all get queued;
 * `quality_tier` is the first term of the rule that decides which of them
 * survives (queue-engine.ts `preferredCopy`). Both come straight off
 * `pool_list`, which has returned them all along — the projection simply threw
 * them away. NO MIGRATION, and none was needed.
 *
 * Adding a TWELFTH still has to be argued for. The narrowing is the point.
 */
export const TRACK_FEATURE_KEYS = [
  'file_id', 'track_id', 'display_artist', 'display_title', 'duration_ms',
  'bpm', 'key_camelot', 'quality_tier', 'like_count', 'play_count',
  'created_at',
] as const

/** What the request narrows by: the seed's key and tempo, nothing else. */
export type CandidateSeed = { key: string | null; bpm: number | null }

export type CandidateQuery = CandidateSeed & { limit: number }

const clampLimit = (n: number): number => {
  if (!Number.isFinite(n)) return CANDIDATE_LIMIT
  return Math.min(Math.max(Math.floor(n), 1), CANDIDATE_LIMIT)
}

/**
 * Total, never throws — the same discipline parsePoolQuery holds, and for the
 * same reason: pool_list raises 22023 on an off-wheel key, and that error has
 * no business reaching a member whose queue simply lost its analysis. A
 * request with no usable key degrades to a BPM-window query; one with neither
 * degrades to "the newest 200 pool-visible tracks", which is still a perfectly
 * good thing for `shuffle` to draw from.
 */
export function parseCandidateQuery(sp: URLSearchParams): CandidateQuery {
  const key = parseCamelot(sp.get('key'))
  const bpmRaw = Number(sp.get('bpm'))
  const limitRaw = sp.get('limit')
  return {
    key: key === null ? null : `${key.num}${key.letter}`,
    bpm: Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : null,
    limit: clampLimit(limitRaw === null || limitRaw.trim() === '' ? Number.NaN : Number(limitRaw)),
  }
}

/**
 * The pool_list call, built once and shared by the route and its test.
 *
 * `p_harmonic` is true ONLY when there is a key to be harmonic about —
 * camelot_neighbours(null) would be meaningless and pool_list ignores p_key
 * when it is null, so a keyless seed becomes a pure BPM-window query. That is
 * §1.3 case 5: an unanalysed seed still gets a tempo-matched tail.
 *
 * `p_half_double: false`. A 64 BPM track IS harmonically and rhythmically
 * compatible with a 128 BPM one, and playing it is a deliberate DJ move — not
 * something autoplay should do to you while you are doing something else.
 *
 * `p_sort: 'added_desc'` because the strategy re-ranks everything anyway; the
 * sort only decides WHICH 200 rows we see when the window holds more. It must
 * not be 'plays_desc' — counting the auto tail's own picks into a discovery
 * ranking is the feedback loop §2.2 declines to build, and a test asserts it.
 */
export function candidateArgs(seed: CandidateSeed, limit: number): Record<string, unknown> {
  const hasBpm = typeof seed.bpm === 'number' && Number.isFinite(seed.bpm) && seed.bpm > 0
  return {
    p_q: null,
    p_bpm_min: hasBpm ? (seed.bpm as number) * (1 - BPM_WINDOW) : null,
    p_bpm_max: hasBpm ? (seed.bpm as number) * (1 + BPM_WINDOW) : null,
    p_half_double: false,
    p_key: seed.key,
    p_harmonic: seed.key !== null,
    p_tier_min: null,
    p_uploader: null,
    p_sort: 'added_desc',
    p_cursor: null,
    p_limit: clampLimit(limit),
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * pool_list row -> the eleven fields, and NOTHING else. Written as an explicit
 * object rather than a pick-list loop so that adding a field is a deliberate
 * edit somebody has to justify, which is the whole guard.
 *
 * `track_id` NORMALISES TO NULL, and that is not tidiness. A file the matcher
 * has never grouped has a null recording, and queue-model.ts treats null as
 * ITS OWN IDENTITY — never as a shared "unknown" bucket that would collapse
 * every unmatched file in the pool into one queue entry. An empty string
 * arriving from anywhere is the same statement, so `str` answering null for a
 * non-string and this line answering null for `''` are the same rule.
 */
export function toTrackFeatures(row: Record<string, unknown>): TrackFeatures {
  const track = str(row.track_id)
  return {
    file_id: String(row.file_id),
    track_id: track === null || track === '' ? null : track,
    display_artist: str(row.display_artist),
    display_title: typeof row.display_title === 'string' ? row.display_title : '',
    duration_ms: num(row.duration_ms),
    bpm: num(row.bpm),
    key_camelot: str(row.key_camelot),
    quality_tier: num(row.quality_tier),
    like_count: count(row.like_count),
    play_count: count(row.play_count),
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
  }
}

/** Only the seed's key and tempo ever reach the URL — never a title, never an
 *  uploader, never anything a shared link could leak. */
export function candidatesHref(seed: TrackFeatures | null): string {
  const sp = new URLSearchParams()
  if (seed?.key_camelot) {
    const k = parseCamelot(seed.key_camelot)
    if (k !== null) sp.set('key', `${k.num}${k.letter}`)
  }
  if (typeof seed?.bpm === 'number' && Number.isFinite(seed.bpm) && seed.bpm > 0) {
    sp.set('bpm', String(seed.bpm))
  }
  sp.set('limit', String(CANDIDATE_LIMIT))
  return `/api/queue/candidates?${sp.toString()}`
}

/**
 * THE `CandidatePort` IMPLEMENTATION. One fetch per regeneration, hard rule.
 *
 * `need` is deliberately NOT used to size the request. The strategy needs
 * something to rank: asking for 3 rows to fill 3 slots would hand the harmonic
 * chain no choice at all. The window is the full 200, and it is what bounds
 * how far a 24-long chain can drift — which is a feature, since a set should
 * not wander from 128 to 96 BPM without being asked.
 *
 * Content-type-first, exactly as org-api.ts documents: src/middleware.ts
 * redirects a request without a live member to /login and fetch() follows that
 * redirect itself, so a dead session arrives here as a 200 text/html, never a
 * 401. Content-type is the only way to tell that apart, so it is checked
 * BEFORE the body is parsed.
 */
export async function fetchCandidates(
  seed: TrackFeatures | null, _need: number,
): Promise<TrackFeatures[]> {
  const res = await fetch(candidatesHref(seed), { headers: { accept: 'application/json' } })
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new SessionExpiredError()

  const body = (await res.json()) as {
    candidates?: unknown
    error?: string
    message?: string
  }
  if (!res.ok) throw new Error(body.message ?? body.error ?? `request failed (${res.status})`)
  if (!Array.isArray(body.candidates)) return []
  return body.candidates.map((r) => toTrackFeatures(r as Record<string, unknown>))
}
