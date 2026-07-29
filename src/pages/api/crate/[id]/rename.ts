// src/pages/api/crate/[id]/rename.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, readJsonBody, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * Renames a crate the caller owns. crate_rename (migration 20) does every
 * real check — member gate, owner_id = auth.uid() (42501 otherwise),
 * trim/1-80 chars (22023), auto-suffix on a same-owner name collision —
 * this route only reads the body and maps the RPC result onto HTTP, same
 * division of labour as tags.ts.
 *
 * Route skeleton copied from like.ts: member gate, uuid -> 400, the RPC
 * call wrapped in try/catch -> dbErrorResponse (a thrown/rejected
 * PostgREST call must still come back as JSON, never a bodyless 500), a
 * plain `application/x-www-form-urlencoded` POST (the page's header
 * <form>, no JS) -> 303 back to wherever the form was — Referer,
 * same-origin validated, falling back to the crate page itself — anything
 * else -> JSON.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  let name: string
  if (isForm) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'bad_request', 'malformed form body')
    }
    const raw = form.get('name')
    name = typeof raw === 'string' ? raw : ''
  } else {
    const body = await readJsonBody(request)
    name = typeof body.name === 'string' ? body.name : ''
  }

  try {
    const { error } = await locals.supabase.rpc('crate_rename', { p_crate: id, p_name: name })
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
