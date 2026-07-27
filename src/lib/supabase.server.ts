// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Client bound to the caller's access token, so RLS applies as that user. */
export function userClient(env: Record<string, string>, accessToken: string): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

/** BYPASSRLS. Server only. Never construct this in code reachable from the browser. */
export function serviceClient(env: Record<string, string>): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
