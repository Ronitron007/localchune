// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it, vi } from 'vitest'
import { packForTest } from './ber'
import {
  MAX_SWEEP_CANDIDATES, runDedup, summariseDedup,
  type CandidateRow, type DedupDeps,
} from './dedup'

/** 3,000 frames of deterministic pseudo-noise — a stand-in for a ~6 min
 *  fingerprint. Knuth's multiplicative hash, so the words are spread across
 *  all 32 bits and a BER against a shifted copy means something. */
const frames = Uint32Array.from(
  { length: 3000 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 0),
)
const twin = packForTest(frames)
/** A genuinely different fingerprint: every word inverted, so the BER is 1
 *  and the score is 0 — the far end of the range, not a near miss. */
const other = packForTest(frames.map((v) => ~v >>> 0))

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    candidate_file_id: 'c1',
    candidate_track_id: 't1',
    fp_compressed_b64: twin,
    fp_sha256: 'bb',
    shared_items: 300,
    duration_delta_ms: 0,
    via: 'gin',
    ...over,
  }
}

function deps(over: Partial<DedupDeps> = {}): DedupDeps {
  return {
    probeFingerprint: vi.fn().mockResolvedValue({
      fp_compressed_b64: twin, fp_sha256: 'aa',
      algo_version: 'cp-1.6.0/test2/11025',
    }),
    candidates: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue({
      ok: true, action: 'no_match', track_id: 't-new',
    }),
    ...over,
  }
}

