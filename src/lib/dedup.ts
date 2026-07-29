// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The matcher — PRD §6 layers 0–2, as a pure function of three injected
 * effects.
 *
 * WHERE IT RUNS. In the analysis queue consumer, immediately after
 * analysis_persist(), and again in the maintenance Worker's hourly backstop.
 * Neither the container nor Postgres can do this job: the container holds no
 * credential by design and cannot query the database, and Postgres cannot
 * run an offset sweep without a C extension hosted Supabase will not install.
 * The consumer already holds the service_role key, the fresh fingerprint and
 * an R2 binding, so the work lands where the inputs already are.
 *
 * WHY IT LIVES IN src/lib/ RATHER THAN IN ONE WORKER. Two Workers run it —
 * workers/analysis inline, workers/maintenance hourly — and two copies of a
 * matcher is exactly how two answers to "is this the same recording?" begin
 * to disagree. Same argument ber.ts makes, same shelf. Nothing in the Astro
 * app imports it, so it is never bundled into the site.
 *
 * WHY BEST-EFFORT AT THE CALL SITE. handleMessage() acks once persist()
 * succeeds. A retry after that point calls analysis_begin(), receives
 * 'stored', and acks as "not claimable" — so the dedup would never run
 * anyway — while a retry of the whole message would re-run ~45 vCPU-s of
 * container analysis to recompute a fingerprint already in the database. So
 * a failure here is logged and acked, and dedup_pending() plus the :47 cron
 * is the guarantee. That cron is load-bearing, not decorative.
 *
 * NOTHING HERE DELETES BYTES. dedup_resolve() (migration 25) merges
 * identities and writes decisions; it does not choose a preferred encode,
 * demote a file to rejected_redundant or reclaim an R2 object. So the worst
 * outcome of a wrong auto-merge is one undo_merge() call. Keep-if-better,
 * and the reclaim path that comes with it, is Task 6.
 */
import {
  MIN_OVERLAP_FRAMES, scoreCandidate, unpackFingerprint,
} from './ber'

/**
 * The most candidates we will sweep.
 *
 * dedup_candidates()' duration-only fallback can legitimately return up to
 * 400 rows, and 400 × 2,886 frames × 161 offsets is ~185M popcounts — an
 * order of magnitude past what "score it in the consumer" was argued on
 * (M4 Task 3 measured 25 candidates at 2,886 frames in 20 ms). The fallback
 * exists to catch a pair the GIN missed, and that pair is near the top of a
 * duration-ordered list or it is not there at all.
 */
export const MAX_SWEEP_CANDIDATES = 50

/**
 * How many candidates the GIN layer is allowed to return before the
 * duration-only fallback is what produced the list. dedup_candidates()
 * clamps its own p_limit to 100; this is only used to decide whether the
 * fallback firing is worth a log line. M4 Task 4 measured 1 probe in 150
 * falling through.
 */
export const GIN_LIMIT = 25

export interface ProbeFingerprint {
  fp_compressed_b64: string
  fp_sha256: string
  algo_version: string
}

/** One row of dedup_candidates(). `via` is sha256 | gin | duration. */
export interface CandidateRow {
  candidate_file_id: string
  candidate_track_id: string | null
  fp_compressed_b64: string | null
  fp_sha256: string | null
  shared_items: number | null
  duration_delta_ms: number | null
  via?: string | null
}

/** Exactly the shape dedup_resolve() destructures. camelCase on purpose:
 *  it is a TypeScript object serialised whole into one jsonb argument. */
export interface ScoredCandidate {
  candidateFileId: string
  candidateTrackId: string | null
  layer: 'content_sha256' | 'fp_sha256' | 'ber'
  score: number
  bestOffset: number
  overlapFrames: number
  sharedItems: number | null
  durationDeltaMs: number | null
  perSecondBer: number[]
}

/** What dedup_resolve() returns. */
export interface ResolveResult {
  ok: boolean
  action: string
  reason?: string
  track_id?: string | null
  decisions?: number
  skipped?: number
  merge_ids?: number[]
  bands?: { same: number; probable: number; related: number; different: number }
}

export interface DedupDeps {
  probeFingerprint(fileId: string): Promise<ProbeFingerprint | null>
  candidates(fileId: string, contentSha256: string | null): Promise<CandidateRow[]>
  resolve(fileId: string, scored: ScoredCandidate[], algo: string): Promise<ResolveResult>
}

export interface DedupOutcome {
  ok: boolean
  action?: string
  trackId?: string | null
  scored?: number
  reason?: string
  /** Things a human should see in `wrangler tail` that are not failures. */
  warnings?: string[]
}

/**
 * Score one candidate row against an already-unpacked probe.
 *
 * Layers 0 and 0b are free answers and are taken as such:
 *
 *   via === 'sha256'  the two files are byte-identical. dedup_exact() found
 *                     them, the digest is the proof, and the candidate's
 *                     fp_compressed_b64 may legitimately be NULL (a file
 *                     whose analysis never produced a fingerprint can still
 *                     be a byte twin). Sweeping 161 offsets to rediscover
 *                     that would be work spent on a known answer.
 *   fp_sha256 equal   identical fingerprints. PRD §6 step 4's "same rip,
 *                     different tags" case, and it is free.
 */
