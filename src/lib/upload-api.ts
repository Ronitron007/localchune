// src/lib/upload-api.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Request parsing, error mapping and the ownership lookup shared by the six
 * /api/upload routes.
 *
 * This module exists separately from the routes because every route imports
 * src/lib/r2.ts, which imports `cloudflare:workers` — a workerd built-in
 * Vitest cannot resolve. A validator inside a route file is therefore
 * permanently untestable. Nothing here may import r2.ts.
 */

/** One /api/upload/parts call mints at most this many signed URLs. */
export const MAX_PART_URLS_PER_CALL = 100

/** ingest_jobs.last_error keeps left(reason, 500). */
export const MAX_REASON_LENGTH = 500

const MAX_FILENAME_LENGTH = 512
const MAX_LABEL_LENGTH = 120

// Deliberately lax about the version/variant nibbles: Postgres is the
// authority on what a uuid is, and this only has to stop path-shaped junk
// reaching an RPC argument.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const bad = (error: string): Parsed<never> => ({ ok: false, error })

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/** Never throws. A malformed body is an empty object and fails validation. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await request.json()
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status })
}

/**
 * PostgREST surfaces the Postgres SQLSTATE in error.code, so the Task 3
 * `raise ... using errcode = ...` values map straight onto HTTP here.
 * Anything unmapped is a server fault, not the caller's.
 */
const RPC_STATUS: Record<string, [number, string]> = {
  '42501': [403, 'forbidden'],
  '22023': [422, 'invalid'],
  P0001: [409, 'illegal_transition'],
  P0002: [404, 'not_found'],
}

export function rpcError(error: { code?: string; message: string }): Response {
  const [status, code] = RPC_STATUS[error.code ?? ''] ?? [500, 'rpc_error']
  return jsonError(status, code, error.message)
}

/**
 * A thrown/rejected PostgREST call (transient 5xx, failed JWT refresh, an
 * in-Worker `fetch failed`) must still produce a JSON body — never the
 * bodyless 500 an uncaught throw yields in production workerd. 503, not
 * 500: the failure is the database being unreachable right now, and the
 * client's next attempt may simply work.
 */
export function dbErrorResponse(message: string): Response {
  console.error('db:', message)
  return jsonError(503, 'db_error', 'try again')
}

// ---------------------------------------------------------------- parsers

export function parseBatchBody(b: Record<string, unknown>): Parsed<{ label: string | null }> {
  const raw = b.label
  if (raw === undefined || raw === null) return { ok: true, value: { label: null } }
  if (typeof raw !== 'string') return bad('label must be a string')
  if (raw.length > MAX_LABEL_LENGTH) return bad(`label must be at most ${MAX_LABEL_LENGTH} characters`)
  const label = raw.trim()
  return { ok: true, value: { label: label === '' ? null : label } }
}

export type PresignRequest = {
  batchId: string
  fileId: string
  filename: string
  byteSize: number
  clientDurationMs: number | null
}

export function parsePresignBody(b: Record<string, unknown>): Parsed<PresignRequest> {
  if (!isUuid(b.batch_id)) return bad('batch_id must be a uuid')
  if (!isUuid(b.file_id)) return bad('file_id must be a uuid')
  if (typeof b.filename !== 'string' || b.filename.trim() === '') return bad('filename is required')
  if (b.filename.length > MAX_FILENAME_LENGTH) return bad('filename is too long')
  if (!isPositiveInt(b.byte_size)) return bad('byte_size must be a positive integer')

  const d = b.client_duration_ms
  if (d !== null && d !== undefined && !(typeof d === 'number' && Number.isSafeInteger(d) && d >= 0)) {
    return bad('client_duration_ms must be a non-negative integer or null')
  }
  return {
    ok: true,
    value: {
      batchId: b.batch_id,
      fileId: b.file_id,
      filename: b.filename,
      byteSize: b.byte_size,
      clientDurationMs: d === undefined ? null : (d as number | null),
    },
  }
}

export type PartsRequest = { fileId: string; from: number; to: number }

export function parsePartsBody(b: Record<string, unknown>): Parsed<PartsRequest> {
  if (!isUuid(b.file_id)) return bad('file_id must be a uuid')
  if (!isPositiveInt(b.from) || !isPositiveInt(b.to)) return bad('from and to must be positive integers')
  if (b.to < b.from) return bad('to must not be less than from')
  if (b.to > 10_000) return bad('part numbers stop at 10000')
  if (b.to - b.from + 1 > MAX_PART_URLS_PER_CALL) {
    return bad(`at most ${MAX_PART_URLS_PER_CALL} parts per call`)
  }
  return { ok: true, value: { fileId: b.file_id, from: b.from, to: b.to } }
}

