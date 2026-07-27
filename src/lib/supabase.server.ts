// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createServerClient, parseCookieHeader, type CookieOptionsWithName } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AstroCookies } from 'astro'

// secure:true breaks cookies on http://localhost in some browsers. Must
// match the cookieOptions in src/lib/supabase.ts — both clients read and
// write the same cookie names.
const cookieOptions: CookieOptionsWithName = { secure: import.meta.env.PROD }

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
 */
export function serverClient(cookies: AstroCookies, request: Request): SupabaseClient {
  return createServerClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions,
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('cookie') ?? ''),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          cookies.set(name, value, options)
        }
      },
    },
  })
}

// serviceClient() was removed. import.meta.env.SUPABASE_SERVICE_KEY is
// undefined in both dev and prod builds — Vite's envPrefix only exposes
// PUBLIC_-prefixed vars to the bundle — so any call would have thrown
// "supabaseKey is required." It also had zero callers: Task 6's admin path
// uses the caller's own token against security-definer RPCs (admin_invite /
// admin_revoke) which re-check is_owner() in the database, so the service
// key is not needed by the app at all. SUPABASE_SERVICE_KEY stays in .env
// for CLI tooling. If a future task genuinely needs it in the Worker, the
// correct mechanism on this adapter is `import { env } from
// "cloudflare:workers"` plus `wrangler secret put`, not `import.meta.env`.
