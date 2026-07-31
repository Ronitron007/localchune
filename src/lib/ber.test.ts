// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  FRAMES_PER_SECOND, MAX_DURATION_DELTA_MS, MAX_OFFSET_FRAMES,
  MIN_OVERLAP_FRAMES, bitErrorRate, durationGatePasses, packForTest,
  perSecondBer, scoreCandidate, sweepOffsets, unpackFingerprint,
} from './ber'
import { TRANSCODE_PAIR } from './ber.fixture'

/** Deterministic pseudo-fingerprint. Never Math.random in a test that
 *  asserts a numeric bound — a flaky scorer test would be worse than none. */
function synth(n: number, seed = 1): Uint32Array {
  const out = new Uint32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s
  }
  return out
}

function flipBits(a: Uint32Array, everyNth: number): Uint32Array {
  const out = Uint32Array.from(a)
  for (let i = 0; i < out.length; i += everyNth) out[i] ^= 1 << (i % 32)
  return out
}

describe('unpackFingerprint', () => {
  it('reads RAW little-endian uint32, not chromaprint compression', () => {
    // The column is named fp_compressed_b64 but worker/app/fingerprint.py
    // packs '<{n}I' and base64s it. The name is wrong and is not being
    // changed; this test is the record of what the bytes really are.
    const b64 = packForTest(new Uint32Array([1, 0xffffffff, 0x0000cafe]))
    expect(Array.from(unpackFingerprint(b64))).toEqual([1, 0xffffffff, 0x0000cafe])
  })
  it('survives values above 2^31', () => {
    // fpcalc 1.6.0 emits UNSIGNED 32-bit ints; M3 Task 4 measured all 2,886
    // real values above 2^31 on its first fixture. A signed read here would
    // score every real track against every other one as garbage.
    const b64 = packForTest(new Uint32Array([3846200607]))
    expect(unpackFingerprint(b64)[0]).toBe(3846200607)
  })
  it('returns an empty array for empty input rather than throwing', () => {
    expect(unpackFingerprint('').length).toBe(0)
  })
  it('drops a trailing partial word rather than reading past the buffer', () => {
    // A truncated base64 blob is a real possibility on a row written by an
    // older worker. Reading 4 bytes from a 3-byte tail is a RangeError, and
    // a RangeError inside the consumer kills a dedup that should degrade.
    const whole = packForTest(new Uint32Array([1, 2]))
    const bytes = atob(whole)
    const truncated = btoa(bytes.slice(0, 7))
    expect(Array.from(unpackFingerprint(truncated))).toEqual([1])
  })
})

describe('bitErrorRate', () => {
  it('is 0 for a fingerprint against itself', () => {
    const a = synth(500)
    expect(bitErrorRate(a, a, 0).ber).toBe(0)
  })
  it('is ~0.5 for two unrelated fingerprints', () => {
    // Random 32-bit words differ in half their bits. Anything far from 0.5
    // means the popcount is wrong.
    const { ber } = bitErrorRate(synth(2000, 1), synth(2000, 999), 0)
    expect(ber).toBeGreaterThan(0.45)
    expect(ber).toBeLessThan(0.55)
  })
  it('reports the overlap it actually compared', () => {
    const a = synth(1000)
    const b = synth(600)
    expect(bitErrorRate(a, b, 0).overlap).toBe(600)
  })
  it('returns ber 1 and overlap 0 when the offset leaves no overlap', () => {
    expect(bitErrorRate(synth(50), synth(50), 500)).toEqual({ ber: 1, overlap: 0 })
  })
  it('counts every one of 32 bits when two words are complements', () => {
    // The popcount's own unit test. A SWAR popcount that loses the top byte
    // reads 0.75 here and would quietly inflate every score by a quarter.
    const a = new Uint32Array([0x00000000])
    const b = new Uint32Array([0xffffffff])
    expect(bitErrorRate(a, b, 0).ber).toBe(1)
  })
})

