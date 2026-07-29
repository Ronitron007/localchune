// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Mirrors app/models.py:AnalyzeResponse, field for field.
 *
 * In its own module, with no runtime imports, so the queue consumer and its
 * unit tests can use these types without pulling `@cloudflare/containers`
 * (and through it the workerd-only Container base class) into a plain Node
 * test run. index.ts re-exports everything here, so existing importers are
 * unaffected.
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
  /**
   * The three quality_score() inputs the container used to compute and then
   * throw away (M4 Task 4, concern 2). is_upgrade() needs all ten of them;
   * without these, anything rebuilding the score from audio_analysis scores
   * with neutral defaults and loses the fake-FLAC branch.
   *
   * Optional in TypeScript because an OLD image is still answering for the
   * minutes a container rollout takes. analysis_persist() derives all three
   * from the rest of the response when they are absent — migration 25.
   */
  lame_disagrees?: boolean
  mono_vs_stereo?: boolean
  decode_errors?: boolean
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
  // REAL as of M4 Task 1 (analysis_version v2). It was null on every row
  // through M3, because classify_ancestor() needed an hf_ref_delta_db and
  // Forensics needed a MEASURED effective bit depth and nothing produced
  // either. Still nullable, and that is not vestigial: a v1 row persisted
  // before the backfill has none, and analysis_persist() stores that as
  // NULLs rather than inventing a quality tier.
  forensics: Forensics | null
  tags: Record<string, string>
  peaks_key: string | null
  preview_key: string | null
  artwork_key: string | null
  thumb_key: string | null
  /**
   * PRD §6 layer 0, as 64 lower-case hex characters — sha256 over the raw
   * uploaded bytes, taken in the container because it is the only place that
   * already holds the whole file on local disk.
   *
   * A STRING, not `string | null`: app/models.py defaults it to '', and ''
   * is exactly what analysis_persist() checks for before touching
   * files.content_sha256. The distinction is load-bearing — the column is
   * UNIQUE, and `decode('', 'hex')` is a valid EMPTY bytea, so two rows that
   * both sent '' would collide on it for a reason that has nothing to do
   * with their audio.
   */
  content_sha256: string
  cpu_seconds: number
  /**
   * DO-side only — app/models.py has no such field, so this is never present
   * in the container's JSON. Populated after the fact, when `putArtifact`
   * skips a derived artifact because its Content-Length was missing or over
   * the per-artifact ceiling. Keyed by artifact kind ('peaks' | 'preview' |
   * 'artwork' | 'thumb' | 'spectrogram'), valued by the skip reason. The corresponding
   * `*_key` is nulled out in the same pass, so a skipped artifact never
   * points at an R2 object that was never written.
   */
  artifact_skipped?: Record<string, string>
}
