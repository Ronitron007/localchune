// src/pages/api/queue/candidates.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, jsonError, rpcError } from '../../../lib/upload-api'
import {
  candidateArgs, parseCandidateQuery, toTrackFeatures,
} from '../../../lib/queue-candidates'

/**
 * Where the auto queue's tail comes from. One RPC, one projection, no state.
 *
 * NO NEW RPC — AND THE NEXT INSTINCT IS TO WRITE ONE, SO READ THIS FIRST.
 * `queue_candidates()` would be a regression, not an improvement. `pool_list`
 * ALREADY IS the candidate query:
 *
 *   - migration 11 shipped `camelot_neighbours()`, and `pool_list`'s
 *     `p_key`/`p_harmonic` pair already applies the exact Camelot narrowing
 *     the harmonic strategy needs;
 *   - `p_bpm_min`/`p_bpm_max` already apply the ±6 % window;
 *   - it already enforces pool visibility (`is_active_member()`, 42501);
 *   - it already carries migration 28's provenance discipline;
 *   - it is already `granted execute` to `authenticated` and to nobody else.
 *
 * A second RPC would restate every one of those, and would re-open the
 * column-grant question migrations 20 and 28 exist to have closed. So this
 * milestone adds no migration, no view change and no ACL surface — see
 * src/lib/queue-candidates.ts for the argument in full.
 *
 * THE PROJECTION IS NOT DECORATION. `pool_list` returns 29 columns; a queue
 * tail needs nine. `toTrackFeatures` drops the rest before anything reaches
 * the browser, which keeps a regeneration cheap and keeps migration 20's
 * narrowing narrow. Do not widen it to "save a round trip" — there is no
 * round trip to save; the drawer renders from the queue entries it already
 * has.
 *
 * `{error}` JSON on every failure, with the same caveat `/source` carries:
 * src/middleware.ts redirects a request with no live member to /login and
 * fetch() follows it, so a dead session reaches the client as 200 text/html.
 * That is why `fetchCandidates` checks content-type before parsing, and why
 * the 401 below is mostly belt-and-braces.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  // Total and forgiving: an off-wheel key or a missing tempo degrades the
  // query rather than 4xx-ing it. A member whose current track never got
  // analysed still deserves a tail — §1.3 case 5.
  const q = parseCandidateQuery(url.searchParams)

  try {
    const { data, error } = await locals.supabase.rpc(
      'pool_list', candidateArgs({ key: q.key, bpm: q.bpm }, q.limit))
    if (error) return rpcError(error)
    const rows = (data ?? []) as Record<string, unknown>[]
    return Response.json(
      { candidates: rows.map(toTrackFeatures) },
      // Per-member and pool-visibility dependent: never shared, never stored.
      { headers: { 'cache-control': 'private, no-store' } },
    )
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
}
