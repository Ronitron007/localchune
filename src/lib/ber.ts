// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Chromaprint fingerprint comparison — PRD §6 layer 2.
 *
 * Pure: two Uint32Arrays in, a score out. No fetch, no Supabase, no DOM, so
 * it runs identically in the analysis consumer, in the maintenance
 * backstop, and under Vitest's node environment. One module, two callers —
 * two copies of a bit-error scorer is exactly how two answers to "is this
 * the same recording?" begin to disagree.
 *
 * THE STORED FORMAT IS RAW, NOT COMPRESSED. The column is named
 * `fp_compressed_b64`, but worker/app/fingerprint.py packs the raw frames
 * with struct '<{n}I' and base64s the result. The name predates the
 * implementation and is not worth a migration; this comment and the first
 * test in ber.test.ts are the record.
 *
 * SCORE ORIENTATION: score = 1 − BER, so 1 is identical and higher is more
 * similar, matching dedup_config's bands (t_same 0.90 > t_probable 0.70 >
 * t_related 0.40). Note that 1 − BER has a FLOOR near 0.5 for unrelated
 * material, because two unrelated 32-bit words differ in about half their
 * bits. See the note on MIN_OVERLAP_FRAMES below and the calibration
 * warning in the M4 Task 3 report: the seeded t_related of 0.40 sits
 * BELOW that floor, so nothing real reaches the `different` band until
 * Task 8 recalibrates. That is a thresholds problem, and thresholds are
 * data — it is fixed with an UPDATE, not a deploy.
 */

/** fpcalc's frame rate. M3 Task 4 measured 2,886 frames on a 6:00 fixture. */
export const FRAMES_PER_SECOND = 8

/** ±10 seconds of alignment search. PRD §6. */
export const MAX_OFFSET_FRAMES = 80

/**
 * Under about eight seconds of overlap a score means nothing: two unrelated
 * tracks can agree over a short window by chance, and PRD §6's bands were
 * never calibrated against one. Below this the answer is 0, not a number.
 */
export const MIN_OVERLAP_FRAMES = 64

/**
 * ±10 s, matching `dedup_config.duration_gate_s`. PRD §6.
 *
 * This is a SECOND line of defence, not the primary gate — `dedup_candidates()`
 * applies the same window in SQL and a candidate that fails it never reaches
 * this module. It is duplicated here because the score is what a human reads
 * in the review UI, and a scorer that happily reports 0.97 for a 12-minute
 * DJ tool against its own 4-minute radio edit is an invitation to merge them
 * by hand. Measured on production 2026-07-29: the "Feeling For You" pair is
 * 431 s against 278 s, and this gate is what separates them.
 */
export const MAX_DURATION_DELTA_MS = 10_000

export interface Probe {
  fileId: string
  frames: Uint32Array
  /** Optional. Absent means "not known", never "zero". */
  durationMs?: number | null
}
export interface Candidate extends Probe {
  trackId: string | null
  durationMs: number | null
}
export interface CandidateScore {
  candidateFileId: string
  candidateTrackId: string | null
  score: number
  bestOffset: number
  overlapFrames: number
  perSecondBer: number[]
}

/** Base64 → bytes, without Buffer: Workers have atob, Node 22 has it too. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function unpackFingerprint(b64: string): Uint32Array {
  if (!b64) return new Uint32Array(0)
  const bytes = b64ToBytes(b64)
  // floor, so a truncated blob drops its partial tail word instead of
  // reading past the buffer and throwing. A RangeError here would kill a
  // dedup that is supposed to degrade.
  const n = Math.floor(bytes.length / 4)
  const out = new Uint32Array(n)
  // DataView with littleEndian=true, never a Uint32Array view over the
  // buffer: the byte offset is not guaranteed to be 4-aligned, and host
  // endianness is not a thing to bet a dedup decision on.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) out[i] = view.getUint32(i * 4, true)
  return out
}

/** The inverse, for tests and for nothing else. */
export function packForTest(frames: Uint32Array): string {
  const bytes = new Uint8Array(frames.length * 4)
  const view = new DataView(bytes.buffer)
  frames.forEach((v, i) => view.setUint32(i * 4, v, true))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Hamming weight of a 32-bit word. The standard SWAR popcount. */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (Math.imul(x, 0x01010101) >>> 24)
}

/**
 * Fraction of differing bits over the overlapping region.
 *
 * `offset` is how far b is shifted relative to a: a positive offset means b
 * starts later, i.e. a[i + offset] is compared with b[i].
 */
export function bitErrorRate(
  a: Uint32Array, b: Uint32Array, offset: number,
): { ber: number; overlap: number } {
  const start = Math.max(0, -offset)
  const end = Math.min(b.length, a.length - offset)
  const overlap = end - start
  if (overlap <= 0) return { ber: 1, overlap: 0 }
  let bits = 0
  for (let i = start; i < end; i++) bits += popcount32((a[i + offset] ^ b[i]) >>> 0)
  return { ber: bits / (overlap * 32), overlap }
}

