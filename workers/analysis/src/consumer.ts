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

import type { DedupOutcome } from '../../../src/lib/dedup'
import { summariseDedup } from '../../../src/lib/dedup'
import type { AnalyzeResponse } from './types'
import { NO_DATA_FOUND, PostgrestError } from './supabase'

/**
 * The R2 object this message names does not exist.
 *
 * Its own class because it is the ONE analyse() failure that is terminal.
 * Everything else the Durable Object throws — an unreachable container, a
 * 5xx, a non-JSON answer — is a bad minute that a retry fixes. A missing
 * object is not: no number of retries will conjure the bytes, so the old
 * behaviour spent five full deliveries (and the DLQ round trip after them)
 * rediscovering the same 404. Four hosted rows are in exactly this state.
 */
export class R2MissingError extends Error {
  constructor(readonly r2Key: string) {
    super(`r2 miss: ${r2Key}`)
    this.name = 'R2MissingError'
  }
}

/**
 * analysis_begin()'s claim lease, in milliseconds. Duplicated from
 * migration 10 and it must stay equal to it: the dead-letter handler uses
 * it to tell a live delivery from an abandoned one, and a value SHORTER
 * than the real lease would let it fail a file that is genuinely mid
 * analysis.
 */
export const ANALYSIS_LEASE_MS = 10 * 60 * 1000

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

export interface FileState {
  state: string
  state_changed_at: string
}

export interface Deps {
  /** analysis_begin: claim the file. Returns its state after the call. */
  begin(fileId: string): Promise<string>
  /** The Durable Object. Throws on infrastructure failure only. */
  analyse(msg: AnalyzeMessage): Promise<AnalyzeResponse>
  /** analysis_persist: store the result and move the file to 'stored'. */
  persist(result: AnalyzeResponse): Promise<string>
  /** analysis_fail: terminal failure, with the reason. */
  fail(fileId: string, reason: string): Promise<string>
  /**
   * The matcher. Best-effort by construction — see runDedup's header for
   * why this can never be a retry.
   */
  dedup(fileId: string, contentSha256: string | null): Promise<DedupOutcome>
  /**
   * analysis_file_state: read the claim WITHOUT taking it. Only the
   * dead-letter handler needs it, and only so it can refuse to fail a file
   * a healthy delivery is holding.
   */
  fileState(fileId: string): Promise<FileState | null>
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
    // A MISSING OBJECT IS TERMINAL, and it is the only analyse() failure
    // that is. The bytes are not coming back: retrying spends four more
    // deliveries rediscovering the same 404, then a DLQ round trip, and the
    // row sits in 'analysing' the whole time so the :31 cron re-enqueues it
    // and the cycle starts again. Failing it now stops that at the first
    // delivery AND takes the row out of analysis_stuck()'s query, which is
    // what actually ends the loop — 'failed' is not a state it returns.
    if (e instanceof R2MissingError) {
      try {
        await deps.fail(msg.file_id, `r2 object missing: ${msg.r2_key}`)
      } catch (fe) {
        if (fe instanceof PostgrestError && fe.code === NO_DATA_FOUND) {
          return ack(`${msg.file_id}: no such file, dropping`)
        }
        // The failure must be RECORDED before the message is acked, or the
        // row is left in 'analysing' with nothing to move it.
        return retry(`${msg.file_id}: analysis_fail (r2 miss): ${describe(fe)}`, attempts)
      }
      return ack(`${msg.file_id}: r2 object ${msg.r2_key} is gone — marked failed, not retried`)
    }
    // Everything else the DO throws is infrastructure: an unreachable
    // container, a non-JSON or 5xx answer from /analyze. All retryable.
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

  // Dedup, best-effort, and it can NEVER be a retry. A redelivery would
  // call analysis_begin(), receive 'stored', and ack as "not claimable" —
  // so the dedup still would not run — while having re-run ~45 vCPU-s of
  // container analysis to recompute a fingerprint that is already in the
  // database. dedup_pending() plus the maintenance Worker's :47 cron is
  // what recovers this file, within the hour.
  //
  // The digest is passed from the response we just persisted. It has to be:
  // files.content_sha256 is UNIQUE and analysis_persist() leaves the SECOND
  // of two byte-identical files NULL rather than raising 23505, so the
  // probe row cannot find its own twin and layer 0 only fires on an
  // argument.
  let dedupLine: string
  try {
    const d = await deps.dedup(msg.file_id, result.content_sha256 || null)
    for (const w of d.warnings ?? []) console.warn(w)
    dedupLine = summariseDedup(msg.file_id, d)
  } catch (e) {
    // console.ERROR, not warn. This catch is the whole reason a dead
    // matcher can run for a day without anyone noticing: the message still
    // acks, the file is still 'stored', the pool still grows, and the only
    // trace was a warn line among a thousand. If this fires the cron is now
    // the only thing that will ever match this file, which is worth an
    // error even though it is not a failure of THIS message.
    dedupLine = `${msg.file_id}: DEDUP FAILED, deferred to the :47 cron: ${describe(e)}`
    console.error(dedupLine)
  }

