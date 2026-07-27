// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { serverClient } from '../../lib/supabase.server'

export const GET: APIRoute = async ({ url, cookies, redirect, request }) => {
  const err = url.searchParams.get('error_description')
  if (err) return redirect(`/login?error_description=${encodeURIComponent(err)}`)

  const code = url.searchParams.get('code')
  if (!code) return redirect('/login')

  // The code_verifier signInWithOAuth wrote into a cookie via browserClient()
  // (src/lib/supabase.ts) is read back here through the Cookie request
  // header — see src/lib/supabase.server.ts for why. Without @supabase/ssr,
  // this exchange was impossible: the verifier lived only in the browser's
  // localStorage, which a server-side client never sees.
  const sb = serverClient(cookies, request)
  const { data, error } = await sb.auth.exchangeCodeForSession(code)
  if (error || !data.session) {
    return redirect(`/login?error_description=${encodeURIComponent(error?.message ?? 'sign-in failed')}`)
  }
  // @supabase/ssr writes the session cookies itself via setAll (see
  // serverClient) — no manual cookies.set() needed here.
  return redirect('/')
}
