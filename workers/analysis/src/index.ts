// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The Durable Object that fronts the analysis container.
//
// Shape of it: a Cloudflare container is only reachable through its Durable
// Object. The DO holds the R2 binding, so every credential-bearing operation
// happens on THIS side of the boundary. The container is handed bytes and
// gives back JSON — it never sees a presigned URL, a bearer token or an S3
// key. Task 9 adds the `queue` handler to this same file.

import { Container } from '@cloudflare/containers'

export interface Env {
  ANALYSIS: DurableObjectNamespace<AnalysisContainer>
  AUDIO: R2Bucket
  /**
   * Set ONLY while measuring a deployed container by hand (Task 8, Step 6).
   * Absent in normal operation, and the Worker has no workers.dev subdomain
   * and no route, so there is nothing to reach even when it is set.
   */
  ANALYSIS_TEST_TOKEN?: string
}

/**
 * Mirrors app/models.py:AnalyzeResponse, field for field.
 *
 * Spelled out in full ON PURPOSE, with no `[k: string]: unknown` catch-all:
 * Workers RPC only accepts structurally serializable return types, and a
 * single `unknown` member makes the whole type unserializable — at which
 * point `Rpc.Result<T>` collapses to `never`, `await stub.analyse(...)`
 * silently yields `never`, and every downstream type error disappears
 * instead of being caught. `astro check` flags it as ts(80007) "'await' has
 * no effect on the type of this expression"; that hint is the symptom.
 */
export interface Fingerprint {
  algo_version: string
  duration_s: number
  frame_count: number
  fp_compressed_b64: string
  fp_sha256: string
  query_items: number[]
}

export interface Beats {
  bpm: number
  bpm_median_ibi: number
  beat_count: number
  ibi_std_ms: number
  beat_grid: number[]
  downbeat_grid: number[]
  confidence: number
}

export interface Key {
  key: string
  scale: 'major' | 'minor'
  camelot: string
  open_key: string
  strength: number
  alt_profiles: Record<string, string>
}

export interface Loudness {
  integrated_lufs: number
  lra_lu: number
  true_peak_dbtp: number
  replaygain_db: number
  clipped_pct: number
}

export interface Forensics {
  meas_cutoff_hz: number
  meas_cliff_db_500: number
  meas_eff_bit_depth: number
  meas_eff_sample_rate: number
  lame_tag_present: boolean
  lame_lowpass_hz: number | null
  lame_vbr_method: string | null
  encoder_string: string | null
  lossy_ancestor: 'none' | 'suspected' | 'confirmed' | 'abstain'
  inferred_source_kbps: number | null
  tier: number
  quality_score: number
  spectrogram_key: string | null
}

export interface AnalyzeResponse {
  file_id: string
  analysis_version: string
  ok: boolean
  error: string | null
  duration_ms: number
  container: string
  codec: string
  sample_rate: number
  bit_depth: number
  channels: number
  fingerprint: Fingerprint | null
  beats: Beats | null
  key: Key | null
  loudness: Loudness | null
  // Always null today: the container measures cutoff/cliff and LOGS them, but
  // synthesises no verdict because nothing produces hf_ref_delta_db or a
  // measured effective bit depth. See app/main.py.
  forensics: Forensics | null
  tags: Record<string, string>
  peaks_key: string | null
  preview_key: string | null
  artwork_key: string | null
  cpu_seconds: number
}

export class AnalysisContainer extends Container<Env> {
  defaultPort = 8080

  // 30s, NOT the 10-minute default. Memory bills for every second the
  // instance is awake, so the default is the single easiest way to turn a
  // $0.00 month into a ~$0.73 one for doing exactly the same work.
  sleepAfter = '30s'