describe('runDedup', () => {
  it('resolves with no candidates at all — a first upload still gets a track', async () => {
    // The commonest case in a pool of ten people, and the one most likely to
    // be forgotten: an empty candidate list is not an error. dedup_resolve()
    // still mints the identity.
    const d = deps()
    const out = await runDedup('f1', d)
    expect(d.resolve).toHaveBeenCalledWith('f1', [], 'cp-1.6.0/test2/11025')
    expect(out.ok).toBe(true)
    expect(out.trackId).toBe('t-new')
  })

  it('scores every candidate it is given and passes the scores through', async () => {
    const d = deps({ candidates: vi.fn().mockResolvedValue([row()]) })
    await runDedup('f1', d)
    const [, scored] = vi.mocked(d.resolve).mock.calls[0]
    expect(scored).toHaveLength(1)
    expect(scored[0].score).toBe(1)
    expect(scored[0].layer).toBe('ber')
    expect(scored[0].candidateFileId).toBe('c1')
    expect(scored[0].perSecondBer.length).toBeGreaterThan(0)
  })

  it('scores a non-matching fingerprint low rather than refusing it — and NOT at 0', async () => {
    // The bit-inverted twin differs in every bit at offset 0, so the naive
    // expectation is a score of 0. It measures 0.600 instead, because the
    // sweep keeps the LEAST-BAD of 161 alignments and a shifted comparison
    // of unrelated words agrees on about half its bits. That floor is
    // exactly why migration 25 raised t_related to 0.60: a `different` band
    // set below the floor can never be reached by anything real.
    const d = deps({ candidates: vi.fn().mockResolvedValue([row({ fp_compressed_b64: other })]) })
    await runDedup('f1', d)
    const [, scored] = vi.mocked(d.resolve).mock.calls[0]
    expect(scored[0].score).toBeLessThan(0.7)
    expect(scored[0].score).toBeGreaterThan(0.4)
  })

  it('does not sweep at all when layer 0 already answered', async () => {
    // via='sha256' means dedup_exact() matched the bytes. The candidate's
    // fingerprint may legitimately be NULL, so a sweep is not merely wasted
    // — there is nothing to sweep.
    const d = deps({
      candidates: vi.fn().mockResolvedValue([
        row({ via: 'sha256', fp_compressed_b64: null, fp_sha256: null }),
      ]),
    })
    await runDedup('f1', d, 'deadbeef')
    const [, scored] = vi.mocked(d.resolve).mock.calls[0]
    expect(scored[0].layer).toBe('content_sha256')
    expect(scored[0].score).toBe(1)
    expect(scored[0].perSecondBer).toEqual([])
  })

  it('does not sweep 161 offsets to rediscover an identical fingerprint', async () => {
    // fp_sha256 equality is PRD §6 step 4's "same rip, different tags" case
    // and it is free.
    const d = deps({ candidates: vi.fn().mockResolvedValue([row({ fp_sha256: 'aa' })]) })
    await runDedup('f1', d)
    const [, scored] = vi.mocked(d.resolve).mock.calls[0]
    expect(scored[0].layer).toBe('fp_sha256')
    expect(scored[0].score).toBe(1)
    expect(scored[0].perSecondBer).toEqual([])
  })

  it('hands the content digest to the candidate query', async () => {
    // LOAD-BEARING, and the reason dedup_candidates takes a third argument.
    // files.content_sha256 is UNIQUE and analysis_persist() leaves the
    // SECOND of two byte-identical files NULL, so a self-join can never find
    // the pair. The digest has to arrive from the container response.
    const d = deps()
    await runDedup('f1', d, 'a'.repeat(64))
    expect(d.candidates).toHaveBeenCalledWith('f1', 'a'.repeat(64))
  })

  it('caps the candidate set it will score', async () => {
    // dedup_candidates' duration-only fallback can return up to 400 rows.
    // Sweeping 400 fingerprints is ~185M popcounts and is not what the
    // consumer budget was argued on.
    const many = Array.from({ length: 400 }, (_, i) =>
      row({ candidate_file_id: `c${i}`, fp_sha256: `x${i}`, via: 'duration' }))
    const d = deps({ candidates: vi.fn().mockResolvedValue(many) })
    const out = await runDedup('f1', d)
    expect(vi.mocked(d.resolve).mock.calls[0][1]).toHaveLength(MAX_SWEEP_CANDIDATES)
    expect(out.warnings?.join(' ')).toMatch(/duration-only fallback/)
  })

  it('reports not-ok, without throwing, when there is no fingerprint', async () => {
    const d = deps({ probeFingerprint: vi.fn().mockResolvedValue(null) })
    const out = await runDedup('f1', d)
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/no fingerprint/)
    expect(d.resolve).not.toHaveBeenCalled()
  })

  it('treats an empty fingerprint blob the same as a missing row', async () => {
    const d = deps({
      probeFingerprint: vi.fn().mockResolvedValue({
        fp_compressed_b64: '', fp_sha256: 'aa', algo_version: 'v',
      }),
    })
    expect((await runDedup('f1', d)).ok).toBe(false)
    expect(d.resolve).not.toHaveBeenCalled()
  })

  it('warns when the probe is too short to score against anything', async () => {
    // Under 64 frames every score is 0 BY RULE, not by measurement, so the
    // file would silently look unrelated to its own twin. Partial
    // fingerprints are normal here — the production Mango pair reads 1,399
    // frames against 2,181 for the same 272 s — so this is a log line, not
    // a refusal.
    const tiny = packForTest(frames.slice(0, 10))
    const d = deps({
      probeFingerprint: vi.fn().mockResolvedValue({
        fp_compressed_b64: tiny, fp_sha256: 'aa', algo_version: 'v',
      }),
      candidates: vi.fn().mockResolvedValue([row()]),
    })
    const out = await runDedup('f1', d)
    expect(out.warnings?.join(' ')).toMatch(/below the 64-frame minimum/)
    expect(vi.mocked(d.resolve).mock.calls[0][1][0].score).toBe(0)
    expect(out.ok).toBe(true)
  })

  it('warns when a CANDIDATE is too short, naming how many', async () => {
    const tiny = packForTest(frames.slice(0, 10))
    const d = deps({ candidates: vi.fn().mockResolvedValue([row({ fp_compressed_b64: tiny })]) })
    const out = await runDedup('f1', d)
    expect(out.warnings?.join(' ')).toMatch(/1 candidate\(s\) scored on under 64 frames/)
  })

  it('passes the probe duration as unknown, never as a second gate', async () => {
    // The ±10 s window is applied in SQL against fingerprints.duration_s —
    // fpcalc's own decode. Re-applying it here against the container's
    // header would REJECT the production Mango pair, whose files agree to
    // 0 s on fpcalc and disagree by 24 s on duration_ms.
    const d = deps({ candidates: vi.fn().mockResolvedValue([row({ duration_delta_ms: 24000 })]) })
    await runDedup('f1', d)
    const [, scored] = vi.mocked(d.resolve).mock.calls[0]
    expect(scored[0].score).toBe(1)
    expect(scored[0].durationDeltaMs).toBe(24000)
  })

  it('surfaces a resolve that refused, rather than reporting success', async () => {
    const d = deps({
      resolve: vi.fn().mockResolvedValue({
        ok: false, action: 'no_config', reason: 'no dedup_config row',
      }),
    })
    const out = await runDedup('f1', d)
    expect(out.ok).toBe(false)
    expect(out.action).toBe('no_config')
  })

  it('lets a thrown effect propagate — a database outage is not "no match"', async () => {
    const d = deps({ resolve: vi.fn().mockRejectedValue(new Error('503')) })
    await expect(runDedup('f1', d)).rejects.toThrow('503')
  })
})

describe('summariseDedup', () => {
  it('says what happened without printing a fingerprint', () => {
    const line = summariseDedup('f1', {
      ok: true, action: 'merged', trackId: '11112222-3333-4444-5555-666677778888', scored: 3,
    })
    expect(line).toBe('f1: dedup merged scored=3 track=11112222')
  })

  it('says why nothing happened when nothing did', () => {
    expect(summariseDedup('f1', { ok: false, reason: 'no fingerprint' }))
      .toMatch(/dedup skipped — no fingerprint/)
  })
})
