// src/pages/api/crate/[id]/move.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, readJsonBody, rpcError } from '../../../../lib/upload-api'
import { moveInList, sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * Moves one track up or down by one position — the crate page's always-
 * present ↑/↓ button forms (work with no JS, no mouse; this is the
 * accessible fallback the drag-to-reorder enhancement in site.ts needs).
 *
 * The RPC surface is exactly migration 20's: there is no "move by one"
 * RPC, only crate_reorder(p_crate, p_files uuid[]) which rewrites the
 * whole run. So this route reads the crate's CURRENT order via crate_get
 * (ordered by position already), finds file_id's index, applies the same
 * moveInList() the drag code's tests cover, and sends the full resulting
 * array to crate_reorder — which independently re-checks ownership
 * (42501) and that the array is still a permutation (22023) before
 * committing, exactly like every other write in this file's redundant-
 * authorization discipline (see upload-api.ts's loadOwnedJob comment).
 *
 * A file_id crate_get does not return position for (already removed, or
 * never in the crate) is a 404 — the caller's button was stale, not the
 * server's fault, and there is nothing to move.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  let fileId: unknown
  let dir: unknown
  if (isForm) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'bad_request', 'malformed form body')
    }
    fileId = form.get('file_id')
    dir = form.get('dir')
  } else {
    const body = await readJsonBody(request)
    fileId = body.file_id
    dir = body.dir
  }
  if (!isUuid(fileId)) return jsonError(400, 'bad_request', 'file_id must be a uuid')
  if (dir !== 'up' && dir !== 'down') return jsonError(400, 'bad_request', "dir must be 'up' or 'down'")

  try {
    const { data: rows, error: getError } = await locals.supabase.rpc('crate_get', { p_crate: id })
    if (getError) return rpcError(getError)

    const order = (rows ?? []).map((r: { file_id: string }) => r.file_id)
    const index = order.indexOf(fileId)
    if (index === -1) return jsonError(404, 'not_found', 'file not in crate')

    const reordered = moveInList(order, index, dir)
    const { error: reorderError } =
      await locals.supabase.rpc('crate_reorder', { p_crate: id, p_files: reordered })
    if (reorderError) return rpcError(reorderError)
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  if (isForm) {
    const target = sameOriginRedirectTarget(request.headers.get('referer'), request.url, `/crate/${id}`)
    return redirect(target, 303)
  }
  return Response.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } })
}
