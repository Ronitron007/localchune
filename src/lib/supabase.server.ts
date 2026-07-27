// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createServerClient, parseCookieHeader, type CookieOptionsWithName } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AstroCookies } from 'astro'

// secure:true breaks cookies on http://localhost in some browsers. Must
// match the cookieOptions in src/lib/supabase.ts — both clients read and
// write the same cookie names.
//
// httpOnly:true — deliberately NOT set in src/lib/supabase.ts's
// cookieOptions, only here. Any XSS can read a non-HttpOnly cookie via
// document.cookie and exfiltrate both the access and refresh tokens, so the
// session cookie must be HttpOnly. This is safe in this app specifically
// because browserClient() (src/lib/supabase.ts) exists solely to call
// signInWithOAuth — the browser never queries Supabase directly, so it
// never needs to read the session cookie. It writes only the separate
// short-lived "-code-verifier" cookie, a different cookie unaffected by
// this flag.
//
// TRADEOFF for future work: if a browser-side browserClient() query is ever
// added (e.g. sb.auth.getSession() or a .from() call run in the browser),
// it will silently see no session — document.cookie cannot read an
// HttpOnly cookie, so @supabase/ssr's browser storage will look empty.
// Prefer moving that query server-side. Only reconsider this flag if that
// is genuinely not possible.
const cookieOptions: CookieOptionsWithName = { secure: import.meta.env.PROD, httpOnly: true }

/**
 * Headers @supabase/ssr passes to `setAll` whenever it actually writes auth
 * cookies (sign-in, sign-out, token refresh). Per the library's own docs,
 * these prevent a CDN/reverse proxy from caching a response that carries a
 * session token — otherwise "one user's session token can be served to a
 * different user." AstroCookies has no response-header API, so serverClient
 * hands them back through this callback instead of applying them itself;
 * the caller applies them to whatever Response it returns.
 */
export type AuthCookieHeaders = Record<string, string>

/** Copies AuthCookieHeaders onto a Response. No-op if headers is undefined. */
export function withAuthCookieHeaders(response: Response, headers: AuthCookieHeaders | undefined): Response {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value)
    }
  }
  return response
}

/**
 * Server-side client backed by the request's cookies. @supabase/ssr keeps
 * both the PKCE code_verifier (written by browserClient() during
 * signInWithOAuth) and the session itself in cookies, so this is the only
 * client that can complete src/pages/auth/callback.ts's code exchange or
 * read/refresh a session for the middleware.
 *
 * AstroCookies has no bulk "getAll" — cookies.get() only returns one name
 * at a time — so `getAll` reads the raw Cookie request header instead.
 * `request` is needed for that read; `cookies` is still what `setAll` uses
 * to write the response, matching how the rest of the app already does it.
 *
 * Build a fresh client per request. Never cache/share one across requests.
 *
 * `onAuthCookiesWritten`, if given, is called with @supabase/ssr's
 * Cache-Control/Expires/Pragma headers every time `setAll` actually writes
 * cookies (i.e. not on requests where nothing changed) — see
 * `withAuthCookieHeaders` above.
 */
export function serverClient(
  cookies: AstroCookies,
  request: Request,
  onAuthCookiesWritten?: (headers: AuthCookieHeaders) => void,
): SupabaseClient {
  return createServerClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions,
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('cookie') ?? ''),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value, options } of cookiesToSet) {
          cookies.set(name, value, options)
        }
        if (Object.keys(headers).length > 0) onAuthCookiesWritten?.(headers)
      },
    },
  })
}

// serviceClient() was removed. import.meta.env.SUPABASE_SERVICE_KEY would be
// undefined in the bundled code even if referenced — Vite's envPrefix only
// exposes PUBLIC_-prefixed vars there — so any call would have thrown
// "supabaseKey is required." It also had zero callers: Task 6's admin path
// uses the caller's own token against security-definer RPCs (admin_invite /
// admin_revoke) which re-check is_owner() in the database, so the service
// key is not needed by the app at all.
//
// That "undefined in the bundle" guarantee does NOT extend to dist/ as a
// whole: `astro build` also copies every var in .env verbatim into
// dist/server/.dev.vars (a raw file on disk, outside Vite's bundling), so a
// secret placed in .env — bundle-reachable or not — still ends up
// world-readable in the build output. SUPABASE_SERVICE_KEY and
// SUPABASE_DB_PASSWORD live in the repo-root .secrets.env instead, which
// astro build never opens, and are sourced by hand for CLI tooling only. If
// a future task genuinely needs the service key in the Worker, the correct
// mechanism on this adapter is `import { env } from "cloudflare:workers"`
// plus `wrangler secret put`, not .env / import.meta.env.
