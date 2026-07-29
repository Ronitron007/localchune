// src/pages/api/crate/[id]/delete.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'

/**
 * Deletes a crate the caller owns. crate_delete (migration 20) does every
 * real check (member gate, owner_id = auth.uid() -> 42501) and cascades
 * crate_items via its FK — this route only maps the RPC result onto HTTP.
 *
 * Unlike rename/public/remove/move, success has nowhere sensible to go
 * back to — the crate page this form was submitted from no longer exists.
 * The plain-form branch therefore always 303s to /crates, never a
 * Referer-derived target (crate/[id].astro's delete form also carries an
 * `onsubmit` `confirm()` guard client-side; this route enforces nothing
 * about that — a replayed/hand-crafted POST still deletes, same as every
 * other destructive form in this app).
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  try {
    const { error } = await locals.supabase.rpc('crate_delete', { p_crate: id })
    if (error) return rpcError(error)
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return redirect('/crates', 303)
  }
  return Response.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } })
}
