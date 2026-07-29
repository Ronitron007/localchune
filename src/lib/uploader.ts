// src/lib/uploader.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { partRange, type UploadPlan } from './upload-policy'
import { pump, PART_CONCURRENCY } from './upload-queue'

/** Attempts per PUT, including the first. */
export const MAX_ATTEMPTS = 5
export const BACKOFF_BASE_MS = 500
export const BACKOFF_CAP_MS = 20_000

/** How many part URLs one /api/upload/parts call asks for. Keeps a 10,000
 *  part file from producing a 10,000-entry JSON response. */
export const PART_PRESIGN_CHUNK = 100

export type Disposition = 'ok' | 'retry' | 'represign' | 'restart' | 'fatal'

/**
 * What to do about an HTTP status from R2.
 *
 * `restart` and `fatal` are NOT the same thing to the caller: `fatal` means
 * the file is unacceptable, `restart` means this particular multipart is gone
 * (NoSuchUpload) and a fresh file_id is needed. Both tear the server row down;
 * everything else leaves it resumable.
 */
export function classifyStatus(status: number): Disposition {
  if (status === 200 || status === 201 || status === 204) return 'ok'
  if (status === 0) return 'retry'
  if (status === 403) return 'represign'
  if (status === 404) return 'restart'
  if (status === 408 || status === 429) return 'retry'
  if (status >= 500) return 'retry'
  return 'fatal'
}

/**
 * Full-jitter exponential backoff: random(0, min(cap, base * 2^attempt)).
 *
 * Full jitter rather than equal jitter because a 200-file batch that hits a
 * flaky link produces synchronised retries, and full jitter is the variant
 * that decorrelates them.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))
  return Math.floor(random() * ceiling)
}

/** R2 returns ETag: "hex". The wire format between browser and Worker is the
 *  unquoted hex; s3-xml.ts puts the quotes back for CompleteMultipartUpload. */
export function normaliseEtag(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
  return trimmed.length === 0 ? null : trimmed
}

export class TransferError extends Error {
  readonly status: number
  readonly disposition: Disposition
  constructor(message: string, status: number, disposition: Disposition) {
    super(message)
    this.name = 'TransferError'
    this.status = status
    this.disposition = disposition
  }
}

/** Middleware redirected us to /login. The whole batch is dead until the
 *  user signs in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super('signed out — reload the page and sign in again')
    this.name = 'SessionExpiredError'
  }
}

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Thrown by uploadFile. `rowDiscarded` says whether /api/upload/abort was
 * called, i.e. whether the server row is now `failed` and therefore terminal.
 */
