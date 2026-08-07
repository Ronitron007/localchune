// src/pages/api/search.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, jsonError, rpcError } from '../../lib/upload-api'
import { SEARCH_LIMIT, parseSearchQuery, toSearchResult } from '../../lib/search-api'

/**
 * The nav overlay's one endpoint. One RPC, one projection, no state.
 *
 * A QUERY TOO SHORT IS AN EMPTY RESULT, NOT A 400. The overlay already
 * refuses to send one (`isSearchable`), so a short `q` arriving here means
 * either a hand-written URL or a bug — and in both cases `{results: []}` is
 * the honest answer to "what matches `a`?" while a 400 would make the
 * overlay render an error banner for a member who is still typing. The
 * route does not trust the client's floor; it applies the same one.
 *
 * THE PROJECTION IS NOT DECORATION — see search-api.ts. `search_tracks`
 * already returns a strict subset of pool_list's columns (no raw_tags, no
 * r2_key, no provenance), and `toSearchResult` narrows it again to the
 * eight fields a row renders. Do not forward `data` verbatim to "save a
 * map": that map is what keeps a future migration's new column from
 * reaching the browser by default.
 *
 * `{error}` JSON on every failure, with the caveat /source and
 * /queue/candidates both carry: src/middleware.ts redirects a request with
 * no live member to /login and fetch() follows it, so a dead session
 * reaches the client as 200 text/html. That is why fetchSearch checks
 * content-type before parsing, and why the 401 below is mostly
 * belt-and-braces.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const q = parseSearchQuery(url.searchParams.get('q'))
  if (q === null) {
    return Response.json(
      { results: [] },
      { headers: { 'cache-control': 'private, no-store' } },
    )
  }

  try {
    const { data, error } = await locals.supabase.rpc('search_tracks', {
      p_q: q,
      p_lim: SEARCH_LIMIT,
    })
    if (error) return rpcError(error)
    const rows = (data ?? []) as Record<string, unknown>[]
    return Response.json(
      { results: rows.map(toSearchResult) },
      // Per-member (liked_by_me is in the RPC's output) and pool-visibility
      // dependent: never shared, never stored.
      { headers: { 'cache-control': 'private, no-store' } },
    )
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
}
