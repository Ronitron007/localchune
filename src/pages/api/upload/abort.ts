// src/pages/api/upload/abort.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import {
  dbErrorResponse, jsonError, loadOwnedJob, parseAbortBody, readJsonBody, rpcError,
} from '../../../lib/upload-api'
import {
  R2Error, abortMultipartUpload, deleteObjectQuietly, r2ErrorResponse,
} from '../../../lib/r2'

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parseAbortBody(await readJsonBody(request))
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)
  const { fileId, reason } = parsed.value

  const jobResult = await loadOwnedJob(locals.supabase, fileId, locals.member.user_id)
  if (!jobResult.ok) return dbErrorResponse(jobResult.error)
  const job = jobResult.value
  if (!job) return jsonError(404, 'not_found', 'no ingest job for that file')

  // A single PUT has nothing to ABORT — S3 PUT is atomic, so there is never
  // a partial object mid-flight. Only a multipart upload bills for parts.
  if (job.uploadId) {
    try {
      await abortMultipartUpload(job.r2Key, job.uploadId)
    } catch (e) {
      // Already gone is the desired end state, not an error.
      if (!(e instanceof R2Error) || e.code !== 'NoSuchUpload') return r2ErrorResponse(e)
    }
  }

  // Unconditional and separate from the multipart abort above: a single PUT
  // that already landed leaves a complete object behind, and multipart's own
  // abort only tears down the upload session, never a since-completed
  // object. The row is seconds from becoming `failed`, after which nothing
  // else in this milestone ever revisits this key (Critical #1) — reclaim it
  // here. DeleteObject on a key that was never written is a harmless no-op,
  // so this runs whether or not job.uploadId was set above. A delete failure
  // must not change the response the client sees: log it and carry on.
  await deleteObjectQuietly(job.r2Key)

  const { data, error } = await locals.supabase.rpc('ingest_fail', {
    p_file_id: fileId, p_reason: reason,
  })
  if (error) return rpcError(error)
  return Response.json({ file_id: fileId, state: data })
}
