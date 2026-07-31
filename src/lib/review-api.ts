// src/lib/review-api.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The review queue's pure half. Nothing here touches the DOM or the
// network, so it is unit-testable under the node environment — the same
// rule pool-api.ts states for itself.
//
// Everything in this file is total. A hand-edited or stale URL degrades to
// a weaker filter rather than a 422, because a reviewer who has just been
// handed a broken link should still see the queue.

export const REVIEW_STATUSES = ['pending', 'resolved', 'all'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]
export const DEFAULT_STATUS: ReviewStatus = 'pending'
export const REVIEW_PAGE_SIZE = 50
export const MERGES_PAGE_SIZE = 50

export type Thresholds = { t_same: number; t_probable: number; t_related: number }

/** One row of review_queue(). Column names are the RPC's, verbatim. */
export interface ReviewPair {
  decision_id: number
  score: number
  band: string
  layer: string
  shared_items: number | null
  overlap_frames: number | null
  duration_delta_ms: number | null
  per_second_ber: number[] | null
  decided_at: string
  probe_file_id: string
  probe_artist: string | null
  probe_title: string | null
  probe_filename: string
  probe_uploader: string | null
  probe_tier: number | null
  probe_container: string | null
  probe_duration_ms: number | null
  probe_kbps: number | null
  probe_preview_key: string | null
  cand_file_id: string
  cand_artist: string | null
  cand_title: string | null
  cand_filename: string
  cand_uploader: string | null
  cand_tier: number | null
  cand_container: string | null
  cand_duration_ms: number | null
  cand_kbps: number | null
  cand_preview_key: string | null
  verdict: string | null
  reviewed_at: string | null
}

/** One row of recent_merges(). */
export interface MergeRow {
  merge_id: number
  performed_at: string
  performed_by: string
  performer_name: string | null
  is_auto: boolean
  undone_at: string | null
  undone_by_name: string | null
  decision_id: number | null
  score: number | null
  layer: string | null
  band: string | null
  winner_track_id: string
  winner_file_id: string | null
  winner_artist: string | null
  winner_title: string | null
  winner_tier: number | null
  winner_container: string | null
  loser_track_id: string
  loser_file_id: string | null
  loser_artist: string | null
  loser_title: string | null
  loser_tier: number | null
  loser_container: string | null
  moved_files: number
  reclaimed_files: number
}

/**
 * Which band a score falls in, given the thresholds THAT DECISION USED.
 *
 * The thresholds argument is not a convenience. They live in dedup_config
 * precisely so a recalibration is an UPDATE rather than a deploy, and every
 * match_decisions row carries a copy of the numbers it was judged against.
 * A hardcoded 0.9 here would quietly put them back in code and make a
 * historical decision unexplainable the first time they moved.
 */
export function bandFor(score: number, t: Thresholds): string {
  if (!Number.isFinite(score)) return 'different'
  if (score >= t.t_same) return 'same'
  if (score >= t.t_probable) return 'probable'
  if (score >= t.t_related) return 'related'
  return 'different'
}

/**
 * Where two recordings stop agreeing, in seconds, backed off by `leadIn`.
 *
 * PRD §6 asks for snippets "taken at the point of maximum divergence".
 * Starting both players at 0:00 makes the reviewer listen to the part that
 * matches, which is the one part that carries no information. Dropping them
 * exactly ON the difference is nearly as bad — they hear its second half —
 * so the default backs off two seconds and lets the difference arrive.
 */
export function divergencePeakSecond(
  ber: readonly number[] | null | undefined,
  opts: { leadIn?: number } = {},
): number {
  if (!ber || ber.length === 0) return 0
  const leadIn = Math.max(opts.leadIn ?? 0, 0)
  let peak = 0
  let best = -Infinity
  for (let s = 0; s < ber.length; s += 1) {
    const v = ber[s]
    if (Number.isFinite(v) && v > best) {
      best = v
      peak = s
    }
  }
  // A strip that never diverges has no interesting second. Opening at the
  // arbitrary index of the first zero would look deliberate and be noise.
  if (!(best > 0)) return 0
  return Math.max(peak - leadIn, 0)
}

/** The queue's one filter. Anything unrecognised falls back to pending. */
export function parseReviewQuery(sp: URLSearchParams): ReviewStatus {
  const raw = sp.get('status')
  return (REVIEW_STATUSES as readonly string[]).includes(raw ?? '')
    ? (raw as ReviewStatus)
    : DEFAULT_STATUS
}

export function reviewHref(status: ReviewStatus): string {
  return status === DEFAULT_STATUS ? '/review' : `/review?status=${status}`
}

/**
 * A signed duration delta, in whole seconds, as a reviewer reads it.
 * "+3s" / "-2m 04s" / "same length". The sign is load-bearing: it says
 * which side is longer, which is often the whole story on an edit.
 */
export function formatDelta(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown'
  const rounded = Math.round(ms / 1000)
  if (rounded === 0) return 'same length'
  const sign = rounded < 0 ? '-' : '+'
  const abs = Math.abs(rounded)
  const m = Math.floor(abs / 60)
  const s = abs % 60
  return m > 0 ? `${sign}${m}m ${String(s).padStart(2, '0')}s` : `${sign}${abs}s`
}

/** mm:ss, or an em dash when the analysis never produced a duration. */
export function formatLength(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** A score as a reviewer reads it: three decimals, never rounded to 1.00. */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '—'
  return score.toFixed(3)
}

/**
 * The height of one divergence bar, as a percentage of the strip.
 *
 * Clamped at 0.5 BER — above half the bits differing the two are simply
 * unrelated and the extra height carries nothing. Doubling the clamped
 * value maps that ceiling onto a full-height bar.
 */
export function barHeightPct(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return 2
  return Math.max(Math.round(Math.min(v, 0.5) * 200), 2)
}