describe('sweepOffsets — properties', () => {
  it('scores a fingerprint against itself at exactly 1', () => {
    const a = synth(2886)
    expect(sweepOffsets(a, a, MAX_OFFSET_FRAMES).score).toBe(1)
  })

  it('is symmetric: score(a,b) === score(b,a)', () => {
    // Not cosmetic. An asymmetric scorer merges A into B but not B into A
    // depending only on who uploaded first.
    const a = synth(2886, 3)
    const b = flipBits(a, 40)
    const ab = sweepOffsets(a, b, MAX_OFFSET_FRAMES)
    const ba = sweepOffsets(b, a, MAX_OFFSET_FRAMES)
    expect(ab.score).toBeCloseTo(ba.score, 10)
    expect(ab.overlapFrames).toBe(ba.overlapFrames)
  })

  it('negates the offset when the arguments swap', () => {
    // Asserted on a SHIFTED pair on purpose. The obvious spelling of this
    // property — expect(ab.bestOffset).toBe(-ba.bestOffset) — passes
    // vacuously at offset 0 in most matchers and FAILS here under Object.is,
    // because -0 is not 0. A non-zero shift tests the real thing.
    const a = synth(2886, 4)
    const b = flipBits(a.slice(17), 40)
    const ab = sweepOffsets(a, b, MAX_OFFSET_FRAMES)
    const ba = sweepOffsets(b, a, MAX_OFFSET_FRAMES)
    expect(ab.bestOffset).toBe(17)
    expect(ba.bestOffset).toBe(-17)
  })

  it('recovers a known shift', () => {
    // The reason the sweep exists: two rips of one master routinely differ
    // by a second of leading silence.
    const a = synth(2886, 5)
    const shifted = a.slice(24)                    // 3 seconds in
    const r = sweepOffsets(a, shifted, MAX_OFFSET_FRAMES)
    expect(r.bestOffset).toBe(24)
    expect(r.score).toBe(1)
  })

  it('recovers an encoder-delay-sized shift of a few frames', () => {
    // An MP3 encoder prepends ~576+ samples of padding, so a real transcode
    // pair is misaligned by a fraction of a frame up to a few frames. This
    // is the shift the window exists for far more often than the 3-second
    // one above.
    const a = synth(2886, 6)
    const r = sweepOffsets(a, a.slice(3), MAX_OFFSET_FRAMES)
    expect(r.bestOffset).toBe(3)
    expect(r.score).toBe(1)
  })

  it('degrades monotonically as more bits are corrupted', () => {
    const a = synth(2886, 7)
    const scores = [200, 60, 20, 6].map(
      (n) => sweepOffsets(a, flipBits(a, n), MAX_OFFSET_FRAMES).score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1])
    }
  })

  it('puts a known bit-flip rate at the score the arithmetic predicts', () => {
    // flipBits(a, 8) flips exactly one bit in every 8th word: one bit per
    // 256, so BER = 1/256 and the score = 1 − 1/256. An off-by-one in the
    // overlap denominator moves this in the third decimal, which is far
    // enough to move a real pair across the 0.90 band edge.
    const a = synth(2880, 8)
    const r = sweepOffsets(a, flipBits(a, 8), MAX_OFFSET_FRAMES)
    expect(r.score).toBeCloseTo(1 - 1 / 256, 9)
  })

  it('never reports an offset outside the window', () => {
    const r = sweepOffsets(synth(2886, 11), synth(2886, 12), MAX_OFFSET_FRAMES)
    expect(Math.abs(r.bestOffset)).toBeLessThanOrEqual(MAX_OFFSET_FRAMES)
  })

  it('keeps two unrelated fingerprints well clear of the auto-merge band', () => {
    // The sanity floor, and the bound is deliberately loose. Two unrelated
    // fingerprints sit at BER ~0.5, but the sweep reports the MINIMUM BER
    // over 161 offsets, and best-of-161 biases the reported score upward.
    // synth() is an LCG whose consecutive values share low bits, which
    // exaggerates that bias badly — it reads ~0.63 here.
    //
    // On REAL production fingerprints the bias is small, because real
    // chromaprint frames carry far more entropy than an LCG stream: two
    // unrelated duration-matched production tracks measured 0.5009 and
    // 0.5100 on 2026-07-29. Those numbers, not this one, are what M4 Task 8
    // must calibrate the `different` band against.
    const r = sweepOffsets(synth(2886, 101), synth(2886, 202), MAX_OFFSET_FRAMES)
    expect(r.score).toBeLessThan(0.75)
  })

  it('scores 0 rather than NaN when either side is empty', () => {
    // A degraded analysis is DATA. A zero-length fingerprint must produce a
    // usable score, not poison every comparison downstream with NaN.
    expect(sweepOffsets(new Uint32Array(0), synth(100), 80).score).toBe(0)
    expect(sweepOffsets(synth(100), new Uint32Array(0), 80).score).toBe(0)
    expect(sweepOffsets(new Uint32Array(0), new Uint32Array(0), 80).score).toBe(0)
  })

  it('refuses a comparison with too little overlap to mean anything', () => {
    // 30 frames is under 4 seconds. Two unrelated tracks can agree over a
    // window that short; PRD 6's whole ladder assumes a real overlap.
    const a = synth(2886, 13)
    const r = sweepOffsets(a, a.slice(0, 30), MAX_OFFSET_FRAMES)
    expect(r.score).toBe(0)
    expect(r.overlapFrames).toBeLessThan(MIN_OVERLAP_FRAMES)
  })

  it('prefers a qualifying overlap over a shorter one that scores better', () => {
    // The trap this guards: with a short probe, the widest offsets leave a
    // handful of frames, and a handful of frames can agree by chance better
    // than the true alignment does. Picking the global BER minimum then
    // lands on a sub-MIN_OVERLAP window and the whole pair is thrown away at
    // score 0 — a true duplicate lost with no error anywhere.
    const a = synth(2886, 14)
    const probe = flipBits(a.slice(0, 100), 10)   // 100 frames, mildly noisy
    // Plant a perfect 12-frame agreement at the far end of the window, where
    // the true alignment (offset 0, 100 frames) can never beat it on BER.
    const decoy = Uint32Array.from(probe)
    for (let i = 0; i < 12; i++) decoy[88 + i] = a[i]
    const r = sweepOffsets(a, decoy, MAX_OFFSET_FRAMES)
    expect(r.overlapFrames).toBeGreaterThanOrEqual(MIN_OVERLAP_FRAMES)
    expect(r.score).toBeGreaterThan(0.9)
  })
})

