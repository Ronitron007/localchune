// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { parseBlob } from 'music-metadata'

export type HeaderFacts = {
  durationSec: number | null
  bitrate: number | null
  byteSize: number
  container: string | null
}

export type PreflightRequest = { id: number; blob: Blob }

export type PreflightResponse =
  | { id: number; ok: true; facts: HeaderFacts }
  | { id: number; ok: false; error: string }

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/**
 * Read the container header, and nothing else.
 *
 * `duration: false` is the whole point of this module. With `true`,
 * music-metadata will walk every MPEG frame or every Ogg page to work out a
 * duration the header did not give it — i.e. read the entire file. With
 * `false` it reports only what the header states, which is exactly the
 * number we are allowed to have before bytes move.
 *
 * `skipCovers` makes embedded artwork an `ignore()` (zero bytes off a Blob)
 * instead of a read; `skipPostHeaders` skips the ID3v1/APE trailer probe,
 * saving one tail slice per file.
 *
 * The WHOLE blob goes in. Never a prefix: an MP4 written without faststart
 * keeps its `moov` atom behind a 60 MB `mdat`, and a truncated slice reports
 * a plausible wrong duration rather than an error.
 */
export async function parseAudioHeader(blob: Blob): Promise<HeaderFacts> {
  const md = await parseBlob(blob, {
    duration: false,
    skipCovers: true,
    skipPostHeaders: true,
  })
  return {
    durationSec: positive(md.format.duration),
    bitrate: positive(md.format.bitrate),
    byteSize: blob.size,
    // Advisory only. Task 4's extension decides the size cap and the key
    // suffix, and M3's ffprobe is authoritative for the real container.
    // Rejecting on a mismatch here would refuse valid files whose extension
    // is merely wrong, which is not a decision M2 gets to make.
    container: md.format.container ?? null,
  }
}

const scope = globalThis as unknown as {
  postMessage(message: PreflightResponse): void
  addEventListener(type: string, listener: (event: { data: PreflightRequest }) => void): void
  WorkerGlobalScope?: new () => unknown
}

// True only inside a worker: undefined in node (vitest imports this module
// directly), and on the main thread `globalThis` is a Window, not a
// WorkerGlobalScope. Importing this file must have no side effects anywhere
// else.
const inWorkerScope =
  typeof scope.WorkerGlobalScope !== 'undefined' && globalThis instanceof scope.WorkerGlobalScope

if (inWorkerScope) {
  scope.addEventListener('message', (event) => {
    const { id, blob } = event.data
    parseAudioHeader(blob).then(
      (facts) => scope.postMessage({ id, ok: true, facts }),
      (err: unknown) =>
        scope.postMessage({
          id, ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    )
  })
}
