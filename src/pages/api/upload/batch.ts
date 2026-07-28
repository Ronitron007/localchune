// src/pages/api/upload/batch.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { jsonError, parseBatchBody, readJsonBody, rpcError } from '../../../lib/upload-api'

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parseBatchBody(await readJsonBody(request))
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)

  // locals.supabase — the cookie-bound client middleware built for this
  // request. NOT a second serverClient(cookies, request): a second client's
  // getAll re-reads the original Cookie header and can miss a token
  // rotation middleware just performed, making the RPC run unauthenticated.
  const { data, error } = await locals.supabase.rpc('upload_batch_create', {
    p_label: parsed.value.label,
  })
  if (error) return rpcError(error)
  return Response.json({ batch_id: data }, { status: 201 })
}
