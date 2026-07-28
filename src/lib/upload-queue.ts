// src/lib/upload-queue.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * How many files transfer at once.
 *
 * Not a socket-count limit — R2's S3 endpoint speaks HTTP/2, so the browser's
 * six-connections-per-origin cap does not bind. Three because:
 *
 *  - A single uplink saturates around four streams. Past that, nothing gets
 *    faster; the only change is that every file finishes at the end instead
 *    of some finishing early. Bounded, file 1 is durable in R2 while file 200
 *    has not started, so a tab close at 90% loses 3 partial uploads, not 200.
 *  - Presigned URLs are minted when a transfer starts, not when the batch is
 *    planned, so no URL sits unused until it expires.
 *  - Three moving progress bars is legible. Two hundred crawling bars is not.
 */
export const FILE_CONCURRENCY = 3

/**
 * How many 16 MiB parts of ONE file transfer at once. Worst case in flight is
 * FILE_CONCURRENCY * PART_CONCURRENCY = 9 PUTs, which is why presigned URLs
 * must be signed for at least an hour: nine streams sharing a venue uplink
 * make a single part slow.
 */
export const PART_CONCURRENCY = 3

/**
 * How many duration pre-flights run at once. Separate from the transfer pool
 * because each one spawns a Web Worker (Task 6); 200 simultaneous Workers is
 * a reliable way to hang a tab.
 */
export const PREFLIGHT_CONCURRENCY = 4

/** A unit of work. Receives the pump's signal so it can cancel its own I/O. */
export type PumpTask<T> = (signal: AbortSignal) => Promise<T>

export type PumpResult<T> =
  | { index: number; status: 'fulfilled'; value: T }
  | { index: number; status: 'rejected'; reason: unknown }
  /** Aborted before this task ever started. It did no work. */
  | { index: number; status: 'skipped' }

export interface PumpOptions<T> {
  concurrency?: number
  signal?: AbortSignal
  /** Fires once per task, in COMPLETION order. Results are returned in input order. */
  onSettled?: (result: PumpResult<T>) => void
}

/**
 * Bounded-concurrency runner over an iterable of async tasks.
 *
 * Pure: no DOM, no network, no timers of its own. Two properties the upload
 * client depends on:
 *
 *  1. It NEVER rejects. One unreadable file must not kill a 200-file batch,
 *     so a throwing task becomes a `rejected` result and the pump continues.
 *  2. It pulls from the iterator lazily, at most `concurrency` tasks ahead.
 *     Passing a generator therefore means 200 files never produce 200 live
 *     closures, 200 Blob slices or 200 sockets.
 */
export async function pump<T>(
  tasks: Iterable<PumpTask<T>>,
  options: PumpOptions<T> = {},
): Promise<PumpResult<T>[]> {
  const concurrency = options.concurrency ?? FILE_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('pump: concurrency must be a positive integer')
  }

  const iterator = tasks[Symbol.iterator]()
  const results: PumpResult<T>[] = []

  // An inner controller so a task's own failure never aborts its siblings,
  // and so the outer signal is relayed exactly once.
  const controller = new AbortController()
  const outer = options.signal
  const relay = () => controller.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener('abort', relay, { once: true })
  }

  let issued = 0
  const settle = (result: PumpResult<T>) => {
    results[result.index] = result
    options.onSettled?.(result)
  }

  // iterator.next() is synchronous, and JS is single-threaded, so the workers
  // cannot hand out the same index twice.
  const worker = async (): Promise<void> => {
    for (;;) {
      const step = iterator.next()
      if (step.done === true) return
      const index = issued
      issued += 1
      if (controller.signal.aborted) {
        settle({ index, status: 'skipped' })
        continue
      }
      try {
        settle({ index, status: 'fulfilled', value: await step.value(controller.signal) })
      } catch (reason) {
        settle({ index, status: 'rejected', reason })
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
  } finally {
    outer?.removeEventListener('abort', relay)
  }
  return results
}