describe('perSecondBer', () => {
  it('emits one value per second of overlap', () => {
    const a = synth(FRAMES_PER_SECOND * 60)
    expect(perSecondBer(a, a, 0)).toHaveLength(60)
  })
  it('localises a divergent intro', () => {
    // The divergence strip's entire purpose: a matching body with a
    // divergent first thirty seconds is a different intro edit, not a
    // different track, and the reviewer must be able to SEE that.
    const a = synth(FRAMES_PER_SECOND * 120, 17)
    const b = Uint32Array.from(a)
    for (let i = 0; i < FRAMES_PER_SECOND * 30; i++) b[i] = ~b[i] >>> 0
    const strip = perSecondBer(a, b, 0)
    expect(strip.slice(0, 30).every((v) => v > 0.9)).toBe(true)
    expect(strip.slice(35).every((v) => v === 0)).toBe(true)
  })
  it('is empty when the offset leaves no overlap', () => {
    expect(perSecondBer(synth(50), synth(50), 500)).toEqual([])
  })
})

describe('durationGatePasses', () => {
  it('accepts a pair inside ±10 s', () => {
    expect(durationGatePasses(300_000, 300_000 + MAX_DURATION_DELTA_MS)).toBe(true)
    expect(durationGatePasses(300_000, 300_000 - MAX_DURATION_DELTA_MS)).toBe(true)
  })
  it('rejects a pair outside ±10 s', () => {
    expect(durationGatePasses(300_000, 311_000)).toBe(false)
    expect(durationGatePasses(311_000, 300_000)).toBe(false)
  })
  it('passes when either duration is unknown', () => {
    // Task 5 calls scoreCandidate with durationMs: null because the SQL
    // candidate query has ALREADY applied this gate. An unknown duration
    // must therefore never be read as a rejection.
    expect(durationGatePasses(null, 300_000)).toBe(true)
    expect(durationGatePasses(300_000, undefined)).toBe(true)
    expect(durationGatePasses(null, null)).toBe(true)
  })
})