export class UploadFailure extends Error {
  readonly rowDiscarded: boolean
  constructor(message: string, rowDiscarded: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UploadFailure'
    this.rowDiscarded = rowDiscarded
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function describeError(err: unknown): string {
  if (err instanceof TransferError) return `${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Tracks consecutive status-0 PUT failures across ONE file's whole transfer
 * — every attempt, every part, single-PUT or multipart alike.
 *
 * XHR reports a network drop, a DNS failure and a CORS rejection identically
 * as status 0 (see xhrPut below and classifyStatus's own comment), so a
 * single status-0 result never tells them apart. A CORS misconfiguration
 * does not, though: it is bucket-wide, so every PUT to it fails the same
 * way. Two status-0 results in a row is the signal — an ordinary flaky link
 * usually succeeds, times out with a real status, or gets a different error
 * somewhere in between.
 */
export interface ZeroStatusTracker { consecutive: number; hinted: boolean }

export function newZeroStatusTracker(): ZeroStatusTracker {
  return { consecutive: 0, hinted: false }
}

export const CORS_HINT =
  "two uploads in a row failed with no HTTP status at all — that usually means the bucket's " +
  'CORS rule is missing or does not allow this origin, not a dropped connection'

/**
 * Updates `tracker` for one PUT attempt's outcome. Returns true exactly
 * once per file — on the second consecutive status-0 failure — so callers
 * fire the hint once and then stay quiet instead of repeating it on every
 * remaining retry.
 */
export function noteAttemptStatus(tracker: ZeroStatusTracker, status: number): boolean {
  if (status !== 0) {
    tracker.consecutive = 0
    return false
  }
  tracker.consecutive += 1
  if (tracker.consecutive >= 2 && !tracker.hinted) {
    tracker.hinted = true
    return true
  }
  return false
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ------------------------------------------------------------------
// The transfer itself.
// ------------------------------------------------------------------

export interface PutOptions {
  url: string
  body: Blob
  contentType: string
  signal: AbortSignal
  onProgress?: (loaded: number) => void
}

/**
 * XMLHttpRequest, not fetch, and this is not a style choice: fetch has no
 * upload progress event. Streaming request bodies (duplex: 'half') would let
 * us count bytes as they are pulled, but they are not available cross-origin
 * in Safari. xhr.upload.onprogress is the only portable per-file bar.
 *
 * The cost, stated: no AbortSignal composition (bridged by hand below), no
 * response streaming, and a cross-origin network failure arrives as status 0
 * with no cause — identical to a CORS misconfiguration.
 */
export function xhrPut(options: PutOptions): Promise<{ etag: string | null }> {
  return new Promise<{ etag: string | null }>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', options.url, true)
    // Exactly what the Worker signed. Deriving it client-side risks a
    // SignatureDoesNotMatch that looks like an expired URL.
    xhr.setRequestHeader('content-type', options.contentType)

    const onAbort = () => xhr.abort()
    const cleanup = () => options.signal.removeEventListener('abort', onAbort)
    options.signal.addEventListener('abort', onAbort, { once: true })

    xhr.upload.onprogress = (event: ProgressEvent) => options.onProgress?.(event.loaded)

    xhr.onload = () => {
      cleanup()
      const disposition = classifyStatus(xhr.status)
      if (disposition === 'ok') {
        // Readable only because the bucket CORS rule carries
        // ExposeHeaders: ["ETag"]. Without it this is null, and multipart
        // completion is impossible.
        resolve({ etag: normaliseEtag(xhr.getResponseHeader('ETag')) })
        return
      }
      reject(new TransferError(`R2 returned ${xhr.status}`, xhr.status, disposition))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new TransferError('network error', 0, 'retry'))
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new TransferError('timed out', 0, 'retry'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new DOMException('aborted', 'AbortError'))
    }
    xhr.send(options.body)
  })
}

async function withRetry<T>(
  signal: AbortSignal,
  attemptFn: () => Promise<T>,
  represign: () => Promise<void>,
  zeroStatus: ZeroStatusTracker,
  cb: UploadCallbacks,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await attemptFn()
      // A successful attempt breaks any status-0 streak this file was
      // building — it proves this PUT, at least, reached R2 and back.
      zeroStatus.consecutive = 0
      return result
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err
      const status = err instanceof TransferError ? err.status : -1
      if (noteAttemptStatus(zeroStatus, status)) cb.onStatus(CORS_HINT)
      const disposition = err instanceof TransferError ? err.disposition : 'fatal'
      if (disposition === 'fatal' || disposition === 'restart') throw err
      if (attempt + 1 >= MAX_ATTEMPTS) throw err
      if (disposition === 'represign') await represign()
      await sleep(backoffDelayMs(attempt), signal)
    }
  }
}

// ------------------------------------------------------------------
// The API surface. One place that talks to Task 5's routes.
//
// Task 5's JSON is snake_case (file_id, byte_size, content_type, …) and
// shapes a presign response as `resumable` + `multipart`, never `mode`.
// Everything ABOVE this comment, and everything callers of UploadApi see,
// stays camelCase and `resumable`/`multipart`-typed; httpApi below is the
// only place that speaks the wire format, so a Task 5 field rename touches
// one object literal, not every call site in this file.
// ------------------------------------------------------------------

export interface PresignRequest {
  batchId: string
  fileId: string
  filename: string
  byteSize: number
  clientDurationMs: number | null
}

export type PresignResponse =
  /** `ingest_begin` replayed a row already in `received` (done) or in
   *  `failed`/`abandoned` (not done — dead, needs a fresh file_id). */
  | { resumable: false; done: boolean; state: string }
  | { resumable: true; multipart: false; state: string; contentType: string; url: string; expiresAt: string }
  | {
      resumable: true; multipart: true; state: string; contentType: string
      uploadId: string; partSize: number; partCount: number
    }

export interface CompletedPart { partNumber: number; etag: string; size: number }

export interface PresignedPart { partNumber: number; start: number; end: number; url: string }

export interface UploadApi {
  createBatch(label: string | null): Promise<{ batchId: string }>
  presign(body: PresignRequest): Promise<PresignResponse>
  /** `from`/`to` are an inclusive, contiguous 1-based range — the ONLY shape
   *  /api/upload/parts accepts, never an arbitrary list of part numbers. */
  presignParts(fileId: string, from: number, to: number): Promise<{
    partSize: number; byteSize: number; expiresAt: string; parts: PresignedPart[]
  }>
  complete(fileId: string, parts: { partNumber: number; etag: string }[] | null): Promise<{ state: string; byteSize: number }>
  abort(fileId: string, reason: string): Promise<void>
  resume(fileId: string): Promise<{
    state: string; multipart: boolean; uploadId: string | null; partSize: number | null
    partCount: number | null; byteSize: number; completed: CompletedPart[]
    /** The multipart upload was swept (24 h sweeper) or lifecycle-aborted
     *  (1-day R2 rule) before we came back. Nothing to resume — restart with
     *  a fresh file_id, same as size_mismatch / object_missing from complete. */
    expired: boolean
  }>
}

async function readJson<T>(res: Response): Promise<T> {
  // src/middleware.ts's auth gate redirects any request without a live
  // member to /login, and fetch follows the redirect, so a dead session
  // arrives here as 200 text/html — never as a 401. Detect it by content
  // type, or 200 files fail with an unparseable-JSON error nobody can read.
  //
  // The username-claim gate (same file) used to redirect /api/* the same
  // way — a null username (e.g. mid-rollout of migration 17, which nulls
  // every username at once) read as "session ended" here and aborted the
  // whole in-flight batch instead of failing one file. It now returns a
  // JSON 403 for /api/* paths instead of redirecting (see isApiPath in
  // src/lib/session.ts), so /login's redirect is the only remaining path
  // that lands a request here as non-JSON.
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new SessionExpiredError()
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new ApiError(body.error ?? `request failed (${res.status})`, res.status)
  return body
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  // content-type is mandatory: Astro's built-in CSRF origin check 403s an
  // unsafe-method request with no recognised content type, BEFORE middleware.
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readJson<T>(res)
}

// ---- wire shapes: exactly what Task 5's routes send, snake_case and all ----
interface WirePresignResumable {
  file_id: string; state: string; resumable: true; multipart: boolean
  content_type: string; url?: string; expires_at?: string
  upload_id?: string; part_size?: number; part_count?: number
}
interface WirePresignDone { file_id: string; state: string; resumable: false; done: boolean }
type WirePresignResponse = WirePresignResumable | WirePresignDone

interface WirePartsResponse {
  file_id: string; part_size: number; byte_size: number; expires_at: string
  parts: { part_number: number; start: number; end: number; url: string }[]
}
interface WireCompleteResponse { file_id: string; state: string; byte_size: number; already?: boolean }
interface WireResumeResponse {
  file_id: string; state: string; multipart: boolean; upload_id: string | null
  part_size: number | null; part_count: number | null; byte_size: number
  uploaded_parts: { part_number: number; etag: string; size: number }[]
  expired?: boolean
}

export const httpApi: UploadApi = {
  createBatch: async (label) => {
    const res = await postJson<{ batch_id: string }>('/api/upload/batch', { label })
    return { batchId: res.batch_id }
  },

  presign: async (body) => {
    const res = await postJson<WirePresignResponse>('/api/upload/presign', {
      batch_id: body.batchId,
      file_id: body.fileId,
      filename: body.filename,
      byte_size: body.byteSize,
      client_duration_ms: body.clientDurationMs,
    })
    if (!res.resumable) return { resumable: false, done: res.done, state: res.state }
    if (!res.multipart) {
      return {
        resumable: true, multipart: false, state: res.state,
        contentType: res.content_type, url: res.url as string, expiresAt: res.expires_at as string,
      }
    }
    return {
      resumable: true, multipart: true, state: res.state, contentType: res.content_type,
      uploadId: res.upload_id as string, partSize: res.part_size as number, partCount: res.part_count as number,
    }
  },

  presignParts: async (fileId, from, to) => {
    const res = await postJson<WirePartsResponse>('/api/upload/parts', { file_id: fileId, from, to })
    return {
      partSize: res.part_size, byteSize: res.byte_size, expiresAt: res.expires_at,
      parts: res.parts.map((p) => ({ partNumber: p.part_number, start: p.start, end: p.end, url: p.url })),
    }
  },

  complete: async (fileId, parts) => {
    const res = await postJson<WireCompleteResponse>('/api/upload/complete', {
      file_id: fileId,
      parts: parts === null ? null : parts.map((p) => ({ part_number: p.partNumber, etag: p.etag })),
    })
    return { state: res.state, byteSize: res.byte_size }
  },

  abort: async (fileId, reason) => {
    await postJson('/api/upload/abort', { file_id: fileId, reason })
  },

  resume: async (fileId) => {
    const res = await readJson<WireResumeResponse>(
      await fetch(`/api/upload/resume?file_id=${encodeURIComponent(fileId)}`, {
        headers: { accept: 'application/json' },
      }),
    )
    return {
      state: res.state, multipart: res.multipart, uploadId: res.upload_id,
      partSize: res.part_size, partCount: res.part_count, byteSize: res.byte_size,
      completed: res.uploaded_parts.map((p) => ({ partNumber: p.part_number, etag: p.etag, size: p.size })),
      expired: res.expired ?? false,
    }
  },
}

// ------------------------------------------------------------------
// One file, start to finish.
// ------------------------------------------------------------------

export interface UploadItem {
  key: string
  fileId: string
  file: File
  clientDurationMs: number | null
  plan: UploadPlan
}

export interface UploadCallbacks {
  /** Absolute bytes confirmed on R2 plus bytes in flight, for this file. */
  onProgress: (loaded: number) => void
  onStatus: (message: string) => void
}

export type UploadOutcome = 'received' | 'already'

export async function uploadFile(
  batchId: string,
  item: UploadItem,
  api: UploadApi,
  signal: AbortSignal,
  cb: UploadCallbacks,
): Promise<UploadOutcome> {
  // One tracker for this file's whole transfer — shared across every part,
  // concurrent or not, so a CORS misconfiguration is caught regardless of
  // whether the file is a single PUT or a hundred-part multipart. See
  // ZeroStatusTracker's doc comment above.
  const zeroStatus = newZeroStatusTracker()
  try {
    const presigned = await api.presign({
      batchId,
      fileId: item.fileId,
      filename: item.file.name,
      byteSize: item.file.size,
      clientDurationMs: item.clientDurationMs,
    })

    if (!presigned.resumable) {
      if (presigned.done) {
        cb.onProgress(item.file.size)
        return 'already'
      }
      // resumable:false, done:false means the row is `failed` or `abandoned`
      // — a stale journal entry pointing at a row a previous session already
      // gave up on. Task 3's ingest_mark_uploading never accepts `failed` as
      // a source state, so this file can never move again under this id.
      // 'restart' -> discard=true below -> the row surfaces as failed and
      // Retry mints a fresh file_id, same as size_mismatch/object_missing.
      throw new TransferError(
        `this file is already ${presigned.state} and cannot be resumed`, 409, 'restart',
      )
    }

    if (!presigned.multipart) {
      await transferSingle(item, presigned, api, batchId, signal, cb, zeroStatus)
      await api.complete(item.fileId, null)
      cb.onProgress(item.file.size)
      return 'received'
    }

    const parts = await transferMultipart(item, presigned, api, signal, cb, zeroStatus)
    await api.complete(item.fileId, parts)
    cb.onProgress(item.file.size)
    return 'received'
  } catch (err) {
    if (isAbortError(err) || err instanceof SessionExpiredError) throw err

    const disposition = err instanceof TransferError ? err.disposition : 'fatal'
    const discard = disposition === 'fatal' || disposition === 'restart'

    if (discard) {
      // Tear the multipart down now rather than billing for it until the 24 h
      // sweeper runs. Note what this costs: ingest_fail moves the row to
      // `failed`, and Task 3's ingest_mark_uploading accepts only
      // pending|uploading as a source state, so this row can NEVER be
      // resumed — a retry needs a fresh file_id. That is exactly why an
      // exhausted network retry does not come through here: it leaves the row
      // in `uploading` and the parts in R2, so Retry resumes.
      await api.abort(item.fileId, describeError(err)).catch(() => undefined)
    }
    // Minor 3: once two consecutive status-0 PUTs were seen anywhere in this
    // transfer, the eventual "network error" is exactly the message that
    // sends someone hunting the wrong problem — append the hint so the
    // final failure the UI shows points at CORS, not just a dead connection.
    const message = zeroStatus.hinted ? `${describeError(err)} (${CORS_HINT})` : describeError(err)
    throw new UploadFailure(message, discard, { cause: err })
  }
}

async function transferSingle(
  item: UploadItem,
  presigned: Extract<PresignResponse, { multipart: false }>,
  api: UploadApi,
  batchId: string,
  signal: AbortSignal,
  cb: UploadCallbacks,
  zeroStatus: ZeroStatusTracker,
): Promise<void> {
  let url = presigned.url
  cb.onStatus('uploading')
  await withRetry(
    signal,
    async () => {
      await xhrPut({
        url,
        body: item.file,
        contentType: presigned.contentType,
        signal,
        onProgress: (loaded) => cb.onProgress(loaded),
      })
    },
    async () => {
      // presign replays ingest_begin, which is idempotent, so this is just a
      // fresh signature over the same key.
      const again = await api.presign({
        batchId,
        fileId: item.fileId,
        filename: item.file.name,
        byteSize: item.file.size,
        clientDurationMs: item.clientDurationMs,
      })
      if (again.resumable && !again.multipart) url = again.url
      cb.onProgress(0)
    },
    zeroStatus,
    cb,
  )
}

/**
 * Splits a sorted, gap-free-within-runs list of part numbers into contiguous
 * `[from, to]` ranges no longer than `maxLength`.
 *
 * /api/upload/parts accepts exactly one inclusive range per call — never an
 * arbitrary list — so this is what turns "parts 4, 5, 9, 10, 11" (a gap from
 * an out-of-order retry) into two range requests instead of one malformed one.
 */
export function contiguousRanges(sorted: number[], maxLength: number): [number, number][] {
  const ranges: [number, number][] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1 && j - i + 1 < maxLength) j += 1
    ranges.push([sorted[i], sorted[j]])
    i = j + 1
  }
  return ranges
}

async function transferMultipart(
  item: UploadItem,
  presigned: Extract<PresignResponse, { multipart: true }>,
  api: UploadApi,
  signal: AbortSignal,
  cb: UploadCallbacks,
  zeroStatus: ZeroStatusTracker,
): Promise<{ partNumber: number; etag: string }[]> {
  const { partSize, partCount, contentType } = presigned

  // The stored plan is authoritative. R2 validates "every non-trailing part is
  // the same length" only at CompleteMultipartUpload — after every byte is
  // already uploaded — so offsets are derived from THIS number and never
  // recomputed. If it disagrees with the file we hold, the journal matched the
  // wrong file; refuse rather than splice new bytes into an old multipart.
  const expected = item.plan.multipart ? item.plan.partSize : null
  if (expected !== partSize || partCount !== Math.ceil(item.file.size / partSize)) {
    throw new TransferError(
      'this file no longer matches the upload it was resuming', 400, 'restart',
    )
  }

  // Part ETags are recovered from R2, never persisted by us. That is the whole
  // reason cross-device resume works.
  const recovered = await api.resume(item.fileId)
  if (recovered.expired) {
    // Swept by the 24 h sweeper or lifecycle-aborted by the 1-day R2 rule
    // before we came back. Nothing left to resume — 'restart' tears the row
    // down and Retry mints a fresh file_id, same as a size_mismatch below.
    throw new TransferError(
      'this upload expired and was cleaned up — it must restart', 404, 'restart',
    )
  }
  const done = new Map<number, string>()
  let confirmedBytes = 0
  for (const part of recovered.completed) {
    if (part.partNumber >= 1 && part.partNumber <= partCount) {
      done.set(part.partNumber, part.etag)
      confirmedBytes += part.size
    }
  }

  const inFlight = new Map<number, number>()
  const report = () => {
    let sum = confirmedBytes
    for (const bytes of inFlight.values()) sum += bytes
    cb.onProgress(sum)
  }
  report()

  const missing: number[] = []
  for (let n = 1; n <= partCount; n += 1) if (!done.has(n)) missing.push(n)
  cb.onStatus(
    done.size > 0
      ? `resuming — ${done.size} of ${partCount} parts already on R2`
      : `uploading ${partCount} parts`,
  )

  for (const [from, to] of contiguousRanges(missing, PART_PRESIGN_CHUNK)) {
    const chunk: number[] = []
    for (let n = from; n <= to; n += 1) chunk.push(n)

    const presignedParts = await api.presignParts(item.fileId, from, to)
    const urls = new Map(presignedParts.parts.map((p) => [p.partNumber, p.url]))

    const results = await pump(
      chunk.map((partNumber) => async (partSignal: AbortSignal) => {
        let url = urls.get(partNumber)
        if (url === undefined) {
          throw new TransferError(`no presigned url for part ${partNumber}`, 400, 'fatal')
        }
        const { start, end } = partRange(partNumber, partSize, item.file.size)
        const body = item.file.slice(start, end)

        const etag = await withRetry(
          partSignal,
          async () => {
            const result = await xhrPut({
              url: url as string,
              body,
              contentType,
              signal: partSignal,
              onProgress: (loaded) => { inFlight.set(partNumber, loaded); report() },
            })
            if (result.etag === null) {
              throw new TransferError(
                'R2 returned no readable ETag — the bucket CORS rule is missing ExposeHeaders: ["ETag"]',
                200, 'fatal',
              )
            }
            return result.etag
          },
          async () => {
            // A single-part range: /api/upload/parts accepts from === to.
            const fresh = await api.presignParts(item.fileId, partNumber, partNumber)
            url = fresh.parts[0]?.url ?? url
            inFlight.set(partNumber, 0)
            report()
          },
          zeroStatus,
          cb,
        )

        inFlight.delete(partNumber)
        confirmedBytes += end - start
        done.set(partNumber, etag)
        report()
        return partNumber
      }),
      { concurrency: PART_CONCURRENCY, signal },
    )

    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      if (result.status === 'skipped') throw new DOMException('aborted', 'AbortError')
    }
  }

  return [...done.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([partNumber, etag]) => ({ partNumber, etag }))
}
