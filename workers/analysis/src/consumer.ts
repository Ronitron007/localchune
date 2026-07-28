// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * What to do with one queue message, as a pure function of its body, its
 * attempt count and four injected effects.
 *
 * Separated from index.ts so the decision table — which failures retry,
 * which are terminal, which are already-done — is unit-testable without a
 * container, a Durable Object or a database. index.ts supplies the real
 * effects and translates the returned Outcome into ack()/retry().
 */

import type { AnalyzeResponse } from './types'
import { NO_DATA_FOUND, PostgrestError } from './supabase'

export interface AnalyzeMessage {
  file_id: string
  r2_key: string
  analysis_version: string
}

/**
 * The same shape ingest_begin() mints and src/lib/r2.ts signs. Only two
 * things can put a message on this queue — the app Worker's /api/upload/
 * complete route and the maintenance Worker's cron — and both read the key
 * straight out of Postgres, so this is a shape assertion rather than a trust
 * boundary. It is here anyway: the DO hands whatever arrives to
 * env.AUDIO.get(), and a key that is not this shape means something upstream
 * is confused and the message should die quietly rather than fetch an
 * unexpected object.
 */
const AUDIO_KEY_RE = /^audio\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * How many times a container-reported failure (`ok:false`) is retried before
 * the file is marked failed for good.
 *
 * /analyze never raises: it catches everything and answers ok:false with a
 * reason (worker/app/main.py). That catch-all covers both a genuinely
 * corrupt file, which will fail identically forever, and a bad minute on the
 * instance — an OOM, a full disk — which will not. Retrying twice costs at
 * most two more ~55 vCPU-s runs on a file that was never going to work;
 * never retrying loses a good track to a transient fault. Two is the
 * cheapest number that covers the transient case.
 */
export const OK_FALSE_MAX_ATTEMPTS = 3

export type Outcome =
  | { action: 'ack'; reason: string }
  | { action: 'retry'; reason: string; delaySeconds: number }

export interface Deps {
  /** analysis_begin: claim the file. Returns its state after the call. */
  begin(fileId: string): Promise<string>
  /** The Durable Object. Throws on infrastructure failure only. */
  analyse(msg: AnalyzeMessage): Promise<AnalyzeResponse>
  /** analysis_persist: store the result and move the file to 'stored'. */
  persist(result: AnalyzeResponse): Promise<string>
  /** analysis_fail: terminal failure, with the reason. */
  fail(fileId: string, reason: string): Promise<string>
}

export function parseMessage(body: unknown): AnalyzeMessage | null {
  if (typeof body !== 'object' || body === null) return null
  const m = body as Record<string, unknown>
  if (typeof m.file_id !== 'string' || !UUID_RE.test(m.file_id)) return null
  if (typeof m.r2_key !== 'string' || !AUDIO_KEY_RE.test(m.r2_key)) return null
  if (typeof m.analysis_version !== 'string' || m.analysis_version === '') return null
  return { file_id: m.file_id, r2_key: m.r2_key, analysis_version: m.analysis_version }
}

function ack(reason: string): Outcome {
  return { action: 'ack', reason }
}

/**
 * Backoff. Queues applies its own, but a container analysis is a ~55 second,
 * ~3 GiB job — retrying one the instant it fails means the next attempt
 * lands on an instance that is still busy or still broken. Capped at five
 * minutes so the stuck-job cron, not the backoff, is what covers a long
 * outage.
 */
