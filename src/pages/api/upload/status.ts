// src/pages/api/upload/status.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../lib/upload-api'
import type { FileStatus } from '../../../lib/upload-batch'

/**
 * Deliberately tiny: one RPC, the caller's own rows, no joins the browser
 * has to understand. Polled every five seconds while anything is still
 * moving, so it has to stay cheap.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const batchId = url.searchParams.get('batch_id')
  if (!isUuid(batchId)) return jsonError(400, 'bad_request', 'batch_id must be a uuid')

  try {
    const { data, error } = await locals.supabase.rpc(
      'upload_batch_status', { p_batch_id: batchId })
    if (error) return rpcError(error)
    const files = (data ?? []) as FileStatus[]
    return Response.json(
      { files, allTerminal: files.length > 0 && files.every((f) => f.terminal) },
      { headers: { 'cache-control': 'private, no-store' } },
    )
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
}
