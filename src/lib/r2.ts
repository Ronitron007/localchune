// src/lib/r2.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { AwsClient } from 'aws4fetch'
import { env } from 'cloudflare:workers'
import {
  buildCompleteMultipartUpload, parseListParts, parseS3Error, parseUploadId,
  type UploadedPart,
} from './s3-xml'

/**
 * SigV4 against R2's S3 endpoint. SERVER ONLY — importing this from a
 * component or any browser file puts `cloudflare:workers` in a client
 * bundle and the build fails.
 *
 * The Worker signs URLs and calls the S3 control plane. It NEVER proxies
 * file bytes: the only bodies here are a few KB of XML.
 */

/**
 * How long a presigned URL lives.
 *
 * R2 allows up to 7 days; one hour is a policy choice. A signed URL is a
 * bearer write capability to one exact key, so a short life bounds the
 * damage from one reaching a log or a screen share. It is still far longer
 * than the worst realistic transfer: at most 100 URLs per /parts call, a
 * 34-part maximum file, on the order of 25-30 minutes at Task 7's
 * PART_CONCURRENCY = 3 on a 1 Mbps link.
 */
export const PRESIGN_TTL_SECONDS = 3600

/**
 * Keys are minted by ingest_begin() as `audio/<uid>/<file_id>.<container>`
 * and read back out of Postgres — the client never sends one. This refuses
 * to sign anything of another shape, so a future caller that forgets where
 * keys come from fails loudly instead of signing a traversal.
 */
const KEY_RE = /^audio\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/

export class R2Error extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'R2Error'
  }
}

type R2Env = {
  R2_ACCOUNT_ID?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_BUCKET?: string
}

/** Read inside a request, never at module scope: `env` is a live proxy. */
function conf() {
  const e = env as unknown as R2Env
  if (!e.R2_ACCOUNT_ID || !e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY || !e.R2_BUCKET) {
    throw new R2Error(
      'R2 is not configured — need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET',
      500, 'R2NotConfigured',
    )
  }
  return {
    accountId: e.R2_ACCOUNT_ID,
    accessKeyId: e.R2_ACCESS_KEY_ID,
    secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    bucket: e.R2_BUCKET,
  }
}

// AwsClient caches its derived signing key per instance, and /api/upload/parts
// signs up to 100 URLs in one request. Rebuilding the client per call would
// redo the four-step key derivation every time.
let cached: { keyId: string; client: AwsClient } | null = null

function signer(accessKeyId: string, secretAccessKey: string): AwsClient {
  if (!cached || cached.keyId !== accessKeyId) {
    cached = {
      keyId: accessKeyId,
      client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    }
  }
  return cached.client
}

