// src/pages/api/upload/abort.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import {
  jsonError, loadOwnedJob, parseAbortBody, readJsonBody, rpcError,
} from '../../../lib/upload-api'
import { R2Error, abortMultipartUpload, r2ErrorResponse } from '../../../lib/r2'

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parseAbortBody(await readJsonBody(request))
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)
  const { fileId, reason } = parsed.value

  const job = await loadOwnedJob(locals.supabase, fileId, locals.member.user_id)
  if (!job) return jsonError(404, 'not_found', 'no ingest job for that file')

  // A single PUT has nothing to abort — S3 PUT is atomic, so there is never
  // a partial object to clean up. Only a multipart upload bills for parts.
  if (job.uploadId) {
    try {
      await abortMultipartUpload(job.r2Key, job.uploadId)
    } catch (e) {
      // Already gone is the desired end state, not an error.
      if (!(e instanceof R2Error) || e.code !== 'NoSuchUpload') return r2ErrorResponse(e)
    }
  }

  const { data, error } = await locals.supabase.rpc('ingest_fail', {
    p_file_id: fileId, p_reason: reason,
  })
  if (error) return rpcError(error)
  return Response.json({ file_id: fileId, state: data })
}