function scoreRow(
  fileId: string, probeFrames: Uint32Array, probe: ProbeFingerprint,
  row: CandidateRow,
): ScoredCandidate {
  const base = {
    candidateFileId: row.candidate_file_id,
    candidateTrackId: row.candidate_track_id,
    sharedItems: row.shared_items ?? null,
    durationDeltaMs: row.duration_delta_ms ?? null,
  }

  if (row.via === 'sha256') {
    return {
      ...base, layer: 'content_sha256', score: 1, bestOffset: 0,
      overlapFrames: probeFrames.length, perSecondBer: [],
    }
  }
  if (row.fp_sha256 && probe.fp_sha256 && row.fp_sha256 === probe.fp_sha256) {
    return {
      ...base, layer: 'fp_sha256', score: 1, bestOffset: 0,
      overlapFrames: probeFrames.length, perSecondBer: [],
    }
  }

  const s = scoreCandidate(
    { fileId, frames: probeFrames },
    {
      fileId: row.candidate_file_id,
      trackId: row.candidate_track_id,
      frames: unpackFingerprint(row.fp_compressed_b64 ?? ''),
      // null on purpose. The ±10 s window has already been applied in SQL
      // (dedup_candidates reads fingerprints.duration_s, fpcalc's own
      // decode); re-applying it here against audio_analysis.duration_ms
      // would REJECT the production Mango pair, whose two files agree to
      // 0 s on fpcalc and disagree by 24 s on the container's header.
      durationMs: null,
    },
  )
  return {
    ...base, layer: 'ber', score: s.score, bestOffset: s.bestOffset,
    overlapFrames: s.overlapFrames, perSecondBer: s.perSecondBer,
  }
}

/**
 * Fetch, score, resolve. Never throws for a data reason — a file with no
 * fingerprint is data, not a failure — but DOES propagate a thrown effect,
 * because a database that is down must not be recorded as "no match".
 */
export async function runDedup(
  fileId: string,
  deps: DedupDeps,
  contentSha256: string | null = null,
): Promise<DedupOutcome> {
  const warnings: string[] = []

  const probe = await deps.probeFingerprint(fileId)
  if (probe === null || !probe.fp_compressed_b64) {
    // Not a failure of this job. A degraded analysis is data; it simply has
    // nothing to compare. Three pool files fail every re-analysis (M4 Task
    // 1) and this is the branch they take.
    return { ok: false, reason: `${fileId}: no fingerprint, nothing to compare` }
  }

  const probeFrames = unpackFingerprint(probe.fp_compressed_b64)
  if (probeFrames.length < MIN_OVERLAP_FRAMES) {
    // Below the minimum overlap the scorer returns 0 against EVERYTHING, so
    // this file would silently look unrelated to its own twin. Partial
    // fingerprints are demonstrably normal in this pool (the Mango pair
    // reads 1,399 frames against 2,181 for the same 272 s), which is why
    // this is a log line and not a refusal — but a probe this short is the
    // one case where the 0 means nothing at all.
    warnings.push(
      `${fileId}: probe fingerprint is ${probeFrames.length} frames, below the ` +
      `${MIN_OVERLAP_FRAMES}-frame minimum overlap — every score will be 0`,
    )
  }

  const rows = await deps.candidates(fileId, contentSha256)
  if (rows.length > GIN_LIMIT) {
    // The GIN layer is capped at dedup_config.candidate_limit (25). More
    // than that means the duration-only fallback fired, which is the
    // expensive path and worth being able to count in a tail.
    warnings.push(
      `${fileId}: ${rows.length} candidates — the duration-only fallback fired`,
    )
  }

  const scored = rows.slice(0, MAX_SWEEP_CANDIDATES).map(
    (row) => scoreRow(fileId, probeFrames, probe, row),
  )

  const short = scored.filter(
    (s) => s.layer === 'ber' && s.overlapFrames < MIN_OVERLAP_FRAMES,
  )
  if (short.length > 0) {
    warnings.push(
      `${fileId}: ${short.length} candidate(s) scored on under ` +
      `${MIN_OVERLAP_FRAMES} frames of overlap — those scores are 0 by rule, not by measurement`,
    )
  }

  // Everything above ran OUTSIDE any transaction, which is the point of PRD
  // §6's protocol: the expensive part must not hold a lock. resolve() takes
  // the advisory lock and re-checks every candidate inside it.
  const result = await deps.resolve(fileId, scored, probe.algo_version)

  return {
    ok: result.ok !== false,
    action: result.action,
    trackId: result.track_id ?? null,
    scored: scored.length,
    reason: result.reason,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

/** One line per file for `wrangler tail`. Never the fingerprint. */
export function summariseDedup(fileId: string, out: DedupOutcome): string {
  if (!out.ok && out.reason) return `${fileId}: dedup skipped — ${out.reason}`
  return `${fileId}: dedup ${out.action ?? 'unknown'} ` +
    `scored=${out.scored ?? 0} track=${out.trackId ? out.trackId.slice(0, 8) : 'none'}`
}