/**
 * ±10 s on duration. Unknown on either side PASSES — Task 5 calls
 * scoreCandidate with `durationMs: null` precisely because the SQL candidate
 * query has already applied this window, and reading "unknown" as "reject"
 * there would silently drop every real duplicate.
 */
export function durationGatePasses(
  a: number | null | undefined, b: number | null | undefined,
): boolean {
  if (a == null || b == null) return true
  return Math.abs(a - b) <= MAX_DURATION_DELTA_MS
}

/**
 * The offset sweep. score = 1 − BER at the best alignment.
 *
 * ±80 frames is ±10 seconds, which covers the real cases: a rip that starts
 * a beat early, a radio edit trimmed at the head, a CD track with a
 * different pregap, and — by far the most common — the ~576 samples of
 * padding an MP3 encoder prepends, which puts a true transcode pair a few
 * frames out. Measured on a real ffmpeg/libmp3lame pair with a 0.5 s pregap:
 * the sweep recovers offset −4 at score 0.996 (see ber.fixture.ts).
 *
 * It does NOT cover a vinyl rip at a different playback speed — chromaprint
 * is not robust to tempo shift and PRD §6 accepts those duplicates rather
 * than pretending otherwise.
 *
 * THE WINNER MUST CLEAR MIN_OVERLAP_FRAMES. Picking the global BER minimum
 * and only then checking the overlap is a trap: at the edges of the window a
 * short probe leaves a handful of frames, a handful of frames can agree by
 * chance better than the true alignment does, and the pair is then thrown
 * away at score 0 with no error anywhere. So the sweep prefers the best
 * QUALIFYING alignment, and falls back to the best short one only to report
 * an honest overlap alongside the 0.
 */
export function sweepOffsets(
  a: Uint32Array, b: Uint32Array, maxOffset = MAX_OFFSET_FRAMES,
): { score: number; bestOffset: number; overlapFrames: number } {
  if (a.length === 0 || b.length === 0) {
    return { score: 0, bestOffset: 0, overlapFrames: 0 }
  }
  let best: { ber: number; overlap: number; offset: number } | null = null
  let fallback: { ber: number; overlap: number; offset: number } | null = null
  for (let off = -maxOffset; off <= maxOffset; off++) {
    const { ber, overlap } = bitErrorRate(a, b, off)
    if (overlap === 0) continue
    if (fallback === null || ber < fallback.ber) fallback = { ber, overlap, offset: off }
    if (overlap < MIN_OVERLAP_FRAMES) continue
    if (best === null || ber < best.ber) best = { ber, overlap, offset: off }
  }
  if (best === null) {
    return {
      score: 0,
      bestOffset: fallback?.offset ?? 0,
      overlapFrames: fallback?.overlap ?? 0,
    }
  }
  return { score: 1 - best.ber, bestOffset: best.offset, overlapFrames: best.overlap }
}

/**
 * BER per second of overlap — the review UI's divergence strip.
 *
 * A matching body with a divergent first thirty seconds is a different
 * intro edit, not a different track. That distinction is invisible in a
 * single number and obvious in this array, which is the entire reason PRD
 * §6 asks for it.
 */
export function perSecondBer(
  a: Uint32Array, b: Uint32Array, offset: number,
): number[] {
  const start = Math.max(0, -offset)
  const end = Math.min(b.length, a.length - offset)
  if (end <= start) return []
  const out: number[] = []
  for (let i = start; i < end; i += FRAMES_PER_SECOND) {
    const stop = Math.min(i + FRAMES_PER_SECOND, end)
    let bits = 0
    for (let j = i; j < stop; j++) bits += popcount32((a[j + offset] ^ b[j]) >>> 0)
    out.push(bits / ((stop - i) * 32))
  }
  return out
}

export function scoreCandidate(probe: Probe, candidate: Candidate): CandidateScore {
  if (!durationGatePasses(probe.durationMs, candidate.durationMs)) {
    return {
      candidateFileId: candidate.fileId,
      candidateTrackId: candidate.trackId,
      score: 0,
      bestOffset: 0,
      overlapFrames: 0,
      perSecondBer: [],
    }
  }
  const { score, bestOffset, overlapFrames } =
    sweepOffsets(probe.frames, candidate.frames)
  return {
    candidateFileId: candidate.fileId,
    candidateTrackId: candidate.trackId,
    score: Number(score.toFixed(6)),
    bestOffset,
    overlapFrames,
    // Rounded to three places: this array is ~360 numbers per decision and
    // is stored per decision. Full float precision on a display strip is
    // bytes spent on digits nobody can see.
    perSecondBer: perSecondBer(probe.frames, candidate.frames, bestOffset)
      .map((v) => Number(v.toFixed(3))),
  }
}
