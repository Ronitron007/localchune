// src/lib/analyze-queue.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { env } from 'cloudflare:workers'

/**
 * The app Worker's half of the analysis pipeline: one `send`, and nothing
 * else. The consumer is a different Worker (`workers/analysis/`) with the
 * container, the Durable Object and the service_role key; this side has the
 * producer binding and no idea what happens next.
 *
 * SERVER ONLY — `cloudflare:workers` in a client bundle fails the build.
 */

/**
 * Bumped when the analysis pipeline changes in a way that makes old rows
 * incomparable with new ones. It travels in the message so a backfill can
 * re-analyse at a new version without the consumer having to guess.
 */
export const ANALYSIS_VERSION = 'v1'

export interface AnalyzeMessage {
  file_id: string
  r2_key: string
  analysis_version: string
}

/**
 * Enqueue one file for analysis. Returns whether the send succeeded.
 *
 * NEVER THROWS, and the caller deliberately ignores a false. By the time
 * this runs, `ingest_finalize` has already committed: the bytes are verified
 * in R2 and the row is `received`. Failing the HTTP response over a queue
 * hiccup would tell the browser its upload failed when it plainly did not,
 * and would invite a retry that re-uploads 40 MB for nothing.
 *
 * A dropped message is not a lost file either. `received` is a state the
 * maintenance Worker's hourly cron sweeps: anything sitting there for an
 * hour is enqueued again. files.state is the system of record; the queue is
 * a transport.
 */
export async function enqueueAnalysis(fileId: string, r2Key: string): Promise<boolean> {
  const queue = (env as unknown as { ANALYZE_QUEUE?: Queue<AnalyzeMessage> }).ANALYZE_QUEUE
  if (!queue) {
    console.error(
      `analyze-queue: no ANALYZE_QUEUE binding — ${fileId} will wait for the stuck-job cron`,
    )
    return false
  }
  try {
    await queue.send({
      file_id: fileId,
      r2_key: r2Key,
      analysis_version: ANALYSIS_VERSION,
    })
    return true
  } catch (e) {
    console.error(
      `analyze-queue: send failed for ${fileId}:`,
      e instanceof Error ? e.message : String(e),
    )
    return false
  }
}
