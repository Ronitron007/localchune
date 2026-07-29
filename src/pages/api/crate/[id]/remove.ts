// src/pages/api/crate/[id]/remove.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, readJsonBody, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * Removes one track from a crate the caller owns. crate_remove (migration
 * 20) does every real check (member gate, owner_id = auth.uid() -> 42501)
 * and leaves a gap in position rather than renumbering — this route only
 * reads file_id and maps the RPC result onto HTTP.
 *
 * Route skeleton copied from like.ts, same as rename.ts's header comment.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  let fileId: unknown
  if (isForm) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'bad_request', 'malformed form body')
    }
    fileId = form.get('file_id')
  } else {
    fileId = (await readJsonBody(request)).file_id
  }
  if (!isUuid(fileId)) return jsonError(400, 'bad_request', 'file_id must be a uuid')

  try {
    const { error } = await locals.supabase.rpc('crate_remove', { p_crate: id, p_file: fileId })
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
