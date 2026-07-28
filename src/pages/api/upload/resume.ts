// src/pages/api/upload/resume.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { jsonError, loadOwnedJob, parseFileIdParam } from '../../../lib/upload-api'
import { R2Error, listParts, r2ErrorResponse } from '../../../lib/r2'

/**
 * GET on purpose: it changes nothing, and a safe method is exempt from
 * Astro's built-in CSRF origin check, so a reload or a cross-device resume
 * needs no special handling.
 *
 * Part ETags are never persisted by us — ListParts recovers them from R2 on
 * demand, which is exactly what makes cross-device resume free.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parseFileIdParam(url)
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)
  const fileId = parsed.value

  const job = await loadOwnedJob(locals.supabase, fileId, locals.member.user_id)
  if (!job) return jsonError(404, 'not_found', 'no ingest job for that file')

  const base = {
    file_id: fileId,
    state: job.state,
    multipart: job.multipart,
    part_size: job.partSize,
    part_count: job.partCount,
    byte_size: job.byteSize,
  }

  if (!job.multipart || !job.uploadId) {
    return Response.json({ ...base, upload_id: null, uploaded_parts: [] })
  }

  try {
    const parts = await listParts(job.r2Key, job.uploadId)
    return Response.json({
      ...base,
      upload_id: job.uploadId,
      uploaded_parts: parts.map((p) => ({ part_number: p.partNumber, etag: p.etag, size: p.size })),
    })
  } catch (e) {
    if (e instanceof R2Error && e.code === 'NoSuchUpload') {
      // Swept by the maintenance Worker or by the 1-day lifecycle rule.
      // Task 7 restarts this file under a NEW file_id.
      return Response.json({ ...base, upload_id: null, expired: true, uploaded_parts: [] })
    }
    return r2ErrorResponse(e)
  }
}
