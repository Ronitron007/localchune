// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { serverClient } from '../../lib/supabase.server'

export const POST: APIRoute = async ({ cookies, redirect, request }) => {
  // signOut() clears whatever cookies this client owns via its setAll
  // adapter, rather than us guessing hardcoded cookie names to delete.
  const sb = serverClient(cookies, request)
  await sb.auth.signOut()
  return redirect('/login')
}
