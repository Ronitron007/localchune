// src/pages/api/track/[id]/play.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'

/**
 * Bumps one play_events row for the caller on this track — migration 26's
 * `bump_play` RPC does the actual insert and the pool-visibility gate
 * (42501/P0002, mapped through the shared `rpcError` table). Same skeleton
 * as `like.ts`: member gate, uuid guard, try/catch around the RPC.
 *
 * JS-only, fire-and-forget: unlike `like.ts` there is no `<form>` fallback
 * and no caller-visible result to return, so this always answers `204 No
 * Content` on success — nothing for `site.ts`'s `onQualify` to parse, which
 * is the point, since a lost play count must never surface in the UI.
 */
export const POST: APIRoute = async ({ params, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  try {
    const { error } = await locals.supabase.rpc('bump_play', { p_file: id })
    if (error) return rpcError(error)
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  return new Response(null, { status: 204 })
}
