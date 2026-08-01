// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The Durable Object that fronts the analysis container, and the queue
// consumer that drives it.
//
// Shape of it: a Cloudflare container is only reachable through its Durable
// Object. The DO holds the R2 binding, so every credential-bearing operation
// happens on THIS side of the boundary. The container is handed bytes and
// gives back JSON — it never sees a presigned URL, a bearer token or an S3
// key.
//
// There is no `fetch` handler and no route. Task 8's token-guarded one, used
// to measure the deployed container by hand, is gone: the queue is the entry
// point now, and an unreachable Worker with an R2 binding and a service_role
// key should have no HTTP surface at all.

import { Container } from '@cloudflare/containers'
import { runDedup } from '../../../src/lib/dedup'
import { makeDedupDeps } from '../../../src/lib/dedup-rpc'
import {
  handleDeadLetter, handleMessage, R2MissingError, type AnalyzeMessage,
} from './consumer'
import { analysisBegin, analysisFail, analysisFileState, analysisPersist, rpc } from './supabase'
import type { AnalyzeResponse } from './types'

/**
 * [F5] The dead-letter queue name, as configured in this file's
 * `queues.consumers` (wrangler.jsonc) and as the target of
 * `dead_letter_queue` on the main `localchune-analyze` consumer. Named here
 * rather than read off `batch.queue` unconditionally, so a batch from any
 * OTHER queue this Worker might one day consume fails loud instead of
 * silently running the wrong decision table.
 */
const DLQ_NAME = 'localchune-analyze-dlq'

export type {
  AnalyzeResponse, Beats, Fingerprint, Forensics, Key, Loudness,
} from './types'

export interface Env {
  ANALYSIS: DurableObjectNamespace<AnalysisContainer>
  AUDIO: R2Bucket
  /** Public thumbs-only bucket (art.butternutcrack.com) — spec 2026-08-01-art-bucket-split. */
  ART: R2Bucket
  /**
   * The second legitimate service_role key in the project, for the same
   * reason as the maintenance Worker's: this Worker is route-less, is driven
   * by a queue, and has no user session to bind a cookie client to. See
   * supabase.ts and CLAUDE.md.
   */
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
}

export class AnalysisContainer extends Container<Env> {
  defaultPort = 8080

  // 30s, NOT the 10-minute default. Memory bills for every second the
  // instance is awake, so the default is the single easiest way to turn a
  // $0.00 month into a ~$0.73 one for doing exactly the same work.
  sleepAfter = '30s'

  // v2 = M4 Task 1: a real Forensics verdict and content_sha256. The three
  // copies of this string (here, src/lib/analyze-queue.ts and the
  // maintenance Worker's cron) must move together — a mismatch means a
  // backfill silently re-stores under the old version and nothing says so.
  // This one only reaches /healthz; the two producers are what travel in the
  // queue message and end up in audio_analysis.analysis_version.
  envVars = { ANALYSIS_VERSION: 'v2' }

  override onStart() {
    console.log('container started')
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.log('container stopped', JSON.stringify(params))
  }

  override onError(e: unknown) {
    console.error('container error', e instanceof Error ? e.stack : String(e))
    return e
  }

  /**
   * Put one derived artifact into R2.
   *
   * Buffered, deliberately, and this is the second attempt.
   *
   * `env.AUDIO.put(key, response.body)` — the obvious line, and the brief's —
   * throws on the real platform:
   *
   *   TypeError: Provided readable stream must have a known length
   *   (request/response body or readable half of FixedLengthStream)
   *
   * R2 must declare Content-Length before it starts writing, and a body
   * arriving from the container is a plain chunked stream. Neither failure
   * here is reachable before an analysis SUCCEEDS and produces an artifact to
   * drain, so both are deploy-only.
   *
   * The streaming fix — pipe through `new FixedLengthStream(contentLength)`,
   * start the pipe before awaiting `put` — was written, deployed and measured,
   * and it HUNG: the Durable Object invocation sat until the client gave up at
   * 900s and the platform logged it Canceled. The likely cause is a mismatch
   * between the Content-Length the container declares and what the proxy
   * actually delivers; R2 waits for the byte count it was promised, and a
   * short stream waits forever rather than erroring. Do not "restore" it
   * without reproducing that.
   *
   * Buffering is safe ONLY because it is now gated on Content-Length below.
   * peaks.json and the Opus preview are bounded by construction (~41 KB and
   * ~14 MB respectively — see the ceilings), but embedded cover art is
   * copied verbatim by worker/app/tags.py's extract_artwork from whatever
   * attached-picture stream the source file has, with no size limit of its
   * own upstream of Task 8's fix there. A crafted FLAC with a multi-hundred-
   * MB "cover art" block and trivial audio would otherwise be buffered whole
   * into this isolate's 128 MB. FastAPI's `FileResponse` (used by
   * GET /artifact/{file_id}/{name}) always sets Content-Length, so its
   * absence is itself treated as unsafe to buffer.
   *
   * Returns a skip reason string if the artifact was NOT written (missing or
   * oversized Content-Length), or null on success. Never throws for a size
   * problem — a missing cover must never fail an analysis.
   */
  // Per-artifact Content-Length ceilings enforced by putArtifact() below —
  // the actual guard against the OOM this whole mechanism exists to prevent.
  private static readonly MAX_ARTWORK_BYTES = 20 * 1024 * 1024 // uncapped at the source; this IS the backstop
  private static readonly MAX_PREVIEW_BYTES = 20 * 1024 * 1024 // ~14 MB at the 15-min/128kbps cap; headroom, not the expected size
  private static readonly MAX_PEAKS_BYTES = 1 * 1024 * 1024 // ~41 KB by construction (1000 buckets); generous headroom

