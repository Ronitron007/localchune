// src/pages/api/track/[id]/source.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { presignGet, r2ErrorResponse } from '../../../../lib/r2'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'
import { POOL_VISIBLE_STATES } from '../../../../lib/file-state'

/** One narrowing for every string column read off pool_get's mixed row.
 *  An empty string is folded to null on purpose: every caller below treats
 *  `''` as absent anyway, and `if (!r2Key)` already did. */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null

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
 *
 * IT ALSO ANSWERS THE LIKE QUESTION, and that is the whole reason the
 * player bar can carry a ♥ at no cost. `pool_get` (migration 28) already
 * returns `like_count`, `liked_by_me`, `display_title` and `display_artist`
 * on the row this route loads to find `r2_key` — every one of them is
 * already in memory by the time the presign runs. Returning four more
 * fields is free; a dedicated `/api/track/:id/likes` would have been a
 * second round trip per track start, on the one path that is already on the
 * critical path to audio.
 *
 * No new RPC and no migration: this change is TypeScript only. The
 * authority on a like is still `toggle_like` (migration 26) through
 * `/api/track/:id/like` — this route only reports what pool_get saw.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  // `unknown` rather than `string | null`: pool_get's row is mixed (int,
  // boolean, jsonb, timestamptz), and the old annotation was only ever true
  // of the four string columns this route happened to read. Now that
  // `like_count` (int) and `liked_by_me` (boolean) are read too, the lie
  // would be load-bearing — so every field is narrowed at its own use.
  let track: Record<string, unknown> | undefined
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
  // index-signature property access, so `track.r2_key` stays `unknown`
  // however many times it is checked.
  const r2Key = str(track.r2_key)
  if (!r2Key) return jsonError(404, 'not_found', 'no such track')

  // See download.ts / POOL_VISIBLE_STATES: a failed/abandoned/quarantined/
  // rejected file's own uploader can reach this route (Task 16b), but its
  // object may never have finished or may already be deleted. Refuse
  // before presigning rather than handing back a URL that 404s in the
  // <audio> element.
  const state = str(track.state)
  if (!state || !POOL_VISIBLE_STATES.has(state)) {
    return jsonError(409, 'not_available', `this file is ${state ?? 'not available'}`)
  }

  const preview = str(track.preview_key)
  const key = preview ? `derived/${id}/${preview}` : r2Key
  const ext = (preview ?? r2Key).split('.').pop()?.toLowerCase() ?? ''

  try {
    const url = await presignGet(key, { contentType: MIME[ext] ?? 'application/octet-stream' })
    return Response.json({
      url,
      kind: preview ? 'preview' : 'original',
      mime: MIME[ext] ?? 'application/octet-stream',
      // The four free fields. `liked` is a strict `=== true` rather than a
      // truthiness test: a missing column must read as "not liked", never as
      // "undefined, so probably fine" — the player bar paints a ♥ from this.
      liked: track.liked_by_me === true,
      like_count: typeof track.like_count === 'number' ? track.like_count : 0,
      // The bar's own copy of the name. It matters most on the resume path,
      // where the alternative is a title cached in localStorage up to 14 days
      // ago — which is what a retagged or re-analysed file makes stale.
      title: str(track.display_title) ?? '',
      artist: str(track.display_artist),
    }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