  envVars = { ANALYSIS_VERSION: 'v1' }

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
   * TEMPORARY — Task 8 verification only. Boots the container and reports
   * what the REAL binaries on the REAL platform say about themselves, so the
   * assumptions Tasks 4-7 baked in (Essentia's nested key JSON, fpcalc's
   * version string, ffmpeg's version) are checked on amd64 rather than on
   * the M1 or under emulation. Delete with the `fetch` handler when Task 9
   * lands the queue consumer.
   */
  async ping(): Promise<Record<string, string | number>> {
    const c = this.ctx.container
    if (!c) throw new Error('no container binding on this DO')
    if (!c.running) await this.start()
    const health = await this.containerFetch('http://c/healthz')
    const dec = new TextDecoder()
    const out: Record<string, string | number> = {
      healthz: await health.text(),
      status: health.status,
    }
    const probes: Record<string, string[]> = {
      uname: ['uname', '-m'],
      nproc: ['nproc'],
      ffmpeg: ['sh', '-c', 'ffmpeg -version 2>&1 | head -1'],
      fpcalc: ['sh', '-c', 'fpcalc -version 2>&1 | head -1'],
      essentia: ['sh', '-c', 'streaming_extractor_music 2>&1 | head -6'],
      cgroup_mem: ['sh', '-c', 'cat /sys/fs/cgroup/memory.max 2>/dev/null || echo n/a'],
      torch: ['python', '-c', 'import torch;print(torch.__version__, torch.get_num_threads())'],
    }
    for (const [name, cmd] of Object.entries(probes)) {
      try {
        const p = await c.exec(cmd, { stderr: 'combined' })
        const o = await p.output()
        out[name] = dec.decode(o.stdout).trim()
      } catch (e) {
        out[name] = `EXEC FAILED: ${e}`
      }
    }
    return out
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
   * Buffering is safe at the sizes involved and the sizes are known, not
   * hoped for: peaks.json is ~41 KB by construction (1000 buckets), artwork is
   * one embedded cover, and the 128 kbps Opus preview of the longest
   * permitted track (15 min, enforced by MAX_DURATION_MS) is ~14 MB, against a
   * Worker's 128 MB. The one artifact that could break this rule is a future
   * spectrogram PNG; whoever adds it owns re-testing this path.
   */
  private async putArtifact(key: string, res: Response): Promise<void> {
    const body = await res.arrayBuffer()
    console.log(`artifact ${key} ${body.byteLength}B`)
    await this.env.AUDIO.put(key, body)
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
    if (!obj) throw new Error(`r2 miss: ${r2Key}`)

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

      for (const name of [
        out.peaks_key,
        out.preview_key,
        out.artwork_key,
        out.forensics?.spectrogram_key,
      ]) {
        if (!name) continue
        const a = await this.containerFetch(`http://c/artifact/${fileId}/${name}`)
        if (!a.ok || !a.body) {
          console.warn(`artifact ${name} not retrievable: ${a.status}`)
          continue
        }
        await this.putArtifact(`derived/${fileId}/${name}`, a)
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
 * single box. POOL is kept below `max_instances` (8) so a burst can never
 * trip the limit — `max_instances` ERRORS when exceeded, it does not queue.
 */
const POOL = 4

export function containerFor(env: Env, fileId: string) {
  let h = 0
  for (let i = 0; i < fileId.length; i++) h = (h * 31 + fileId.charCodeAt(i)) | 0
  return env.ANALYSIS.getByName(`pool-${Math.abs(h) % POOL}`)
}

export default {
  /**
   * Manual verification only, and inert unless ANALYSIS_TEST_TOKEN is set as
   * a secret. There is no route and no workers.dev subdomain on this Worker
   * in the committed configuration (see wrangler.jsonc), so this handler is
   * unreachable as deployed; the token is the second lock, not the first.
   * Task 9 replaces this entry point with the real `queue` consumer.
   *
   * Split into short actions on purpose. A cold container has to pull a
   * ~2.5 GB image and warm a model before it answers anything, and a
   * 6-minute track then costs tens of seconds — one request that did all of
   * that would sit far past the edge's patience. `ping` pays the cold start,
   * `analyse` measures a warm run.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const expected = env.ANALYSIS_TEST_TOKEN
    if (!expected) return new Response('not found', { status: 404 })
    if (request.headers.get('authorization') !== `Bearer ${expected}`) {
      return new Response('not found', { status: 404 })
    }

    const url = new URL(request.url)
    const action = url.searchParams.get('action') ?? 'analyse'
    const fileId = url.searchParams.get('file_id') ?? 'probe'
    const stub = containerFor(env, fileId)
    const t0 = Date.now()

    if (action === 'ping') {
      const res = await stub.ping()
      return Response.json({ wall_ms: Date.now() - t0, ...res })
    }

    const r2Key = url.searchParams.get('r2_key')
    if (!r2Key) return new Response('need ?r2_key=', { status: 400 })
    const out = await stub.analyse(
      fileId,
      r2Key,
      url.searchParams.get('version') ?? 'v1',
    )
    return Response.json({ wall_ms: Date.now() - t0, result: out })
  },
}
