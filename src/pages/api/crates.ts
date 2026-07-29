// src/pages/api/crates.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, jsonError, rpcError } from '../../lib/upload-api'

/**
 * Crate creation. /crates.astro's "+ new crate" is a plain
 * `<form method="post" action="/api/crates">`, no island (Task 6) — the
 * body is always `application/x-www-form-urlencoded`. crate_create
 * (migration 20) does every real check (member gate, trim/1-80 chars,
 * auto-suffix on a name collision against the caller's own crates) — this
 * route only reads the form and maps the RPC result onto HTTP, the same
 * division of labour as tags.ts/welcome.ts.
 *
 * Response shape is chosen by `Accept`, not by how the request body was
 * sent, since the body is always form-urlencoded here: a plain-form
 * navigation gets the 303 round trip; a JSON-expecting caller (Task 8's
 * add-to-crate picker, which can create a crate inline) gets `{id}`
 * instead. Unlike like.ts's dual mode, there is no JSON request body to
 * branch on in this task.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonError(400, 'bad_request', 'malformed form body')
  }

  const raw = form.get('name')
  const name = typeof raw === 'string' ? raw : ''

  let data: string | undefined
  try {
    const result = await locals.supabase.rpc('crate_create', { p_name: name })
    if (result.error) return rpcError(result.error)
    data = result.data
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json')
  if (wantsJson) {
    return Response.json({ id: data }, { headers: { 'cache-control': 'private, no-store' } })
  }

  // /crate/[id] does not exist yet (Task 7) — this redirect 404s until
  // then. Expected and fine for this task; see task-6-brief.md.
  return redirect(`/crate/${data}`, 303)
}
