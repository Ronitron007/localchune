// src/pages/api/track/[id]/source.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { presignGet, r2ErrorResponse } from '../../../../lib/r2'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', wave: 'audio/wav',
  aiff: 'audio/aiff', aif: 'audio/aiff', aifc: 'audio/aiff',
  m4a: 'audio/mp4', mp4: 'audio/mp4',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
}

/**
 * Where to stream a track from. Returns a URL; the browser fetches R2
 * directly. Never proxy the bytes through here — R2's edge already answers
 * Range requests, which is what makes seeking free, and a Worker in the
 * path would turn $0 of egress into a bill and a 128 MB memory ceiling.
 *
 * Preview first: analysis emits a 128 kbps Opus preview (~5.5 MB for six
 * minutes) precisely because FLAC, WAV and AIFF are not broadly streamable
 * in a browser. When there is no preview — an mp3, or an M3 run that
 * predates the artifact-key columns — the original is served instead.
 */
export const GET: APIRoute = async ({ params, locals }) => {
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
  // 404 covers both "no such file" and "not yours to see" — pool_get applies
  // the visibility rule, so an invisible track is indistinguishable from an
  // absent one, which is the point.
  if (!track) return jsonError(404, 'not_found', 'no such track')

  // Copied into a const before the guard: TypeScript does not narrow an
  // index-signature property access, so `track.r2_key` stays `string | null`
  // however many times it is checked.
  const r2Key = track.r2_key
  if (!r2Key) return jsonError(404, 'not_found', 'no such track')

  const preview = track.preview_key
  const key = preview ? `derived/${id}/${preview}` : r2Key
  const ext = (preview ?? r2Key).split('.').pop()?.toLowerCase() ?? ''

  try {
    const url = await presignGet(key, { contentType: MIME[ext] ?? 'application/octet-stream' })
    return Response.json({
      url,
      kind: preview ? 'preview' : 'original',
      mime: MIME[ext] ?? 'application/octet-stream',
    }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
