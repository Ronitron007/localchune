// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { defineMiddleware } from 'astro:middleware'
import { serverClient } from './lib/supabase.server'

const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/auth/signout'])

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.member = null
  ctx.locals.accessToken = null

  const sb = serverClient(ctx.cookies, ctx.request)
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
      ctx.locals.accessToken = session.access_token
    }
  }

  const path = new URL(ctx.request.url).pathname
  if (!ctx.locals.member && !PUBLIC_PATHS.has(path)) {
    return ctx.redirect('/login')
  }
  if (path.startsWith('/admin') && ctx.locals.member?.role !== 'owner') {
    return new Response('Not found', { status: 404 })
  }
  return next()
})
