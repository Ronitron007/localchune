// src/pages/api/upload/complete.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import {
  dbErrorResponse, jsonError, loadOwnedJob, parseCompleteBody, readJsonBody, rpcError,
} from '../../../lib/upload-api'
import {
  R2Error, completeMultipartUpload, headObject, listParts, r2ErrorResponse,
} from '../../../lib/r2'

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')

  const parsed = parseCompleteBody(await readJsonBody(request))
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.error)
  const { fileId, parts: claimed } = parsed.value

  const jobResult = await loadOwnedJob(locals.supabase, fileId, locals.member.user_id)
  if (!jobResult.ok) return dbErrorResponse(jobResult.error)
  const job = jobResult.value
  if (!job) return jsonError(404, 'not_found', 'no ingest job for that file')
  if (job.state === 'received') {
    return Response.json({ file_id: fileId, state: 'received', byte_size: job.byteSize, already: true })
  }
  if (job.state !== 'uploading' && job.state !== 'pending') {
    return jsonError(409, 'not_completable', `the file is ${job.state}`)
  }

  try {
    if (job.multipart) {
      if (!job.uploadId) return jsonError(409, 'no_upload_id', 'that multipart upload was never started')

      // R2 is the authority on what actually landed. The client's ETag list
      // is used only when it is complete; otherwise (resume, tab reload,
      // missing ExposeHeaders) ListParts recovers the real one.
      let parts = claimed
      if (!parts || parts.length !== job.partCount) {
        parts = (await listParts(job.r2Key, job.uploadId))
          .map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      }
      if (parts.length !== job.partCount) {
        return jsonError(409, 'incomplete', `R2 holds ${parts.length} of ${job.partCount} parts`)
      }

      try {
        await completeMultipartUpload(job.r2Key, job.uploadId, parts)
      } catch (e) {
        // A retried complete after a successful one gets NoSuchUpload — the
        // upload id is gone precisely BECAUSE it completed. Fall through to
        // the HEAD, which is the real proof either way.
        if (!(e instanceof R2Error) || e.code !== 'NoSuchUpload') throw e
      }
    }

    // THE verification. The client's claim about what it uploaded is never
    // used; this is R2 answering how big the object at that key really is.
    const head = await headObject(job.r2Key)

    if (!head) {
      // Result checked so a failed bookkeeping RPC doesn't leave the row
      // silently stuck in 'uploading' until the 24h sweeper — see Task 5
      // review. The response to the client is unchanged either way: the
      // completion already failed, and a secondary logging failure here
      // must not change which error the caller sees.
      const { error: failErr } = await locals.supabase.rpc('ingest_fail', {
        p_file_id: fileId, p_reason: 'complete: no object at the key after upload',
      })
      if (failErr) console.error('complete: ingest_fail failed after object_missing:', failErr.message)
      return jsonError(409, 'object_missing', 'nothing was uploaded to that key')
    }

    if (head.size !== job.byteSize) {
      // Any difference is a client bug or an attempt to declare a small file
      // and complete a large one. Same answer to both. The object is left
      // where it is — Task 8's nightly reconcile deletes orphans; no request
      // handler in this milestone deletes anything.
      const { error: failErr } = await locals.supabase.rpc('ingest_fail', {
        p_file_id: fileId,
        p_reason: `complete: size mismatch — declared ${job.byteSize}, object ${head.size}`,
      })
      if (failErr) console.error('complete: ingest_fail failed after size_mismatch:', failErr.message)
      return jsonError(
        409, 'size_mismatch',
        `the object is ${head.size} bytes but ${job.byteSize} were declared; retry with a new file id`,
      )
    }

    const { data, error } = await locals.supabase.rpc('ingest_finalize', {
      p_file_id: fileId, p_verified_byte_size: head.size,
    })
    if (error) return rpcError(error)

    return Response.json({ file_id: fileId, state: data, byte_size: head.size })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
