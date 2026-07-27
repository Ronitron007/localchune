// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createBrowserClient } from '@supabase/ssr'

// PKCE's code_verifier and the resulting session must live somewhere both
// this browser client and the server client (src/lib/supabase.server.ts)
// can read. @supabase/ssr stores both in cookies instead of localStorage
// for exactly this reason — see src/pages/auth/callback.ts, which performs
// the code exchange server-side and would otherwise never find the verifier.
export function browserClient() {
  return createBrowserClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY, {
    // secure:true breaks cookies on http://localhost in some browsers.
    cookieOptions: { secure: import.meta.env.PROD },
  })
}
