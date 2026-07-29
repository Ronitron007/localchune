// src/pages/api/crate/add-dispatch.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../lib/org-api'

/**
 * The no-JS add-to-crate fallback. /track/[id]'s `<select name="crate_id">`
 * form cannot make its own `action="/api/crate/<chosen>/add"` — a plain
 * `<form>`'s action is fixed at render time, and HTML has no way to splice
 * a `<select>`'s chosen value into it — so it posts here instead, with
 * `crate_id` carried as a second form field alongside `file_id`, and this
 * route does exactly what /api/crate/[id]/add.ts does with the crate id
 * read from the body instead of the path: same member gate, same crate_add
 * call, same 23505 -> 409 `{error: 'already_in_crate'}` mapping, same
 * 303-to-Referer round trip.
 *
 * The JS picker (site.ts, org-api.ts's addToCrate) never calls this route —
 * it already knows which crate was clicked and POSTs JSON straight to
 * /api/crate/[id]/add. This dispatcher exists only because the no-JS path
 * cannot know the crate id until the form is actually submitted.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonError(400, 'bad_request', 'malformed form body')
  }

  const crateId = form.get('crate_id')
  const fileId = form.get('file_id')
  if (!isUuid(crateId)) return jsonError(400, 'bad_request', 'crate_id must be a uuid')
  if (!isUuid(fileId)) return jsonError(400, 'bad_request', 'file_id must be a uuid')

  try {
    const { error } = await locals.supabase.rpc('crate_add', { p_crate: crateId, p_file: fileId })
    if (error) {
      if (error.code === '23505') return jsonError(409, 'already_in_crate', 'already in crate')
      return rpcError(error)
    }
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  const target = sameOriginRedirectTarget(request.headers.get('referer'), request.url, `/track/${fileId}`)
  return redirect(target, 303)
}