describe('scoreCandidate', () => {
  it('carries the identifiers through untouched', () => {
    const probe = synth(1000, 21)
    const r = scoreCandidate(
      { fileId: 'p', frames: probe },
      { fileId: 'c', trackId: 't', frames: flipBits(probe, 100), durationMs: 300000 })
    expect(r.candidateFileId).toBe('c')
    expect(r.candidateTrackId).toBe('t')
    expect(r.score).toBeGreaterThan(0.9)
    expect(r.perSecondBer.length).toBeGreaterThan(0)
  })

  it('scores 0 when the durations are more than ±10 s apart', () => {
    // Defence in depth, not the primary gate: dedup_candidates() applies the
    // same window in SQL. It is here because the score is what a human sees
    // in the review UI, and a scorer that reports 0.97 for a 12-minute mix
    // against its own 4-minute edit invites someone to merge them by hand.
    const probe = synth(1000, 22)
    const r = scoreCandidate(
      { fileId: 'p', frames: probe, durationMs: 300_000 },
      { fileId: 'c', trackId: 't', frames: probe, durationMs: 320_000 })
    expect(r.score).toBe(0)
    expect(r.overlapFrames).toBe(0)
    expect(r.perSecondBer).toEqual([])
  })

  it('does not gate when the probe duration is unknown', () => {
    const probe = synth(1000, 23)
    const r = scoreCandidate(
      { fileId: 'p', frames: probe },
      { fileId: 'c', trackId: 't', frames: probe, durationMs: 320_000 })
    expect(r.score).toBe(1)
  })

  it('rounds the strip to three places and the score to six', () => {
    const probe = synth(800, 24)
    const r = scoreCandidate(
      { fileId: 'p', frames: probe },
      { fileId: 'c', trackId: null, frames: flipBits(probe, 3), durationMs: null })
    expect(String(r.score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6)
    for (const v of r.perSecondBer) {
      expect(String(v).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3)
    }
  })
})

// ---------------------------------------------------------------------------
// The real-encoder pair. Everything above is synthetic and therefore only
// proves the arithmetic is self-consistent — it cannot catch a scorer that
// encodes the plan's ASSUMPTIONS about what a transcode looks like. These
// two arrays came out of a real `fpcalc -raw` (chromaprint 1.6.0) over a
// real FLAC and a real 320 kbps libmp3lame encode of one master. See
// ber.fixture.ts for how to regenerate them.
// ---------------------------------------------------------------------------
describe('a real FLAC / 320 kbps MP3 transcode pair', () => {
  const flac = Uint32Array.from(TRANSCODE_PAIR.flac)
  const mp3 = Uint32Array.from(TRANSCODE_PAIR.mp3)

  it('has fingerprints a signed reader would have mangled', () => {
    // Not decoration: at least one value above 2^31 is what makes the
    // unsigned round trip load-bearing on THIS fixture rather than in theory.
    expect(flac.some((v) => v > 0x7fffffff)).toBe(true)
  })

  it('lands in the auto-merge band (≥ 0.90)', () => {
    const r = sweepOffsets(flac, mp3, MAX_OFFSET_FRAMES)
    expect(r.score).toBeGreaterThanOrEqual(0.9)
    expect(r.overlapFrames).toBeGreaterThan(MIN_OVERLAP_FRAMES)
  })

  it('scores the same in either direction', () => {
    expect(sweepOffsets(flac, mp3, MAX_OFFSET_FRAMES).score)
      .toBeCloseTo(sweepOffsets(mp3, flac, MAX_OFFSET_FRAMES).score, 10)
  })

  it('survives the base64 round trip the database actually stores', () => {
    // fp_compressed_b64 is what Task 5 reads. Proving the pair scores from
    // the packed form is proving the whole path, not just the maths.
    const r = sweepOffsets(
      unpackFingerprint(packForTest(flac)),
      unpackFingerprint(packForTest(mp3)), MAX_OFFSET_FRAMES)
    expect(r.score).toBeGreaterThanOrEqual(0.9)
  })

  it('recovers a REAL encoder pregap and still reaches the auto band', () => {
    // The third array is the same master encoded at 320 kbps behind 0.5 s of
    // silence — 4 fingerprint frames. This is the assertion that the offset
    // sweep earns its cost on encoder output rather than on synth() data:
    // without the sweep this pair scores like an unrelated one.
    const shifted = Uint32Array.from(TRANSCODE_PAIR.mp3Shifted)
    const r = sweepOffsets(flac, shifted, MAX_OFFSET_FRAMES)
    expect(r.bestOffset).toBe(-4)
    expect(r.score).toBeGreaterThanOrEqual(0.9)

    // Unswept, the same pair reads ~0.728 — chromaprint frames are strongly
    // autocorrelated, so a 4-frame slip degrades gracefully rather than
    // collapsing to noise. 0.728 is the `probable` band: without the sweep
    // this true duplicate would stop and wait for a human instead of
    // merging. THAT is what the sweep buys, and it is worth stating as a
    // number rather than as a claim.
    const unaligned = 1 - bitErrorRate(flac, shifted, 0).ber
    expect(unaligned).toBeLessThan(0.9)          // would NOT auto-merge
    expect(r.score - unaligned).toBeGreaterThan(0.2)
  })

  it('agrees with the independent Python reference to six places', () => {
    // ber_ref.py was written from the PRD, not from this module, and run over
    // the same two files. Two implementations landing on the same number is
    // the only cheap evidence that neither is a private misreading.
    expect(sweepOffsets(flac, mp3, MAX_OFFSET_FRAMES).score)
      .toBeCloseTo(0.999853, 6)
    expect(sweepOffsets(flac, Uint32Array.from(TRANSCODE_PAIR.mp3Shifted),
      MAX_OFFSET_FRAMES).score).toBeCloseTo(0.996169, 6)
  })
})
