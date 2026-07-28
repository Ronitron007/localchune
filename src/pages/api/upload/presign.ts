// src/pages/api/upload/presign.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { contentTypeFor, preflight, preflightMessage } from '../../../lib/upload-policy'
import {
  dbErrorResponse, jsonError, loadOwnedJob, parsePresignBody, readJsonBody, rpcError,
} from '../../../lib/upload-api'
import {
  createMultipartUpload, presignExpiresAt, presignPut, r2ErrorResponse,
} from '../../../lib/r2'

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parsePresignBody(await readJsonBody(request))
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)
  const { batchId, fileId, filename, byteSize, clientDurationMs } = parsed.value

  // The browser ran this before it offered the file. Running it again here
  // is the control; the browser's answer only saves bandwidth.
  const verdict = preflight(filename, byteSize, clientDurationMs)
  if (!verdict.ok) return jsonError(422, verdict.reason, preflightMessage(verdict))

  const { data, error } = await locals.supabase.rpc('ingest_begin', {
    p_batch_id: batchId,
    p_file_id: fileId,
    p_filename: filename,
    p_container: verdict.container,
    p_byte_size: byteSize,
    p_client_duration_ms: clientDurationMs,
    p_multipart: verdict.plan.multipart,
    p_part_size: verdict.plan.partSize,
    p_part_count: verdict.plan.partCount,
  })
  if (error) return rpcError(error)

  const row = (Array.isArray(data) ? data[0] : data) as
    { r2_key: string; state: string; resumable: boolean } | undefined
  if (!row) return jsonError(500, 'rpc_error', 'ingest_begin returned no row')

  // Not resumable means received / failed / abandoned. Sign NOTHING: a PUT
  // URL for a received file is a capability to replace an object the
  // analysis worker may already have read.
  if (!row.resumable) {
    return Response.json({
      file_id: fileId, state: row.state, resumable: false, done: row.state === 'received',
    })
  }

  const contentType = contentTypeFor(verdict.container)

  // The row exists by now — ingest_begin just inserted it, or this is a
  // replay that found one already there. Load it to get the STORED plan.
  // ingest_begin never updates multipart/part_size/part_count on a replay
  // (see the migration), so `verdict.plan` — recomputed from THIS request's
  // byte_size — must never drive the multipart-vs-single branch or the part
  // numbers below: a replay with a changed byte_size would otherwise wedge
  // the file (small→large hands out a whole-object PUT while /parts still
  // expects multipart; large→small does the opposite and /complete 409s
  // forever). The stored plan is authoritative, never recomputed — this is
  // also the fix for a thrown DB error surfacing here as a bodyless 500
  // instead of a JSON 503: loadOwnedJob no longer throws.
  const jobResult = await loadOwnedJob(locals.supabase, fileId, locals.member.user_id)
  if (!jobResult.ok) return dbErrorResponse(jobResult.error)
  const job = jobResult.value
  if (!job) return jsonError(404, 'not_found', 'no ingest job for that file')

  try {
    if (!job.multipart) {
      const url = await presignPut(row.r2_key)
      const { error: markErr } = await locals.supabase.rpc('ingest_mark_uploading', {
        p_file_id: fileId, p_upload_id: null,
      })
      if (markErr) return rpcError(markErr)
      return Response.json({
        file_id: fileId, state: 'uploading', multipart: false, resumable: true,
        content_type: contentType, url, expires_at: presignExpiresAt(),
      })
    }

    // Reuse the stored UploadId on a replay. Creating a second one orphans
    // the first, and ingest_jobs only remembers the one the sweeper aborts.
    const uploadId = job.uploadId ?? await createMultipartUpload(row.r2_key, contentType)

    const { error: markErr } = await locals.supabase.rpc('ingest_mark_uploading', {
      p_file_id: fileId, p_upload_id: uploadId,
    })
    if (markErr) return rpcError(markErr)

    return Response.json({
      file_id: fileId, state: 'uploading', multipart: true, resumable: true,
      upload_id: uploadId, part_size: job.partSize as number,
      part_count: job.partCount as number, content_type: contentType,
    })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
