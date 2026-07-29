// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it, vi } from 'vitest'
import {
  dedupPending, dedupSeedTracks, hexToBytea, makeDedupDeps, type Rpc,
} from './dedup-rpc'

const SHA = 'a'.repeat(64)

describe('hexToBytea', () => {
  it('prefixes the digest so bytea_in reads it as hex, not as ASCII', () => {
    // WITHOUT the prefix bytea_in falls back to ESCAPE format and 'abcd'
    // decodes to four ASCII bytes rather than two. Layer 0 would then
    // compare the wrong 32 bytes against a real digest and never match —
    // silently, because a non-match is a legal answer.
    expect(hexToBytea(SHA)).toBe(`\\x${SHA}`)
  })

  it('refuses anything that is not exactly 64 lower-case hex characters', () => {
    // The container sends '' when it failed before hashing, and
    // decode('', 'hex') is a valid EMPTY bytea — which would collide with
    // the next empty one on a UNIQUE column for a reason that has nothing
    // to do with the audio.
    expect(hexToBytea('')).toBeNull()
    expect(hexToBytea(null)).toBeNull()
    expect(hexToBytea(undefined)).toBeNull()
    expect(hexToBytea(SHA.toUpperCase())).toBeNull()
    expect(hexToBytea(SHA.slice(0, 63))).toBeNull()
    expect(hexToBytea(`${SHA}00`)).toBeNull()
  })
})

describe('makeDedupDeps', () => {
  function fake(over: Record<string, unknown> = {}) {
    const calls: Array<[string, Record<string, unknown>]> = []
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args])
      return (over[fn] ?? []) as never
    }) as unknown as Rpc
    return { rpc, calls }
  }

  it('reads the probe fingerprint out of the returns-table array', async () => {
    const { rpc } = fake({
      dedup_probe: [{ fp_compressed_b64: 'AAAA', fp_sha256: 'x', algo_version: 'v' }],
    })
    expect(await makeDedupDeps(rpc).probeFingerprint('f1'))
      .toEqual({ fp_compressed_b64: 'AAAA', fp_sha256: 'x', algo_version: 'v' })
  })

  it('reports no fingerprint as null, not as an empty object', async () => {
    const { rpc } = fake({ dedup_probe: [] })
    expect(await makeDedupDeps(rpc).probeFingerprint('f1')).toBeNull()
  })

  it('names all three dedup_candidates arguments', async () => {
    // A GRANT or a CALL that omits the third argument is exactly how this
    // regresses: the two-argument form still RESOLVES (it defaults to NULL)
    // and layer 0 then silently never fires.
    const { rpc, calls } = fake()
    await makeDedupDeps(rpc).candidates('f1', SHA)
    expect(calls[0][0]).toBe('dedup_candidates')
    expect(calls[0][1]).toEqual({
      p_file_id: 'f1', p_limit: 25, p_content_sha256: `\\x${SHA}` })
  })

  it('passes a null digest through rather than inventing one', async () => {
    // The hourly backstop works from a file id and has no digest. That is
    // safe: byte-identical files produce identical fingerprints, so layer 1
    // returns them as its top hit.
    const { rpc, calls } = fake()
    await makeDedupDeps(rpc).candidates('f1', null)
    expect(calls[0][1].p_content_sha256).toBeNull()
  })

  it('honours a caller-supplied candidate limit', async () => {
    const { rpc, calls } = fake()
    await makeDedupDeps(rpc, 50).candidates('f1', null)
    expect(calls[0][1].p_limit).toBe(50)
  })

  it('sends the scored array whole, as one jsonb argument', async () => {
    const { rpc, calls } = fake({ dedup_resolve: { ok: true, action: 'merged' } })
    const scored = [{
      candidateFileId: 'c1', candidateTrackId: null, layer: 'ber' as const,
      score: 0.97, bestOffset: -4, overlapFrames: 2400, sharedItems: 212,
      durationDeltaMs: 0, perSecondBer: [0.01, 0.02],
    }]
    const out = await makeDedupDeps(rpc).resolve('f1', scored, 'cp-1.6.0/test2/11025')
    expect(calls[0]).toEqual(['dedup_resolve', {
      p_file_id: 'f1', p_scored: scored, p_algo: 'cp-1.6.0/test2/11025' }])
    expect(out.action).toBe('merged')
  })
})

describe('the backstop queries', () => {
  it('asks dedup_pending for a bounded page', async () => {
    const rpc = vi.fn().mockResolvedValue([{ file_id: 'f1', algo_version: 'v' }]) as unknown as Rpc
    expect(await dedupPending(rpc, 200)).toHaveLength(1)
    expect(rpc).toHaveBeenCalledWith('dedup_pending', { p_limit: 200 })
  })

  it('returns the seed count so a caller can loop until it drains', async () => {
    const rpc = vi.fn().mockResolvedValue(200) as unknown as Rpc
    expect(await dedupSeedTracks(rpc, 200)).toBe(200)
    expect(rpc).toHaveBeenCalledWith('dedup_seed_tracks', { p_limit: 200 })
  })
})
