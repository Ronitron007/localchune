// src/pages/api/build-info.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { BUILD_SHA, BUILD_TIME, sourceUrl } from '../../lib/build-info'

/**
 * The footer link is what discharges AGPL §13; this exists so a deploy can
 * be checked against a commit without a browser — `curl .../api/build-info`
 * after `npm run deploy` answers "is what I just pushed what is running?".
 *
 * Public on purpose: a source offer that requires an account is not much of
 * an offer. See PUBLIC_PATHS in src/middleware.ts.
 */
export const GET: APIRoute = async () =>
  Response.json(
    { sha: BUILD_SHA, builtAt: BUILD_TIME, source: sourceUrl() },
    { headers: { 'cache-control': 'public, max-age=60' } },
  )
