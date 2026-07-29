// src/pages/api/track/[id]/download.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { presignGet, r2ErrorResponse } from '../../../../lib/r2'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'

/**
 * Download serves the ORIGINAL, never the preview — the whole point of the
 * pool is that the file a DJ takes away is the file that was uploaded.
 *
 * A 302 rather than JSON, so a plain <a href> works with no JavaScript and
 * the browser's own download manager handles resume and progress.
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
  if (!track) return jsonError(404, 'not_found', 'no such track')
  // See source.ts: an index-signature access does not narrow, so copy first.
  const r2Key = track.r2_key
  if (!r2Key) return jsonError(404, 'not_found', 'no such track')

  const name = track.original_filename ?? 'track'
  // Two forms: a plain ASCII fallback for old clients and RFC 5987 for
  // everything else. The header value is inside the SIGNATURE, so nobody
  // can rewrite the filename by editing the URL.
  const ascii = name.replace(/[^\w.\- ]+/g, '_')
  const disposition =
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`

  try {
    const url = await presignGet(r2Key, { contentDisposition: disposition })

    // Fire-and-forget: count the download, but never let a stats failure
    // block or delay the redirect below. Deliberately NOT awaited — the
    // response ships the instant the signed URL is ready. Both the
    // rejection path (network/transport failure) and the resolution path
    // (an RPC-level error, e.g. bump_download's own P0002) are logged and
    // swallowed here, never surfaced to the caller.
    locals.supabase.rpc('bump_download', { p_file: id }).then(
      ({ error }) => {
        if (error) console.error('bump_download failed:', error.message)
      },
      (e: unknown) => {
        console.error('bump_download failed:', e instanceof Error ? e.message : String(e))
      },
    )

    return new Response(null, {
      status: 302,
      headers: { location: url, 'cache-control': 'private, no-store' },
    })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
