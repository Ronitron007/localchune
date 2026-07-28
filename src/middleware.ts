// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { defineMiddleware } from 'astro:middleware'
import { serverClient, withAuthCookieHeaders, type AuthCookieHeaders } from './lib/supabase.server'
import { isActive } from './lib/session'

const PUBLIC_PATHS = new Set([
  '/login', '/auth/callback', '/auth/signout',
  // AGPL §13: the source offer must be reachable without an account.
  '/api/build-info',
])

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.member = null

  // Captured by serverClient's setAll whenever this request's auth cookies
  // actually get written (e.g. a near-expiry refresh below). Applied to
  // whichever Response this handler ends up returning, on every return
  // path — see withAuthCookieHeaders.
  let authHeaders: AuthCookieHeaders | undefined
  const sb = serverClient(ctx.cookies, ctx.request, (headers) => {
    authHeaders = headers
  })
  // Shared with the rest of the request so Task 6's admin page/API route
  // reuse this exact client instead of building a second one. A second
  // client's getAll would read the original Cookie request header, missing
  // any refresh this middleware just performed — see src/env.d.ts.
  ctx.locals.supabase = sb

  // getSession() is what triggers @supabase/ssr's lazy session load and,
  // when the access token is expired or near expiry, an on-demand refresh
  // that gets written back to cookies via setAll above — this is the whole
  // fix for sessions dying after ~1h with no refresh. Only call the
  // authenticated-only current_member() RPC below when a session exists;
  // current_member() has EXECUTE revoked from anon, so calling it while
  // signed out would just log a 42501 permission error on every /login hit.
  const { data: { session } } = await sb.auth.getSession()
  if (session) {
    // current_member() rather than .from('members') — the owner RLS policy
    // returns EVERY member row for an owner, and .maybeSingle() errors on >1.
    // The function returns exactly one row for any caller.
    const { data, error } = await sb.rpc('current_member')
    if (error) {
      // Distinguishes a genuine Supabase outage/misconfiguration from "not
      // a member" — both used to fail closed identically with no log line.
      console.error('middleware: current_member RPC failed:', error.message)
    } else if (data && data.length === 1) {
      ctx.locals.member = data[0]
    }
  }

  // A revoked member (admin_revoke sets access_expires_at = now()) is
  // treated as signed out, not merely "0 credits". This check reads
  // access_expires_at fresh from current_member() above on every request —
  // no JWT claim caching involved — so revocation takes effect immediately.
  if (ctx.locals.member && !isActive(ctx.locals.member)) {
    ctx.locals.member = null
  }

  const path = new URL(ctx.request.url).pathname
  if (!ctx.locals.member && !PUBLIC_PATHS.has(path)) {
    return withAuthCookieHeaders(ctx.redirect('/login'), authHeaders)
  }
  if ((path.startsWith('/admin') || path.startsWith('/api/admin')) && ctx.locals.member?.role !== 'owner') {
    return withAuthCookieHeaders(new Response('Not found', { status: 404 }), authHeaders)
  }
  return withAuthCookieHeaders(await next(), authHeaders)
})
