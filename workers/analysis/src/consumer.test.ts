// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it, vi } from 'vitest'
import {
  OK_FALSE_MAX_ATTEMPTS, handleDeadLetter, handleMessage, parseMessage, summarise, type Deps,
} from './consumer'
import { NO_DATA_FOUND, PostgrestError } from './supabase'
import type { AnalyzeResponse } from './types'

const FILE_ID = 'afd254ee-bbe9-4314-bda6-113746511d26'
const R2_KEY =
  'audio/8fbe5a86-7557-4011-bcd3-d3ce66521054/afd254ee-bbe9-4314-bda6-113746511d26.flac'
const BODY = { file_id: FILE_ID, r2_key: R2_KEY, analysis_version: 'v1' }

function response(over: Partial<AnalyzeResponse> = {}): AnalyzeResponse {
  return {
    file_id: FILE_ID,
    analysis_version: 'v1',
    ok: true,
    error: null,
    duration_ms: 360000,
    container: 'flac',
    codec: 'flac',
    sample_rate: 44100,
    bit_depth: 16,
    channels: 2,
    fingerprint: null,
    beats: {
      bpm: 128, bpm_median_ibi: 130.4348, beat_count: 768, ibi_std_ms: 1.5,
      beat_grid: [0.5, 0.96875], downbeat_grid: [0.5], confidence: 0.93,
    },
    key: {
      key: 'C', scale: 'minor', camelot: '5A', open_key: '12m',
      strength: 0.75, alt_profiles: {},
    },
    loudness: {
      integrated_lufs: -8.25, lra_lu: 4.5, true_peak_dbtp: 0.75,
      replaygain_db: -5.75, clipped_pct: 1,
    },
    forensics: null,
    tags: {},
    peaks_key: 'peaks.json',
    preview_key: null,
    artwork_key: null,
    cpu_seconds: 53.8,
    ...over,
  }
}

function deps(over: Partial<Deps> = {}): Deps {
  return {
    begin: vi.fn().mockResolvedValue('analysing'),
    analyse: vi.fn().mockResolvedValue(response()),
    persist: vi.fn().mockResolvedValue('stored'),
    fail: vi.fn().mockResolvedValue('failed'),
    ...over,
  }
}

describe('parseMessage', () => {
  it('accepts the shape the producer sends', () => {
    expect(parseMessage(BODY)).toEqual(BODY)
  })

  it.each([
    ['null', null],
    ['a string', 'file_id'],
    ['a missing file_id', { r2_key: R2_KEY, analysis_version: 'v1' }],
    ['a non-uuid file_id', { ...BODY, file_id: 'not-a-uuid' }],
    ['an empty analysis_version', { ...BODY, analysis_version: '' }],
    ['a derived key', { ...BODY, r2_key: `derived/${FILE_ID}/peaks.json` }],
    ['a traversal in the key', { ...BODY, r2_key: 'audio/../../etc/passwd' }],
    ['a key with no extension', { ...BODY, r2_key: `audio/${FILE_ID}/${FILE_ID}` }],
  ])('rejects %s', (_name, body) => {
    expect(parseMessage(body)).toBeNull()
  })
})

