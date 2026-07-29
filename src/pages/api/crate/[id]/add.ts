// src/pages/api/crate/[id]/add.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, readJsonBody, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

/**
 * Appends one track to a crate the caller owns. crate_add (migration 20)
 * does every real check (member gate, owner_id = auth.uid() -> 42501) and
 * appends at coalesce(max(position),0)+1 — this route only reads file_id
 * and maps the RPC result onto HTTP.
 *
 * One thing remove.ts/move.ts never need: crate_items' primary key is
 * (crate_id, file_id) (migration 20), so re-adding a track already in the
 * crate raises Postgres 23505 (unique_violation) rather than a silent
 * no-op. That is mapped to 409 `{error: 'already in crate'}` BEFORE the
 * generic rpcError table — upload-api.ts's RPC_STATUS has no 23505 entry,
 * since no other route in this family ever inserts. org-api.ts's
 * addToCrate() turns that 409 into a distinguishable DuplicateCrateItemError
 * so site.ts's picker can show "already in <name>" instead of a generic
 * failure message.
 *
 * Two callers, one route, same dual-mode split as like.ts: the track
 * page's no-JS `<select>` form actually posts to add-dispatch.ts (it needs
 * to choose the crate at submit time, which a form action cannot do) but
 * this route's own plain-form branch stays for completeness/curl/replay —
 * a 303 back to Referer. The JS picker (site.ts, org-api.ts's addToCrate)
 * always knows the crate id already and calls this route directly with
 * JSON, getting `{ok: true}` back.
 *
 * Route skeleton copied from like.ts, same as remove.ts's header comment.
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
    const { error } = await locals.supabase.rpc('crate_add', { p_crate: id, p_file: fileId })
    if (error) {
      if (error.code === '23505') return jsonError(409, 'already in crate', 'already in crate')
      return rpcError(error)
    }
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  if (isForm) {
    const target = sameOriginRedirectTarget(request.headers.get('referer'), request.url, `/crate/${id}`)
    return redirect(target, 303)
  }
  return Response.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } })
}
