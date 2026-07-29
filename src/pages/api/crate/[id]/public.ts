// src/pages/api/crate/[id]/public.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, readJsonBody, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * Toggles a crate the caller owns public/private. crate_set_public
 * (migration 20) does every real check (member gate, owner_id =
 * auth.uid() -> 42501) and sets/clears made_public_at — this route only
 * reads the target state and maps the RPC result onto HTTP.
 *
 * `public` carries the TARGET state (what the toggle button on
 * crate/[id].astro's header wants the crate to become next), not the
 * current one — the page already knows the current state and flips it
 * into the hidden field, so this route never has to re-derive "opposite of
 * what it is now" itself.
 *
 * Route skeleton copied from like.ts, same as rename.ts's header comment.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  let makePublic: boolean | null
  if (isForm) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'bad_request', 'malformed form body')
    }
    const raw = form.get('public')
    makePublic = raw === 'true' ? true : raw === 'false' ? false : null
  } else {
    const body = await readJsonBody(request)
    makePublic = typeof body.public === 'boolean' ? body.public : null
  }
  if (makePublic === null) return jsonError(400, 'bad_request', 'public must be true or false')

  try {
    const { error } = await locals.supabase.rpc('crate_set_public', { p_crate: id, p_public: makePublic })
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
