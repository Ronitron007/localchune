// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { defineMiddleware } from 'astro:middleware'
import { userClient } from './lib/supabase.server'

const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/auth/signout'])

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.member = null
  ctx.locals.accessToken = null

  const token = ctx.cookies.get('sb-access-token')?.value ?? null
  if (token) {
    // The installed @astrojs/cloudflare (Astro v6+ semantics) removed
    // `locals.runtime.env` — it now throws "has been removed in Astro v6"
    // on access. This app has no wrangler `vars`/`.dev.vars` bindings; env
    // delivery is plain Vite `.env` loading, so import.meta.env is correct
    // both in dev and in the built Worker.
    const env = import.meta.env as unknown as Record<string, string>
    const sb = userClient(env, token)
    // current_member() rather than .from('members') — the owner RLS policy
    // returns EVERY member row for an owner, and .maybeSingle() errors on >1.
    // The function returns exactly one row for any caller.
    const { data } = await sb.rpc('current_member')
    if (data && data.length === 1) {
      ctx.locals.member = data[0]
      ctx.locals.accessToken = token
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
