// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { createClient } from '@supabase/supabase-js'

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const err = url.searchParams.get('error_description')
  if (err) return redirect(`/login?error_description=${encodeURIComponent(err)}`)

  const code = url.searchParams.get('code')
  if (!code) return redirect('/login')

  // See src/middleware.ts for why this is import.meta.env rather than
  // locals.runtime.env — that API was removed by the installed Astro v6+
  // @astrojs/cloudflare, and this app has no wrangler env bindings.
  const env = import.meta.env as unknown as Record<string, string>
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { flowType: 'pkce', persistSession: false },
  })
  const { data, error } = await sb.auth.exchangeCodeForSession(code)
  if (error || !data.session) {
    return redirect(`/login?error_description=${encodeURIComponent(error?.message ?? 'sign-in failed')}`)
  }
  cookies.set('sb-access-token', data.session.access_token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: data.session.expires_in,
  })
  cookies.set('sb-refresh-token', data.session.refresh_token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30,
  })
  return redirect('/')
}