  private async putArtifact(
    key: string, res: Response, maxBytes: number, bucket?: R2Bucket, meta?: R2PutOptions,
  ): Promise<string | null> {
    const declared = res.headers.get('content-length')
    const len = declared === null ? NaN : Number(declared)
    if (!Number.isFinite(len) || len > maxBytes) {
      const reason = declared === null
        ? 'missing_content_length'
        : `too_large: ${len}B > ${maxBytes}B ceiling`
      console.warn(`artifact ${key} skipped: ${reason}`)
      return reason
    }
    const body = await res.arrayBuffer()
    console.log(`artifact ${key} ${body.byteLength}B`)
    await (bucket ?? this.env.AUDIO).put(key, body, meta)
    return null
  }

  /**
   * Stream R2 -> container, analyse, drain artifacts back to R2, clean up.
   *
   * Throws on infrastructure failure (R2 miss, container unreachable). A
   * FAILED ANALYSIS IS NOT AN EXCEPTION: the container answers `ok:false`
   * with a reason and that object is returned as-is, because only the queue
   * consumer knows the retry budget.
   */
  async analyse(fileId: string, r2Key: string, version: string): Promise<AnalyzeResponse> {
    const obj = await this.env.AUDIO.get(r2Key)
    // Its own error type, because the consumer treats it as terminal and
    // every other throw in this method as retryable. See R2MissingError.
    if (!obj) throw new R2MissingError(r2Key)

    // Streamed, never buffered — a 15-minute FLAC is ~150 MB and a Worker
    // has 128 MB of memory to play with.
    const put = await this.containerFetch(`http://c/file/${fileId}`, {
      method: 'PUT',
      body: obj.body,
    })
    if (!put.ok) throw new Error(`upload to container failed: ${put.status}`)

    try {
      const res = await this.containerFetch(`http://c/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, analysis_version: version }),
      })
      if (!res.ok) throw new Error(`analyze ${res.status}: ${await res.text()}`)
      const out = (await res.json()) as AnalyzeResponse

      const artifactSkipped: Record<string, string> = {}
      const artifacts: Array<{
        kind: string
        name: string | null | undefined
        maxBytes: number
        bucket?: R2Bucket
        meta?: R2PutOptions
        clear: () => void
      }> = [
        { kind: 'peaks', name: out.peaks_key, maxBytes: AnalysisContainer.MAX_PEAKS_BYTES,
          clear: () => { out.peaks_key = null } },
        { kind: 'preview', name: out.preview_key, maxBytes: AnalysisContainer.MAX_PREVIEW_BYTES,
          clear: () => { out.preview_key = null } },
        { kind: 'artwork', name: out.artwork_key, maxBytes: AnalysisContainer.MAX_ARTWORK_BYTES,
          clear: () => { out.artwork_key = null } },
        // The 64px cover thumb the pool table renders (brutalist spec §4).
        // A 64px q~70 JPEG is a few KB; the artwork ceiling is generous.
        // Thumbs alone land in the PUBLIC art bucket (spec:
        // 2026-08-01-art-bucket-split) with immutable cache metadata —
        // rows load them straight off art.butternutcrack.com, no Worker,
        // no signing. Audio and full artwork never take this fork.
        { kind: 'thumb', name: out.thumb_key, maxBytes: AnalysisContainer.MAX_ARTWORK_BYTES,
          bucket: this.env.ART,
          meta: { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } },
          clear: () => { out.thumb_key = null } },
        // spectrogram_key is always null today — see the Forensics field
        // comment in types.ts; nothing in app/ produces one yet — but the
        // ceiling is wired up now so whoever adds a producer does not
        // silently reopen this OOM path.
        { kind: 'spectrogram', name: out.forensics?.spectrogram_key, maxBytes: AnalysisContainer.MAX_ARTWORK_BYTES,
          clear: () => { if (out.forensics) out.forensics.spectrogram_key = null } },
      ]

      for (const { kind, name, maxBytes, bucket, meta, clear } of artifacts) {
        if (!name) continue
        const a = await this.containerFetch(`http://c/artifact/${fileId}/${name}`)
        if (!a.ok || !a.body) {
          console.warn(`artifact ${name} not retrievable: ${a.status}`)
          continue
        }
        const skipReason = await this.putArtifact(`derived/${fileId}/${name}`, a, maxBytes, bucket, meta)
        if (skipReason) {
          artifactSkipped[kind] = skipReason
          clear()
        }
      }
      if (Object.keys(artifactSkipped).length > 0) {
        out.artifact_skipped = artifactSkipped
      }
      return out
    } finally {
      // Disk is ephemeral but the INSTANCE is reused across tracks, so a leak
      // here fills 6 GB after ~40 files and every later run fails on write.
      // Swallowed deliberately: a cleanup failure must not mask the real
      // error that sent us into this finally block.
      try {
        await this.containerFetch(`http://c/file/${fileId}`, { method: 'DELETE' })
      } catch (e) {
        console.warn('cleanup failed', fileId, e)
      }
    }
  }
}