export type CompleteRequest = {
  fileId: string
  parts: { partNumber: number; etag: string }[] | null
}

export function parseCompleteBody(b: Record<string, unknown>): Parsed<CompleteRequest> {
  if (!isUuid(b.file_id)) return bad('file_id must be a uuid')
  if (b.parts === undefined || b.parts === null) {
    return { ok: true, value: { fileId: b.file_id, parts: null } }
  }
  if (!Array.isArray(b.parts)) return bad('parts must be an array')
  if (b.parts.length > 10_000) return bad('too many parts')

  const parts: { partNumber: number; etag: string }[] = []
  for (const raw of b.parts as unknown[]) {
    if (raw === null || typeof raw !== 'object') return bad('each part must be an object')
    const p = raw as Record<string, unknown>
    if (!isPositiveInt(p.part_number) || p.part_number > 10_000) {
      return bad('part_number must be an integer in 1..10000')
    }
    if (typeof p.etag !== 'string' || p.etag === '') return bad('etag is required')
    parts.push({ partNumber: p.part_number, etag: p.etag })
  }
  return { ok: true, value: { fileId: b.file_id, parts } }
}

export type AbortRequest = { fileId: string; reason: string }

export function parseAbortBody(b: Record<string, unknown>): Parsed<AbortRequest> {
  if (!isUuid(b.file_id)) return bad('file_id must be a uuid')
  const raw = typeof b.reason === 'string' && b.reason.trim() !== ''
    ? b.reason.trim()
    : 'aborted by the client'
  return { ok: true, value: { fileId: b.file_id, reason: raw.slice(0, MAX_REASON_LENGTH) } }
}

export function parseFileIdParam(url: URL): Parsed<string> {
  const v = url.searchParams.get('file_id')
  return isUuid(v) ? { ok: true, value: v } : bad('file_id must be a uuid')
}

// ------------------------------------------------------------- ownership

export type OwnedJob = {
  fileId: string
  r2Key: string
  state: string
  container: string | null
  byteSize: number
  multipart: boolean
  partSize: number | null
  partCount: number | null
  uploadId: string | null
}

/**
 * The ONLY way a route learns an object key. Both filters are load-bearing.
 *
 * Task 2's read policies are `user_id = auth.uid() OR is_owner()` on
 * ingest_jobs and `pool_visible OR uploaded_by = auth.uid() OR is_owner()`
 * on files. RLS alone would therefore let the owner — and, for files, any
 * member — read a key belonging to somebody else, and this route would then
 * sign a PUT for it. `.eq('user_id')` and `.eq('uploaded_by')` close that.
 *
 * Task 3's RPCs re-check `uploaded_by = auth.uid()` independently. The
 * redundancy is deliberate: only this layer can mint a write capability
 * that the database cannot revoke.
 *
 * Returns `Parsed<OwnedJob | null>`, never throws: a PostgREST error
 * (transient 5xx, failed JWT refresh, `fetch failed`) comes back as
 * `{ ok: false, error }` instead of an exception. A route that let this
 * throw would have the call land outside its try/catch — an uncaught throw
 * in production workerd is a bodyless 500 with no content-type at all,
 * which is indistinguishable from a dropped connection to Task 7's client
 * and aborts the whole batch. Every caller must check `.ok` and, on
 * failure, return `dbErrorResponse(result.error)` — a real JSON 503.
 */
export async function loadOwnedJob(
  supabase: SupabaseClient, fileId: string, userId: string,
): Promise<Parsed<OwnedJob | null>> {
  const { data: job, error: jobErr } = await supabase
    .from('ingest_jobs')
    .select('file_id, multipart, part_size, part_count, upload_id')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .maybeSingle()
  if (jobErr) return bad(`ingest_jobs: ${jobErr.message}`)
  if (!job) return { ok: true, value: null }

  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('id, r2_key, state, container, byte_size')
    .eq('id', fileId)
    .eq('uploaded_by', userId)
    .maybeSingle()
  if (fileErr) return bad(`files: ${fileErr.message}`)
  if (!file) return { ok: true, value: null }

  return {
    ok: true,
    value: {
      fileId,
      r2Key: file.r2_key as string,
      state: file.state as string,
      container: (file.container as string | null) ?? null,
      byteSize: Number(file.byte_size),
      multipart: Boolean(job.multipart),
      partSize: job.part_size === null ? null : Number(job.part_size),
      partCount: job.part_count === null ? null : Number(job.part_count),
      uploadId: (job.upload_id as string | null) ?? null,
    },
  }
}
