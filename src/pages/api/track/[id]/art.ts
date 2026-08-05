// src/pages/api/track/[id]/art.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { GET_TTL_SECONDS, presignGet, r2ErrorResponse } from '../../../../lib/r2'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'

/**
 * Album art, as a redirect the <img> tag can follow — a 302 keeps the
 * Worker out of the byte path, same rule as audio (PRD §12).
 *
 * Default is the 64px thumb and ONLY the thumb: rows must never load
 * full-size art, so a row whose file predates the thumb task gets a 404
 * (the template already rendered an empty box instead of an <img> when
 * has_thumb was false — this is defence, not the primary path).
 * `?full=1` is the detail page: full art, falling back to the thumb.
 *
 * The R2 response carries an immutable year-long cache-control (art for a
 * given file_id never changes). The 302 itself is cacheable for HALF the
 * signature TTL, so a cached redirect can never hand out a URL that is
 * about to expire.
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  let track: Record<string, string | null> | undefined
  try {
    const { data, error } = await locals.supabase.rpc('pool_get', { p_file_id: id })
    if (error) return rpcError(error)
    track = data?.[0]
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
  if (!track) return jsonError(404, 'not_found', 'no such track')

  // Thumbs no longer live here: rows load them straight off the public art
  // bucket (spec 2026-08-01-art-bucket-split). Only the track page's
  // full-size art still needs the signed, session-gated path.
  if (url.searchParams.get('full') !== '1') {
    return jsonError(404, 'no_art', 'thumbs are served from the public art bucket')
  }
  const name = track.artwork_key ?? track.thumb_key
  if (!name) return jsonError(404, 'no_art', 'no artwork for this track')

  try {
    const signed = await presignGet(`derived/${id}/${name}`, {
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
    })
    return new Response(null, {
      status: 302,
      headers: {
        location: signed,
        'cache-control': `private, max-age=${Math.floor(GET_TTL_SECONDS / 2)}`,
      },
    })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