/**
 * Instance pool. Containers are addressed by DO name, so the name IS the
 * routing decision: a fresh name per file would cold-start an image on every
 * single track, and one shared name would serialise a backfill through a
 * single box. POOL is kept below `max_instances` (12, wrangler.jsonc) so a
 * burst can never trip the limit — `max_instances` ERRORS when exceeded, it
 * does not queue.
 *
 * Hashing the file id rather than picking at random also gives a retry the
 * SAME instance, which is warm and already holds the model. Idempotency does
 * not depend on that — it is enforced by analysis_persist()'s upsert on
 * file_id — and a pool collision serialises on the container's own
 * asyncio.Lock instead of doubling RSS.
 *
 * 8, raised from 4 on 2026-07-29 for M4's backfill: every file in the pool
 * has to be re-analysed at ~45 vCPU-s each, and four at a time made that a
 * multi-hour wall-clock job. Horizontal only — the instance stays at
 * 1 vCPU / 3 GiB, because Essentia and Beat-This are both single-threaded
 * here (see worker/Dockerfile's thread pins) and a second vCPU per box would
 * bill for a core nothing runs on.
 */
const POOL = 8

export function containerFor(env: Env, fileId: string) {
  let h = 0
  for (let i = 0; i < fileId.length; i++) h = (h * 31 + fileId.charCodeAt(i)) | 0
  return env.ANALYSIS.getByName(`pool-${Math.abs(h) % POOL}`)
}

export default {
  /**
   * One message, one track. `max_batch_size: 1` in wrangler.jsonc is
   * load-bearing: a batch retry re-delivers EVERY message in the batch, so
   * one poisoned file would re-run its neighbours — at ~55 vCPU-s each.
   *
   * The 30 s CPU limit is not the constraint it looks like. A queue consumer
   * invocation gets 15 minutes of wall clock; 30 s is CPU. From here the
   * ~55 s job is entirely I/O-wait on the DO, which costs ~0 ms of Worker
   * CPU. Do not raise `limits.cpu_ms` to "be safe" — if this Worker ever
   * approaches 30 s of CPU, something is deserialising audio in the Worker
   * and that is the bug.
   *
   * handleMessage() never throws, so one bad message can never abandon the
   * rest of a batch un-acked.
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // [F5] The DLQ consumer. A batch delivered from localchune-analyze-dlq
    // never touches the container or handleMessage()'s decision table — its
    // only job is analysis_fail(), so the row stops lying about being
    // 'analysing' and the stuck-job cron stops resurrecting it forever.
    if (batch.queue === DLQ_NAME) {
      for (const m of batch.messages) {
        const outcome = await handleDeadLetter(m.body, m.attempts, {
          fail: (fileId, reason) => analysisFail(env, fileId, reason),
          fileState: (fileId) => analysisFileState(env, fileId),
        })
        if (outcome.action === 'ack') {
          console.log(`[dlq] ${outcome.reason}`)
          m.ack()
        } else {
          console.error(`[dlq] retry in ${outcome.delaySeconds}s — ${outcome.reason}`)
          m.retry({ delaySeconds: outcome.delaySeconds })
        }
      }
      return
    }

    // One per invocation, not one per message: max_batch_size is 1, and the
    // deps close over nothing but `env`.
    const dedupDeps = makeDedupDeps(
      <T,>(fn: string, args: Record<string, unknown>) => rpc<T>(env, fn, args))

    for (const m of batch.messages) {
      const outcome = await handleMessage(m.body, m.attempts, {
        begin: (fileId) => analysisBegin(env, fileId),
        analyse: (msg: AnalyzeMessage) =>
          containerFor(env, msg.file_id).analyse(msg.file_id, msg.r2_key, msg.analysis_version),
        persist: (result) => analysisPersist(env, result),
        fail: (fileId, reason) => analysisFail(env, fileId, reason),
        dedup: (fileId, sha) => runDedup(fileId, dedupDeps, sha),
        fileState: (fileId) => analysisFileState(env, fileId),
      })

      if (outcome.action === 'ack') {
        console.log(outcome.reason)
        m.ack()
      } else {
        console.error(`retry in ${outcome.delaySeconds}s — ${outcome.reason}`)
        m.retry({ delaySeconds: outcome.delaySeconds })
      }
    }
  },
} satisfies ExportedHandler<Env>
