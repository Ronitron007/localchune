// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
export const POST: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete('sb-access-token', { path: '/' })
  cookies.delete('sb-refresh-token', { path: '/' })
  return redirect('/login')
}