function retry(reason: string, attempts: number): Outcome {
  return {
    action: 'retry',
    reason,
    delaySeconds: Math.min(60 * Math.max(attempts, 1), 300),
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * `attempts` is `message.attempts` — 1 on first delivery.
 */
export async function handleMessage(
  body: unknown,
  attempts: number,
  deps: Deps,
): Promise<Outcome> {
  const msg = parseMessage(body)
  if (!msg) {
    // Unfixable by definition: retrying a malformed message re-delivers the
    // same malformed message five more times and then fills the DLQ with it.
    return ack(`malformed message discarded: ${JSON.stringify(body)?.slice(0, 300)}`)
  }

  let state: string
  try {
    state = await deps.begin(msg.file_id)
  } catch (e) {
    // The row is gone — deleted, or never existed. Nothing to analyse and
    // nothing to retry into.
    if (e instanceof PostgrestError && e.code === NO_DATA_FOUND) {
      return ack(`${msg.file_id}: no such file, dropping`)
    }
    return retry(`${msg.file_id}: analysis_begin: ${describe(e)}`, attempts)
  }

  // [F4] 'busy' means another delivery claimed this file inside
  // analysis_begin()'s 10-minute lease and is presumably still running it —
  // this delivery must back off and let that one finish, not start a
  // second ~45 vCPU-s container analysis on the same file. Queues' own
  // backoff (delaySeconds below) comfortably outlasts the lease.
  if (state === 'busy') {
    return retry(`${msg.file_id}: another delivery is already analysing this file`, attempts)
  }

  // Anything but 'analysing' means the state machine has already moved this
  // file somewhere this consumer must not drag it back from: another
  // delivery finished it ('stored'), a human quarantined it, the upload was
  // abandoned. Acking is correct — the work is done or forbidden, not
  // pending.
  if (state !== 'analysing') {
    return ack(`${msg.file_id}: state is '${state}', not claimable`)
  }

  let result: AnalyzeResponse
  try {
    result = await deps.analyse(msg)
  } catch (e) {
    // Everything the DO throws is infrastructure: an R2 miss, an unreachable
    // container, a non-JSON or 5xx answer from /analyze. All retryable, and
    // an R2 key that is genuinely gone rides the retries into the DLQ rather
    // than looping — which is the designed behaviour, because the file stays
    // 'analysing' and the stuck-job cron gets to decide next.
    return retry(`${msg.file_id}: analyse: ${describe(e)}`, attempts)
  }

  if (!result.ok) {
    const reason = result.error ?? 'analysis failed with no reason given'
    if (attempts < OK_FALSE_MAX_ATTEMPTS) {
      return retry(`${msg.file_id}: container reported failure: ${reason}`, attempts)
    }
    try {
      await deps.fail(msg.file_id, reason)
    } catch (e) {
      // [F8] Mirrors the same guard on the persist path below: the file
      // vanished (deleted) between the container's answer and this call, so
      // there is nothing left to mark failed. Retrying would just rediscover
      // NO_DATA_FOUND four more times and dump the message in the DLQ for a
      // file that no longer exists.
      if (e instanceof PostgrestError && e.code === NO_DATA_FOUND) {
        return ack(`${msg.file_id}: file disappeared before the failure could be recorded, dropping`)
      }
      // The failure must be RECORDED before the message is acked. Acking now
      // would leave the file in 'analysing' with nothing left to move it.
      return retry(`${msg.file_id}: analysis_fail: ${describe(e)}`, attempts)
    }
    return ack(`${msg.file_id}: failed after ${attempts} attempts: ${reason}`)
  }

  try {
    await deps.persist(result)
  } catch (e) {
    if (e instanceof PostgrestError && e.code === NO_DATA_FOUND) {
      return ack(`${msg.file_id}: file disappeared while analysing, dropping result`)
    }
    return retry(`${msg.file_id}: analysis_persist: ${describe(e)}`, attempts)
  }

  return ack(summarise(result))
}

/**
 * [F5] One message that `localchune-analyze` gave up on after five
 * attempts, delivered from `localchune-analyze-dlq`. Called from index.ts's
 * queue handler ONLY when `batch.queue === 'localchune-analyze-dlq'` —
 * never mixed with handleMessage() above, which is the main queue's own
 * decision table.
 *
 * Before this existed the DLQ had zero consumers: a poisoned file left no
 * trail, and its row sat in 'analysing' forever, because analysis_stuck()
 * (the stuck-job cron's query) only ever re-enqueues 'received'/'analysing'
 * rows — so the same file would be resurrected and sent to its death every
 * hour, indefinitely, with no attempt ceiling.
 *
 * The fix is the smallest one that stops the loop: call analysis_fail(),
 * which flips the row to 'failed' — terminal, visible in
 * ingest_jobs.last_error, and no longer a state analysis_stuck() returns.
 */
export async function handleDeadLetter(
  body: unknown,
  attempts: number,
  deps: Pick<Deps, 'fail'>,
): Promise<Outcome> {
  const msg = parseMessage(body)
  if (!msg) {
    // Nothing to key a failure record on. Same call as handleMessage's own
    // malformed-message guard — retrying re-delivers the same unparseable
    // body forever.
    return ack(`dead-lettered malformed message discarded: ${JSON.stringify(body)?.slice(0, 300)}`)
  }

  try {
    await deps.fail(msg.file_id, 'dead-lettered after 5 attempts')
  } catch (e) {
    // [F8, same guard] The file is already gone — nothing left to mark
    // failed, and nothing gained by retrying a delete that already happened.
    if (e instanceof PostgrestError && e.code === NO_DATA_FOUND) {
      return ack(`${msg.file_id}: no such file, dropping dead letter`)
    }
    return retry(`${msg.file_id}: analysis_fail (dead letter): ${describe(e)}`, attempts)
  }
  return ack(`${msg.file_id}: marked failed after exhausting the main queue's retries`)
}

/**
 * The one line per track that ends up in `wrangler tail`.
 *
 * Deliberately excludes beat_grid, downbeat_grid and the fingerprint: they
 * are thousands of numbers each, and a log line that long is how the one
 * line that mattered gets lost.
 */
export function summarise(r: AnalyzeResponse): string {
  return [
    `${r.file_id}: stored`,
    `${(r.duration_ms / 1000).toFixed(1)}s`,
    `${r.codec}/${r.sample_rate}Hz`,
    `bpm=${r.beats ? r.beats.bpm.toFixed(3) : 'null'}`,
    `conf=${r.beats ? r.beats.confidence.toFixed(2) : 'null'}`,
    `key=${r.key ? `${r.key.camelot} (${r.key.key} ${r.key.scale})` : 'null'}`,
    `lufs=${r.loudness ? r.loudness.integrated_lufs.toFixed(2) : 'null'}`,
    `tier=${r.forensics ? r.forensics.tier : 'null'}`,
    `cpu=${r.cpu_seconds}s`,
    `artifacts=${[r.peaks_key, r.preview_key, r.artwork_key, r.thumb_key].filter(Boolean).join(',') || 'none'}`,
    r.artifact_skipped ? `skipped=${JSON.stringify(r.artifact_skipped)}` : '',
  ].filter(Boolean).join(' ')
}
