// src/pages/api/track/[id]/tags.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { isUuid, jsonError, parseTagForm, rpcError } from '../../../../lib/upload-api'

/**
 * Uploader-only tag editor, brutalist idiom — a plain <form method="post">
 * from the track detail page, no island. One route handles both add and
 * remove (an `intent` field tells them apart) so the page only ever needs
 * one action URL.
 *
 * Ownership is NOT re-checked here: tag_add/tag_remove (migration 16) check
 * `files.uploaded_by = auth.uid()` in-body, the same discipline as every
 * other definer function this app calls from a route. This handler's only
 * jobs are parsing the form and mapping the RPC result onto HTTP.
 *
 * On success: a 303 redirect back to the detail page — the plain-form
 * round trip. On failure: JSON `{error}`, same vocabulary as every other
 * /api route (rpcError/jsonError) — a hand-edited or replayed form still
 * gets a real error instead of a bodyless 500.
 *
 * TWO ANSWERS, ONE ROUTE — owner, 2026-08-07: adding and removing a tag
 * must not reload the page. `Accept: application/json` gets `{ok: true}`
 * instead of the 303; anything else keeps the redirect, which is the
 * no-JS path and stays exactly as it was. Same content negotiation
 * `/api/crates` already uses for the crate picker, and the same reason:
 * one endpoint, one set of rules, two transports.
 *
 * The BODY stays `application/x-www-form-urlencoded` on both paths.
 * `request.formData()` is the only parser here, and giving the fetch path
 * a JSON body would be a second parse of the same three fields — see
 * CLAUDE.md on the ten routes that branch on the urlencoded type.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonError(400, 'bad_request', 'malformed form body')
  }

  const parsed = parseTagForm(form)
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)

  const { error } =
    parsed.value.intent === 'remove'
      ? await locals.supabase.rpc('tag_remove', { p_file: id, p_tag_key: parsed.value.tagKey })
      : await locals.supabase.rpc('tag_add', { p_file: id, p_tag: parsed.value.tag })
  if (error) return rpcError(error)

  // Negotiated on ACCEPT, not on content-type: the body is urlencoded on
  // both paths (see the header), so content-type cannot tell a fetch from
  // a form here the way it can on /api/track/[id]/like.
  if ((request.headers.get('accept') ?? '').includes('application/json')) {
    return Response.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } })
  }
  return redirect(`/track/${id}`, 303)
}
