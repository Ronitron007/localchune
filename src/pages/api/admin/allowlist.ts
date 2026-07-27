// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { normalizeEmail } from '../../../lib/email'

/** 404, not 403 — do not confirm the route exists to a non-owner. */
const guard = (locals: App.Locals) => locals.member?.role === 'owner'

async function readEmail(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => ({}))) as { email?: string }
  try {
    return normalizeEmail(body.email ?? '')
  } catch {
    return null
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!guard(locals)) return new Response('Not found', { status: 404 })
  const email = await readEmail(request)
  if (!email) return Response.json({ error: 'invalid email' }, { status: 400 })
  // locals.supabase — the cookie-bound client middleware already built for
  // this request — NOT a second serverClient(cookies, request) and NOT a
  // service key. A second client's getAll reads the original Cookie request
  // header, so if middleware just rotated the token via a refresh, the
  // second client sees a stale refresh token and can hit "Already Used",
  // making this RPC run unauthenticated and silently return 0 rows. Reusing
  // locals.supabase avoids that race. admin_invite also re-checks
  // is_owner() in the database, so authorisation is enforced in one place.
  const { data, error } = await locals.supabase.rpc('admin_invite', { p_email: email })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ email: data }, { status: 201 })
}

export const DELETE: APIRoute = async ({ request, locals }) => {
  if (!guard(locals)) return new Response('Not found', { status: 404 })
  const email = await readEmail(request)
  if (!email) return Response.json({ error: 'invalid email' }, { status: 400 })
  const { error } = await locals.supabase.rpc('admin_revoke', { p_email: email })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ revoked: true })
}