export function objectUrl(key: string): string {
  if (!KEY_RE.test(key)) {
    throw new R2Error(`refusing to sign an implausible object key: ${key}`, 500, 'BadKey')
  }
  const { accountId, bucket } = conf()
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`
}

export function presignExpiresAt(ttlSeconds: number = PRESIGN_TTL_SECONDS): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString()
}

/**
 * A presigned PUT. With `partNumber`/`uploadId` it is a multipart part;
 * without them it is the whole object.
 *
 * `content-type` is intentionally not signed — aws4fetch treats it as
 * unsignable unless `allHeaders` is set, and we never set it. R2 still
 * stores whatever Content-Type the browser sends.
 */
export async function presignPut(
  key: string,
  opts: { partNumber?: number; uploadId?: string; ttlSeconds?: number } = {},
): Promise<string> {
  const { accessKeyId, secretAccessKey } = conf()
  const url = new URL(objectUrl(key))
  url.searchParams.set('X-Amz-Expires', String(opts.ttlSeconds ?? PRESIGN_TTL_SECONDS))
  if (opts.partNumber !== undefined) {
    if (!opts.uploadId) throw new R2Error('a part presign needs an uploadId', 500, 'BadRequest')
    url.searchParams.set('partNumber', String(opts.partNumber))
    url.searchParams.set('uploadId', opts.uploadId)
  }
  const signed = await signer(accessKeyId, secretAccessKey)
    .sign(url.toString(), { method: 'PUT', aws: { signQuery: true } })
  return signed.url
}

async function signedFetch(url: string, init: RequestInit): Promise<Response> {
  const { accessKeyId, secretAccessKey } = conf()
  return signer(accessKeyId, secretAccessKey).fetch(url, init)
}

/**
 * Run on EVERY control-plane response, whatever the status.
 * CompleteMultipartUpload can answer HTTP 200 with an <Error> body.
 */
function throwIfS3Error(status: number, xml: string, op: string): void {
  const err = parseS3Error(xml)
  if (err) {
    throw new R2Error(`${op}: ${err.code} — ${err.message}`, status === 200 ? 502 : status, err.code)
  }
  if (status < 200 || status >= 300) {
    throw new R2Error(`${op}: HTTP ${status}`, status, 'HttpError')
  }
}

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const res = await signedFetch(`${objectUrl(key)}?uploads=`, {
    method: 'POST',
    headers: { 'content-type': contentType },
  })
  const xml = await res.text()
  throwIfS3Error(res.status, xml, 'CreateMultipartUpload')
  return parseUploadId(xml)
}

export async function completeMultipartUpload(
  key: string, uploadId: string, parts: { partNumber: number; etag: string }[],
): Promise<void> {
  const body = buildCompleteMultipartUpload(parts)
  const url = new URL(objectUrl(key))
  url.searchParams.set('uploadId', uploadId)
  const res = await signedFetch(url.toString(), {
    method: 'POST', body, headers: { 'content-type': 'application/xml' },
  })
  throwIfS3Error(res.status, await res.text(), 'CompleteMultipartUpload')
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  const url = new URL(objectUrl(key))
  url.searchParams.set('uploadId', uploadId)
  const res = await signedFetch(url.toString(), { method: 'DELETE' })
  // 204 carries no body; only read one when there might be an error in it.
  throwIfS3Error(res.status, res.status === 204 ? '' : await res.text(), 'AbortMultipartUpload')
}

/**
 * Every part R2 currently holds for this upload. Pages properly: ListParts
 * returns at most 1000 per call, and silently dropping parts would present
 * as a completion failure after every byte was already uploaded.
 */
export async function listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
  const out: UploadedPart[] = []
  let marker: number | null = null
  for (let page = 0; page < 20; page++) {
    const url = new URL(objectUrl(key))
    url.searchParams.set('uploadId', uploadId)
    url.searchParams.set('max-parts', '1000')
    if (marker !== null) url.searchParams.set('part-number-marker', String(marker))
    const res = await signedFetch(url.toString(), { method: 'GET' })
    const xml = await res.text()
    throwIfS3Error(res.status, xml, 'ListParts')
    const pageResult = parseListParts(xml)
    out.push(...pageResult.parts)
    if (!pageResult.isTruncated || pageResult.nextPartNumberMarker === null) break
    marker = pageResult.nextPartNumberMarker
  }
  return out
}

/**
 * The truth about what is in the bucket. Returns null when nothing is there.
 *
 * Fails closed on a missing content-length rather than guessing: the only
 * caller uses this number to decide whether to write state = 'received'.
 */
export async function headObject(key: string): Promise<{ size: number; etag: string } | null> {
  const res = await signedFetch(objectUrl(key), { method: 'HEAD' })
  if (res.status === 404) return null
  if (res.status < 200 || res.status >= 300) {
    throw new R2Error(`HeadObject: HTTP ${res.status}`, res.status, 'HttpError')
  }
  const len = res.headers.get('content-length')
  if (len === null || !/^\d+$/.test(len)) {
    throw new R2Error(
      'HeadObject returned no usable content-length; refusing to finalize an unverified size',
      502, 'NoContentLength',
    )
  }
  return { size: Number(len), etag: (res.headers.get('etag') ?? '').replace(/"/g, '') }
}

/**
 * Called from /api/upload/complete (size_mismatch, object_missing) and
 * /api/upload/abort — both reclaim a key whose row is about to become
 * `failed`. Task 8's maintenance Worker deletes orphans through its own R2
 * binding (`env.AUDIO.delete()`) instead of this function; that is a
 * different Worker with no access to this one's SigV4 credentials.
 *
 * S3 DeleteObject is idempotent — deleting a key that is not there returns
 * 204, not 404 — so callers never need to special-case "already gone".
 */
export async function deleteObject(key: string): Promise<void> {
  const res = await signedFetch(objectUrl(key), { method: 'DELETE' })
  throwIfS3Error(res.status, res.status === 204 ? '' : await res.text(), 'DeleteObject')
}

/**
 * `deleteObject`, but a failure is logged and swallowed rather than thrown.
 *
 * Every caller of this function is already on a failure path: the ingest row
 * is about to move to `failed`, and the HTTP response describing that has
 * already been decided. A DeleteObject that itself fails (R2 hiccup, expired
 * credentials) must never change what the client sees — the object becomes
 * tonight's `pendingDeletion` in the reconcile report instead, which is
 * exactly the belt-and-braces path Critical #1 describes.
 */
export async function deleteObjectQuietly(key: string): Promise<void> {
  try {
    await deleteObject(key)
  } catch (e) {
    console.error(`deleteObjectQuietly: ${key}:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * 502 with the S3 error CODE only. The message can name the bucket and the
 * key, neither of which the browser needs; the full text goes to the Worker
 * log, where `observability` in wrangler.jsonc keeps it.
 */
export function r2ErrorResponse(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e)
  console.error('r2:', message)
  const code = e instanceof R2Error ? e.code : 'UpstreamFailure'
  return Response.json({ error: 'r2_error', message: code }, { status: 502 })
}