describe('handleMessage', () => {
  it('claims, analyses, persists and acks the happy path', async () => {
    const d = deps()
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('ack')
    expect(d.begin).toHaveBeenCalledWith(FILE_ID)
    expect(d.analyse).toHaveBeenCalledWith(BODY)
    expect(d.persist).toHaveBeenCalledTimes(1)
    expect(d.fail).not.toHaveBeenCalled()
    expect(out.reason).toContain('bpm=128.000')
  })

  it('acks a malformed message instead of retrying it into the DLQ', async () => {
    const d = deps()
    const out = await handleMessage({ nonsense: true }, 1, d)

    expect(out.action).toBe('ack')
    expect(out.reason).toContain('malformed')
    expect(d.begin).not.toHaveBeenCalled()
  })

  it('acks when the file no longer exists (P0002 from analysis_begin)', async () => {
    const d = deps({
      begin: vi.fn().mockRejectedValue(
        new PostgrestError('unknown file', 404, NO_DATA_FOUND)),
    })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('ack')
    expect(d.analyse).not.toHaveBeenCalled()
  })

  it('retries any other analysis_begin failure — a 401 is not a reason to drop a track', async () => {
    const d = deps({
      begin: vi.fn().mockRejectedValue(
        new PostgrestError('rpc analysis_begin: 401 Invalid API key', 401, null)),
    })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('retry')
    expect(d.analyse).not.toHaveBeenCalled()
  })

  it.each(['stored', 'quarantined', 'abandoned', 'failed'])(
    'acks without analysing when the file is already %s',
    async (state) => {
      const d = deps({ begin: vi.fn().mockResolvedValue(state) })
      const out = await handleMessage(BODY, 1, d)

      expect(out.action).toBe('ack')
      expect(out.reason).toContain(state)
      // The point of the whole check: a redelivery of a finished file must
      // not spend another ~55 vCPU-s re-analysing it.
      expect(d.analyse).not.toHaveBeenCalled()
    },
  )

  it('[F4] retries rather than analysing when analysis_begin reports busy', async () => {
    const d = deps({ begin: vi.fn().mockResolvedValue('busy') })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('retry')
    expect(out.reason).toContain('already analysing')
    // The whole point: a duplicate delivery inside the lease must not run a
    // second ~45 vCPU-s container analysis.
    expect(d.analyse).not.toHaveBeenCalled()
  })

  it('retries when the DO throws — an r2 miss rides the retries into the DLQ', async () => {
    const d = deps({
      analyse: vi.fn().mockRejectedValue(new Error(`r2 miss: ${R2_KEY}`)),
    })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('retry')
    expect(out.reason).toContain('r2 miss')
    expect(d.persist).not.toHaveBeenCalled()
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('retries a non-JSON answer from the container', async () => {
    const d = deps({
      analyse: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    })
    expect((await handleMessage(BODY, 1, d)).action).toBe('retry')
  })

  it('retries a container-reported failure before giving up on it', async () => {
    const d = deps({ analyse: vi.fn().mockResolvedValue(response({ ok: false, error: 'decode failed' })) })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('retry')
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('marks the file failed once the container has said no enough times', async () => {
    const d = deps({ analyse: vi.fn().mockResolvedValue(response({ ok: false, error: 'decode failed' })) })
    const out = await handleMessage(BODY, OK_FALSE_MAX_ATTEMPTS, d)

    expect(out.action).toBe('ack')
    expect(d.fail).toHaveBeenCalledWith(FILE_ID, 'decode failed')
    expect(d.persist).not.toHaveBeenCalled()
  })

  it('retries rather than acking when recording the failure itself fails', async () => {
    // Acking here would strand the file in 'analysing' with nothing left to
    // move it — the stuck-job cron would be the only way out, an hour later.
    const d = deps({
      analyse: vi.fn().mockResolvedValue(response({ ok: false, error: 'decode failed' })),
      fail: vi.fn().mockRejectedValue(new PostgrestError('boom', 500, null)),
    })
    expect((await handleMessage(BODY, OK_FALSE_MAX_ATTEMPTS, d)).action).toBe('retry')
  })

  it('[F8] acks, rather than retries, when the file was deleted before the failure could be recorded', async () => {
    const d = deps({
      analyse: vi.fn().mockResolvedValue(response({ ok: false, error: 'decode failed' })),
      fail: vi.fn().mockRejectedValue(new PostgrestError('unknown file', 404, NO_DATA_FOUND)),
    })
    const out = await handleMessage(BODY, OK_FALSE_MAX_ATTEMPTS, d)

    expect(out.action).toBe('ack')
  })

  it('retries when persist fails, so no analysis is silently thrown away', async () => {
    const d = deps({
      persist: vi.fn().mockRejectedValue(new PostgrestError('timeout', 504, null)),
    })
    expect((await handleMessage(BODY, 1, d)).action).toBe('retry')
  })

  it('acks when the file was deleted mid-analysis', async () => {
    const d = deps({
      persist: vi.fn().mockRejectedValue(
        new PostgrestError('unknown file', 404, NO_DATA_FOUND)),
    })
    expect((await handleMessage(BODY, 1, d)).action).toBe('ack')
  })

  it('stores a degraded result like any other — bpm 0 is data, not failure', async () => {
    const degraded = response({
      beats: {
        bpm: 0, bpm_median_ibi: 0, beat_count: 0, ibi_std_ms: 0,
        beat_grid: [], downbeat_grid: [], confidence: 0,
      },
      key: null,
      forensics: null,
    })
    const d = deps({ analyse: vi.fn().mockResolvedValue(degraded) })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('ack')
    expect(d.persist).toHaveBeenCalledWith(degraded)
    expect(d.fail).not.toHaveBeenCalled()
    expect(out.reason).toContain('bpm=0.000')
    expect(out.reason).toContain('tier=null')
  })

  it('backs off further on each attempt, capped at five minutes', async () => {
    const d = deps({ analyse: vi.fn().mockRejectedValue(new Error('boom')) })
    const delays: number[] = []
    for (const attempts of [1, 2, 5, 20]) {
      const out = await handleMessage(BODY, attempts, d)
      if (out.action === 'retry') delays.push(out.delaySeconds)
    }
    expect(delays).toEqual([60, 120, 300, 300])
  })
})

describe('[F5] handleDeadLetter', () => {
  it('marks the file failed and acks', async () => {
    const fail = vi.fn().mockResolvedValue('failed')
    const out = await handleDeadLetter(BODY, 1, { fail })

    expect(out.action).toBe('ack')
    expect(fail).toHaveBeenCalledWith(FILE_ID, 'dead-lettered after 5 attempts')
  })

  it('acks a malformed message instead of retrying it forever', async () => {
    const fail = vi.fn()
    const out = await handleDeadLetter({ nonsense: true }, 1, { fail })

    expect(out.action).toBe('ack')
    expect(out.reason).toContain('malformed')
    expect(fail).not.toHaveBeenCalled()
  })

  it('acks, rather than retries, when the file is already gone (P0002)', async () => {
    const fail = vi.fn().mockRejectedValue(new PostgrestError('unknown file', 404, NO_DATA_FOUND))
    const out = await handleDeadLetter(BODY, 1, { fail })

    expect(out.action).toBe('ack')
  })

  it('retries any other analysis_fail failure — the database having a bad minute is not terminal', async () => {
    const fail = vi.fn().mockRejectedValue(new PostgrestError('boom', 500, null))
    const out = await handleDeadLetter(BODY, 1, { fail })

    expect(out.action).toBe('retry')
  })
})

describe('summarise', () => {
  it('reports null forensics as null rather than inventing a tier', () => {
    expect(summarise(response({ forensics: null }))).toContain('tier=null')
  })

  it('omits the beat grid and the fingerprint from the log line', () => {
    const line = summarise(response({
      fingerprint: {
        algo_version: 'cp-1.6.0/test2/11025', duration_s: 360, frame_count: 2886,
        fp_compressed_b64: 'A'.repeat(4000), fp_sha256: 'abc', query_items: [1, 2, 3],
      },
    }))
    expect(line).not.toContain('AAAA')
    expect(line).not.toContain('0.96875')
    expect(line.length).toBeLessThan(300)
  })

  it('names the artifacts that were skipped', () => {
    const line = summarise(response({
      artwork_key: null,
      artifact_skipped: { artwork: 'too_large: 41943040B > 20971520B ceiling' },
    }))
    expect(line).toContain('skipped=')
    expect(line).toContain('artifacts=peaks.json')
  })
})