  return ack(`${summarise(result)} | ${dedupLine}`)
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
 *
 * [M4.5] AND IT MUST LOOK BEFORE IT FAILS. Queues is at-least-once and the
 * :31 cron is a second producer, so a dead letter can be delivered for a
 * file that has SINCE been re-enqueued and is either finished or mid
 * analysis on a healthy delivery. Failing it then marks a working file
 * failed, drops it out of the pool, and strands the analysis that was about
 * to succeed — analysis_persist() accepts received/analysing/stored as
 * source states and 'failed' is none of them, so the good result cannot even
 * be stored. Two states are therefore refused:
 *
 *   anything terminal or finished  the state machine has already answered
 *     this file. 'stored' is the dangerous one: a dead letter arriving a
 *     minute after a successful re-run would otherwise undo it.
 *   'analysing' inside the lease   another delivery holds the claim, exactly
 *     as analysis_begin() defines it (migration 10, 10 minutes). Past the
 *     lease the claim is abandoned and failing it is right.
 *
 * Refusing is an ACK, never a retry: the dead letter has done its job the
 * moment it establishes that something else owns the file.
 */
export async function handleDeadLetter(
  body: unknown,
  attempts: number,
  deps: Pick<Deps, 'fail' | 'fileState'>,
  now: number = Date.now(),
): Promise<Outcome> {
  const msg = parseMessage(body)
  if (!msg) {
    // Nothing to key a failure record on. Same call as handleMessage's own
    // malformed-message guard — retrying re-delivers the same unparseable
    // body forever.
    return ack(`dead-lettered malformed message discarded: ${JSON.stringify(body)?.slice(0, 300)}`)
  }

  let live: FileState | null
  try {
    live = await deps.fileState(msg.file_id)
  } catch (e) {
    // Not knowing the state is not permission to guess it. Retry — the DLQ
    // consumer has its own three attempts and no sink beyond them, so the
    // worst case is a dropped dead letter and a row the :31 cron picks up.
    return retry(`${msg.file_id}: analysis_file_state (dead letter): ${describe(e)}`, attempts)
  }

  if (live === null) {
    return ack(`${msg.file_id}: no such file, dropping dead letter`)
  }
  if (live.state !== 'received' && live.state !== 'analysing') {
    return ack(
      `${msg.file_id}: state is '${live.state}' — the state machine has already ` +
      'answered this file; not marking it failed',
    )
  }
  if (live.state === 'analysing'
      && now - Date.parse(live.state_changed_at) < ANALYSIS_LEASE_MS) {
    return ack(
      `${msg.file_id}: another delivery holds the claim (lease taken ` +
      `${live.state_changed_at}); not marking it failed`,
    )
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
    // The two forensic numbers worth reading in a tail: what the verdict was
    // and what bandwidth it was read off. Without them a wrong tier tells you
    // nothing about which of the two inputs was wrong.
    `ancestor=${r.forensics ? r.forensics.lossy_ancestor : 'null'}`,
    `cutoff=${r.forensics ? r.forensics.meas_cutoff_hz : 'null'}Hz`,
    // Presence, not the digest: 64 hex characters per track would bury the
    // rest of the line, and the only question a tail answers here is whether
    // layer 0 has an input at all.
    `sha=${r.content_sha256 ? r.content_sha256.slice(0, 8) : 'none'}`,
    `cpu=${r.cpu_seconds}s`,
    `artifacts=${[r.peaks_key, r.preview_key, r.artwork_key].filter(Boolean).join(',') || 'none'}`,
    r.artifact_skipped ? `skipped=${JSON.stringify(r.artifact_skipped)}` : '',
  ].filter(Boolean).join(' ')
}
