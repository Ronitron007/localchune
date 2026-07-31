// src/pages/api/merges/[id]/undo.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The lever on the merges feed. PRD §15's first named risk is "wrong
// auto-merges destroy someone's crates", and its whole mitigation is that
// this route exists and someone notices in time to use it.
//
// undo_merge() is granted to `authenticated` and gates on is_owner() in its
// own body, so the database refuses a non-owner whatever this route does.
// The 404 here is the redundant half — and 404 rather than 403 for the same
// reason /api/admin/allowlist.ts gives: do not confirm the route exists.
//
// The three refusals undo_merge() raises all map through rpcError():
//   P0001 'merge already undone'          -> 409
//   P0001 'a later merge depends on this' -> 409
//   P0002 'no such merge'                 -> 404
// A silent 303 after a refused undo would be the worst outcome available,
// so the form path only redirects once the RPC has actually returned.
import type { APIRoute } from 'astro'
import { dbErrorResponse, jsonError, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  if (locals.member.role !== 'owner') return new Response('Not found', { status: 404 })

  const mergeId = Number(params.id)
  if (!Number.isSafeInteger(mergeId) || mergeId <= 0) {
    return jsonError(400, 'bad_request', 'not a merge id')
  }

  try {
    const { error } = await locals.supabase.rpc('undo_merge', { p_merge_id: mergeId })
    if (error) return rpcError(error)
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const target = sameOriginRedirectTarget(
      request.headers.get('referer'), request.url, '/merges')
    return redirect(target, 303)
  }
  return Response.json({ ok: true, merge_id: mergeId },
    { headers: { 'cache-control': 'private, no-store' } })
}
