// src/pages/api/crate/[id]/reorder.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, readJsonBody, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * The drag path: site.ts's drag-to-reorder enhancement serialises the
 * dropped row order into file_ids and POSTs it here as JSON. crate_reorder
 * (migration 27) is the sole authority on whether that array is a valid
 * permutation of the crate's current items (22023 if not — a missing,
 * extra or duplicate id) and on ownership (42501) — this route validates
 * only shape (an array of uuids) before handing it straight through.
 *
 * There is no plain-form UI for this route (dragging needs JS by
 * definition), but the request is still parsed dual-mode for the same
 * reason every other /api/crate/[id]/* route in this task is: a uniform
 * skeleton across all six routes, copied from like.ts, is cheaper to audit
 * than a one-off shape for the one route that happens to have no <form>.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  let raw: unknown
  if (isForm) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'bad_request', 'malformed form body')
    }
    raw = form.getAll('file_ids')
  } else {
    raw = (await readJsonBody(request)).file_ids
  }
  if (!Array.isArray(raw) || !raw.every(isUuid)) {
    return jsonError(400, 'bad_request', 'file_ids must be an array of uuids')
  }
  const fileIds = raw as string[]

  try {
    const { error } = await locals.supabase.rpc('crate_reorder', { p_crate: id, p_files: fileIds })
    if (error) return rpcError(error)
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  if (isForm) {
    const target = sameOriginRedirectTarget(request.headers.get('referer'), request.url, `/crate/${id}`)
    return redirect(target, 303)
  }
  return Response.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } })
}
