// src/pages/api/upload/parts.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { partRange } from '../../../lib/upload-policy'
import {
  dbErrorResponse, jsonError, loadOwnedJob, parsePartsBody, readJsonBody, rpcError,
} from '../../../lib/upload-api'
import { presignExpiresAt, presignPut, r2ErrorResponse } from '../../../lib/r2'

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parsePartsBody(await readJsonBody(request))
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)
  const { fileId, from, to } = parsed.value

  const jobResult = await loadOwnedJob(locals.supabase, fileId, locals.member.user_id)
  if (!jobResult.ok) return dbErrorResponse(jobResult.error)
  const job = jobResult.value
  if (!job) return jsonError(404, 'not_found', 'no ingest job for that file')
  if (!job.multipart || job.partSize === null || job.partCount === null) {
    return jsonError(409, 'not_multipart', 'that file is a single PUT — use the url from /presign')
  }
  if (!job.uploadId) return jsonError(409, 'no_upload_id', 'call /api/upload/presign first')
  if (job.state !== 'pending' && job.state !== 'uploading') {
    return jsonError(409, 'not_resumable', `the file is ${job.state}`)
  }
  if (to > job.partCount) {
    return jsonError(400, 'bad_request', `this file has ${job.partCount} parts`)
  }

  // p_upload_id MUST be null here: ingest_mark_uploading coalesces, so null
  // keeps the stored UploadId the sweeper needs while still bumping
  // updated_at and holding the row in 'uploading'.
  const { error } = await locals.supabase.rpc('ingest_mark_uploading', {
    p_file_id: fileId, p_upload_id: null,
  })
  if (error) return rpcError(error)

  const numbers: number[] = []
  for (let n = from; n <= to; n++) numbers.push(n)

  // Offsets derive from the STORED part size, never a recomputed one: R2
  // checks "all non-trailing parts are equal length" only at
  // CompleteMultipartUpload, after every byte is already uploaded. A throw
  // here is a client-input problem (a stale or malformed range against this
  // file's stored plan), not an R2 failure — kept out of the try below so
  // it never gets mislabeled as an upstream r2_error/502.
  let ranges: { start: number; end: number }[]
  try {
    ranges = numbers.map((n) => partRange(n, job.partSize as number, job.byteSize))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return jsonError(400, 'bad_part_range', message)
  }

  try {
    const parts = await Promise.all(numbers.map(async (n, i) => ({
      part_number: n,
      start: ranges[i].start,
      end: ranges[i].end,
      url: await presignPut(job.r2Key, { partNumber: n, uploadId: job.uploadId as string }),
    })))

    return Response.json({
      file_id: fileId,
      part_size: job.partSize,
      part_count: job.partCount,
      byte_size: job.byteSize,
      expires_at: presignExpiresAt(),
      parts,
    })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
