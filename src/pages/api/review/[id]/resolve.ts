// src/pages/api/review/[id]/resolve.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The reviewer's verdict. Route skeleton copied from
// api/crate/[id]/rename.ts: member gate, id -> 400, the RPC wrapped in
// try/catch -> dbErrorResponse, a plain x-www-form-urlencoded POST -> 303
// back to wherever the form was, anything else -> JSON.
//
// NO content-type: application/json HEADER IS NEEDED for the form path. A
// native same-origin form POST already carries a matching Origin header, so
// Astro's security.checkOrigin passes it for free. The JSON header belongs
// to fetch() calls from islands, and there are none on /review.
//
// The 404-not-403 guard is deliberate and matches /api/admin/allowlist.ts:
// a non-owner is not told this route exists. review_resolve() raises 42501
// in the database regardless, so this is the redundant half of a
// redundant-authorization pair, not the gate itself.
import type { APIRoute } from 'astro'
import { dbErrorResponse, jsonError, rpcError } from '../../../../lib/upload-api'
import { sameOriginRedirectTarget } from '../../../../lib/org-api'

const VERDICTS = new Set(['same', 'different', 'version'])

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  if (locals.member.role !== 'owner') return new Response('Not found', { status: 404 })

  const decisionId = Number(params.id)
  if (!Number.isSafeInteger(decisionId) || decisionId <= 0) {
    return jsonError(400, 'bad_request', 'not a decision id')
  }

  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  let verdict = ''
  let note: string | null = null
  if (isForm) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'bad_request', 'malformed form body')
    }
    const raw = form.get('verdict')
    verdict = typeof raw === 'string' ? raw : ''
    const rawNote = form.get('note')
    note = typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote : null
  } else {
    let body: Record<string, unknown> = {}
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return jsonError(400, 'bad_request', 'malformed json body')
    }
    verdict = typeof body.verdict === 'string' ? body.verdict : ''
    note = typeof body.note === 'string' ? body.note : null
  }

  // Checked here as well as in the database: a bad verdict should be a 422
  // naming the three that work, not a raw SQLSTATE the reviewer has to
  // decode.
  if (!VERDICTS.has(verdict)) {
    return jsonError(422, 'invalid', 'verdict must be same, different or version')
  }

  let result: unknown
  try {
    const { data, error } = await locals.supabase.rpc('review_resolve', {
      p_decision_id: decisionId,
      p_verdict: verdict,
      p_note: note,
    })
    if (error) return rpcError(error)
    result = data
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  if (isForm) {
    const target = sameOriginRedirectTarget(
      request.headers.get('referer'), request.url, '/review')
    return redirect(target, 303)
  }
  return Response.json(result, { headers: { 'cache-control': 'private, no-store' } })
}
