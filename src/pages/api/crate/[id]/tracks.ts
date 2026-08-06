// src/pages/api/crate/[id]/tracks.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'
import { CRATE_TRACK_KEYS, toCrateTrack } from '../../../../lib/queue-view'

/**
 * A crate's tracks, in `position` order, projected onto what the queue needs.
 *
 * WHY THIS ROUTE EXISTS AT ALL — the plan (Task 6) says the `+ queue` control
 * on a crate card "fetches crate_get once via a cached promise" without naming
 * a route, and there was none: /crates.astro renders cards, not track lists,
 * so the browser has no way to learn a crate's contents. The crate PAGE needs
 * nothing from here (its rows are already in the DOM, and site.ts reads them
 * straight off `[data-queue-list]`); only the cards do.
 *
 * NO NEW RPC AND NO MIGRATION, on the same argument /api/queue/candidates.ts
 * makes at length: `crate_get` (migration 27) already enforces crate
 * visibility and pool visibility, already orders by `position`, and is already
 * granted to `authenticated` alone. This handler adds an HTTP shape and a
 * projection, and nothing else.
 *
 * THE PROJECTION IS THE POINT, again. `crate_get` returns pool_get's whole
 * column list — analysis internals, batch and claim provenance, artifact keys.
 * A queue entry needs six fields. Widening this is how migration 20's
 * narrowing gets undone one convenience at a time.
 *
 * 404 covers "no such crate" and "exists, not yours to see" alike: crate_get
 * answers 42501 for both (migration 20's comment), and /crate/[id].astro maps
 * them to the same 404 for exactly the same reason — a probing visitor must
 * not be able to tell them apart.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  try {
    const { data, error } = await locals.supabase.rpc('crate_get', { p_crate: id })
    if (error) {
      if (error.code === '42501') return jsonError(404, 'not_found', 'no such crate')
      return rpcError(error)
    }
    const rows = (data ?? []) as Record<string, unknown>[]
    return Response.json(
      { tracks: rows.map(toCrateTrack) },
      // Crate contents are visibility-dependent per member, and a crate the
      // caller just edited must not answer from a shared cache.
      { headers: { 'cache-control': 'private, no-store' } },
    )
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
}

/** Re-exported so a reader of this route can see the wire shape without
 *  opening another file. */
export { CRATE_TRACK_KEYS }
