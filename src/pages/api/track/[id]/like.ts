// src/pages/api/track/[id]/like.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * Toggles the caller's like on one track — migration 19's toggle_like RPC
 * does the actual delete-first flip and returns the count AFTER the call.
 * No ownership check: any active member may like any pool-visible file.
 * 42501 (not active/owner) and P0002 (not pool-visible) both come back
 * through rpcError as 403/404 — the same vocabulary every /api/track route
 * already uses.
 *
 * Two callers, one route: the row's <form class="likeform"> posts a plain
 * `application/x-www-form-urlencoded` body with no JS, and site.ts's
 * document-level submit delegation intercepts the same form when JS is on
 * and calls org-api.ts's toggleLike() instead (fetch, JSON). Content-type
 * is what tells the two apart here — the no-JS path gets tags.ts's plain
 * 303-back-to-referer round trip, the JS path gets JSON so it can update
 * the button in place. There is no third caller: without a content-type at
 * all (curl with an empty body) this falls through to the JSON branch,
 * which is the safer default for a scriptable client.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  let row: { like_count: number; liked: boolean } | undefined
  try {
    const { data, error } = await locals.supabase.rpc('toggle_like', { p_file: id })
    if (error) return rpcError(error)
    row = data?.[0]
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
  if (!row) return jsonError(500, 'rpc_error', 'toggle_like returned no row')

  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    // Plain <form> round trip, no JS: back to wherever the form was — the
    // track page or the pool table, whichever rendered it. tags.ts always
    // knows its one destination (/track/[id]); this route has two, so it
    // trusts Referer instead, with the track page as a safe fallback when
    // a client sends none. sameOriginRedirectTarget is the same
    // open-redirect guard the five /api/crate/[id]/* routes use — see its
    // doc comment in org-api.ts.
    const redirectTo = sameOriginRedirectTarget(request.headers.get('referer'), request.url, `/track/${id}`)
    return redirect(redirectTo, 303)
  }

  return Response.json(
    { like_count: row.like_count, liked: row.liked },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
