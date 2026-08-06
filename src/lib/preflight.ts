// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { preflight, preflightMessage, type PreflightVerdict } from './upload-policy'
import type { HeaderFacts, PreflightRequest, PreflightResponse } from './preflight.worker'

/**
 * Per-file budget for a header parse. Generous: a header parse is tens of
 * bytes, but they come off a disk that may be asleep, external or a network
 * volume. Exceeding it is treated as "unknown duration", never as a
 * rejection.
 */
export const PARSE_TIMEOUT_MS = 5_000

/**
 * - `header`   the container states the duration. Exact or near-exact.
 * - `estimate` the container did NOT state it; extrapolated from one frame's
 *              bitrate. Wrong in both directions. Display only.
 * - `unknown`  no usable number at all.
 */
export type DurationSource = 'header' | 'estimate' | 'unknown'

export type DurationRead = {
  durationMs: number | null
  source: DurationSource
  note?: string
}

export const UNKNOWN_DURATION: DurationRead = {
  durationMs: null,
  source: 'unknown',
  note: 'not read',
}

/** Pure. Everything the browser-only path resolves to goes through here. */
export function classifyDuration(facts: HeaderFacts): DurationRead {
  if (facts.durationSec !== null && Number.isFinite(facts.durationSec) && facts.durationSec > 0) {
    return { durationMs: Math.round(facts.durationSec * 1000), source: 'header' }
  }
  if (facts.bitrate !== null && facts.bitrate > 0 && facts.byteSize > 0) {
    // A VBR MP3 with no Xing header. `bitrate` is ONE frame's bitrate, not
    // the average, so this is a guess: measured 17% low on a synthetic
    // 128/192 file. It exists to put a number next to the filename and it
    // never leaves the browser.
    return {
      durationMs: Math.round((facts.byteSize * 8 * 1000) / facts.bitrate),
      source: 'estimate',
      note: 'no duration in the container header; extrapolated from one frame',
    }
  }
  return { durationMs: null, source: 'unknown', note: 'no duration in the container header' }
}

export type FilePreflight = {
  verdict: PreflightVerdict
  /** Send to ingest_begin as p_client_duration_ms. Null unless it came from
   *  the container header — Task 2 documents that column as exactly that. */
  clientDurationMs: number | null
  /** Show in the UI. May be an estimate; see `estimated`. */
  displayDurationMs: number | null
  estimated: boolean
  message: string
}

/**
 * Pure. The decision, in one place.
 *
 * Only a header duration can reject a file. An estimate is never a
 * rejection: a false reject is unrecoverable for the user, a false accept
 * costs one upload that M3 deletes for free. The size gate in `preflight()`
 * still runs on every file whatever the duration says, and it is the only
 * pre-bytes check that does not depend on the client telling the truth.
 */
export function preflightFile(
  file: { name: string; size: number }, read: DurationRead,
): FilePreflight {
  const trusted = read.source === 'header' ? read.durationMs : null
  const verdict = preflight(file.name, file.size, trusted)
  return {
    verdict,
    clientDurationMs: trusted,
    displayDurationMs: read.durationMs,
    estimated: read.source !== 'header',
    message:
      verdict.ok && read.source === 'estimate'
        ? 'ready — length is an estimate until the file is analysed'
        : preflightMessage(verdict),
  }
}

// Moved to ./format so pool components can import it without pulling in
// music-metadata and the pre-flight Web Worker. Re-exported here because
// UploadDropzone and preflight.test.ts both import it from this module.
export { formatDuration } from './format'

// --------------------------------------------------------------- the worker

let worker: Worker | null = null
let workerUnavailable = false
let nextId = 1
let chain: Promise<unknown> = Promise.resolve()

function getWorker(): Worker | null {
  if (workerUnavailable || typeof Worker === 'undefined') return null
  if (!worker) {
    try {
      // This exact syntax is load-bearing: Vite detects `new Worker(new
      // URL('...', import.meta.url), { type: 'module' })` statically to emit
      // the worker bundle. Any indirection and the worker is silently not
      // bundled, which fails only in the production build.
      worker = new Worker(new URL('./preflight.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      // No module-worker support. Parse inline instead: janky, but correct.
      workerUnavailable = true
      return null
    }
  }
  return worker
}

export function disposePreflightWorker(): void {
  worker?.terminate()
  worker = null
}

/**
 * PERF TASK 2.5 — start the worker's download before the first file exists.
 *
 * Constructing the Worker is what fetches its bundle, and until this the
 * first construction happened inside `readDurationMs` — i.e. after the
 * member had already chosen files and was watching a row wait. The bundle
 * is ~29 KB gzip plus a per-container parser chunk, which on a phone is a
 * visible pause at exactly the wrong moment.
 *
 * Called from the dropzone on hover and on focus. Idempotent: `getWorker()`
 * memoises, and a second call is free. Never throws — a browser with no
 * module-worker support sets `workerUnavailable` here instead of at the
 * first file, and the main-thread path takes over exactly as before.
 */
export function warmPreflightWorker(): void {
  getWorker()
}

function parseInWorker(w: Worker, blob: Blob, timeoutMs: number): Promise<HeaderFacts> {
  const id = nextId++
  return new Promise<HeaderFacts>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PreflightResponse
      if (data.id !== id) return
      cleanup()
      if (data.ok) resolve(data.facts)
      else reject(new Error(data.error))
    }
    const onError = () => {
      cleanup()
      disposePreflightWorker()
      reject(new Error('preflight worker crashed'))
    }
    const timer = setTimeout(() => {
      cleanup()
      // There is no portable way to cancel an in-flight parseBlob — no
      // AbortSignal reaches the tokenizer. Killing the worker is the only
      // reliable stop; getWorker() builds a fresh one for the next file.
      disposePreflightWorker()
      reject(new Error('preflight timed out'))
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    // Structured clone passes a Blob/File BY REFERENCE — the bytes stay on
    // disk, so handing over a 500 MB WAV costs nothing.
    const request: PreflightRequest = { id, blob }
    w.postMessage(request)
  })
}

/**
 * Read a file's duration without reading the file.
 *
 * Never rejects: a corrupt file in a 200-file batch must not abort the
 * batch, so every failure resolves to `unknown`. Serialised through one
 * worker — the bottleneck is disk reads, not CPU, and a pool would mean one
 * copy of music-metadata per worker.
 */
export function readDurationMs(
  blob: Blob, timeoutMs: number = PARSE_TIMEOUT_MS,
): Promise<DurationRead> {
  const run = async (): Promise<DurationRead> => {
    try {
      const w = getWorker()
      const facts = w
        ? await parseInWorker(w, blob, timeoutMs)
        : await (await import('./preflight.worker')).parseAudioHeader(blob)
      return classifyDuration(facts)
    } catch (err) {
      return {
        durationMs: null,
        source: 'unknown',
        note: err instanceof Error ? err.message : 'header parse failed',
      }
    }
  }
  const result = chain.then(run, run)
  chain = result.then(() => undefined, () => undefined)
  return result
}
