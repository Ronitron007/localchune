// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// PERF TASK 2.3 — the app's front door stops shipping a bundle.
//
// `/login` used to import browserClient() to wire one button whose entire
// job was "build an OAuth URL and set location". That import pulled the
// whole of supabase-js into the page: 222 KB of parse, 57.8 KB gzip, on the
// ONE page every visitor sees first and the one surface where nobody has a
// warm cache. The button was dead for 2–4 s on mid-range mobile.
//
// Both halves of that job are server work, so they moved here. The button
// is now an <a href="/auth/start">, this route answers 302, and /login
// ships zero JavaScript — which also means it works with JS disabled.
//
// WHY NOT A HAND-BUILT AUTHORIZE URL. Because the flow is PKCE.
// signInWithOAuth writes a `-code-verifier` cookie, and
// src/pages/auth/callback.ts's exchangeCodeForSession() reads it back; a
// hand-assembled `/auth/v1/authorize?provider=google&redirect_to=…` would
// carry no verifier and the callback would fail at the exchange. Calling
// signInWithOAuth on the SERVER client with `skipBrowserRedirect` keeps
// PKCE intact — the verifier is written through the same cookie adapter
// callback.ts already reads — and hands us the URL to redirect to. This is
// the same client, the same cookie names and the same cookie options the
// callback and the middleware already use.
//
// The one behavioural difference from the deleted client script: the
// verifier cookie is now HttpOnly (serverClient sets httpOnly for every
// cookie it writes). Nothing reads it in the browser — callback.ts is the
// only reader and it is server-side — so this is strictly better.
import type { APIRoute } from 'astro'
import { serverClient, withAuthCookieHeaders, type AuthCookieHeaders } from '../../lib/supabase.server'

export const GET: APIRoute = async ({ cookies, redirect, request, url }) => {
  let authHeaders: AuthCookieHeaders | undefined
  const sb = serverClient(cookies, request, (headers) => {
    authHeaders = headers
  })

  // EXACTLY the value in supabase/config.toml's additional_redirect_urls.
  // A mismatch does not error — Supabase silently falls back to site_url,
  // and the member lands somewhere with no session and no explanation.
  // Built from this request's origin, which is what the deleted client
  // script did with `location.origin`, so local and production both keep
  // working with one line.
  const redirectTo = new URL('/auth/callback', url.origin).href

  const { data, error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  })

  // /login renders `error_description` in a role="alert", the same shape
  // callback.ts already redirects into. A failure here is rare and boring
  // (a misconfigured provider); showing it beats a dead link.
  if (error || !data?.url) {
    return redirect(
      `/login?error_description=${encodeURIComponent(error?.message ?? 'sign-in is unavailable')}`,
    )
  }

  // 302, not 307: this is a GET with no body to preserve, and a 302 is what
  // every browser and every crawler already understands as "go here now".
  return withAuthCookieHeaders(redirect(data.url, 302), authHeaders)
}
