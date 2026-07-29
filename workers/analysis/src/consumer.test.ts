// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it, vi } from 'vitest'
import {
  ANALYSIS_LEASE_MS, OK_FALSE_MAX_ATTEMPTS, R2MissingError, handleDeadLetter,
  handleMessage, parseMessage, summarise, type Deps,
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
    thumb_key: null,
    content_sha256: 'a'.repeat(64),
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
    dedup: vi.fn().mockResolvedValue({ ok: true, action: 'no_match', trackId: 't1', scored: 0 }),
    fileState: vi.fn().mockResolvedValue({ state: 'analysing', state_changed_at: NOW_ISO }),
    ...over,
  }
}

const NOW = Date.parse('2026-07-29T12:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
/** Past analysis_begin's 10-minute lease: the claim is abandoned, so a dead
 *  letter is allowed to end it. */
const STALE_ISO = new Date(NOW - ANALYSIS_LEASE_MS - 1000).toISOString()

function dlqDeps(over: Partial<Pick<Deps, 'fail' | 'fileState'>> = {}) {
  return {
    fail: vi.fn().mockResolvedValue('failed'),
    fileState: vi.fn().mockResolvedValue({ state: 'analysing', state_changed_at: STALE_ISO }),
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

  // ---- [M4.5] a missing R2 object is terminal, not a retry ----

  it('fails and acks IMMEDIATELY when the object is gone', async () => {
    // The bytes are not coming back. The old behaviour burned five
    // deliveries plus a DLQ round trip rediscovering the same 404, and the
    // row stayed 'analysing' throughout — so the :31 cron re-enqueued it
    // and the whole cycle repeated, hourly, forever. Four hosted rows are
    // in exactly this state.
    const d = deps({ analyse: vi.fn().mockRejectedValue(new R2MissingError(R2_KEY)) })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('ack')
    expect(d.fail).toHaveBeenCalledWith(FILE_ID, `r2 object missing: ${R2_KEY}`)
    // 'failed' is not a state analysis_stuck() returns. THAT is what ends
    // the loop, not the ack.
    expect(out.reason).toMatch(/marked failed, not retried/)
  })

  it('still retries every OTHER analyse failure', async () => {
    // An unreachable container or a 5xx from /analyze is a bad minute.
    const d = deps({ analyse: vi.fn().mockRejectedValue(new Error('container unreachable')) })
    expect((await handleMessage(BODY, 1, d)).action).toBe('retry')
  })

  it('retries when the r2-miss failure could not be RECORDED', async () => {
    // Acking here would leave the row in 'analysing' with nothing left to
    // move it — the exact stranding this branch exists to prevent.
    const d = deps({
      analyse: vi.fn().mockRejectedValue(new R2MissingError(R2_KEY)),
      fail: vi.fn().mockRejectedValue(new PostgrestError('boom', 500, null)),
    })
    expect((await handleMessage(BODY, 1, d)).action).toBe('retry')
  })

  // ---- [M4.5] dedup runs after persist, and can never fail the message ----

  it('runs the matcher after persist, with the digest from the response', async () => {
    // THE DIGEST IS LOAD-BEARING. files.content_sha256 is UNIQUE and
    // analysis_persist() leaves the second of two byte-identical files
    // NULL, so layer 0 only ever fires on an argument the consumer supplies.
    const d = deps()
    const out = await handleMessage(BODY, 1, d)

    expect(d.dedup).toHaveBeenCalledWith(FILE_ID, 'a'.repeat(64))
    expect(out.action).toBe('ack')
    expect(out.reason).toContain('dedup no_match')
  })

  it('passes a null digest rather than an empty string', async () => {
    // '' is what the container sends when it failed before hashing, and
    // decode('', 'hex') is a valid EMPTY bytea — which would collide with
    // the next empty one on a UNIQUE column.
    const d = deps({ analyse: vi.fn().mockResolvedValue(response({ content_sha256: '' })) })
    await handleMessage(BODY, 1, d)
    expect(d.dedup).toHaveBeenCalledWith(FILE_ID, null)
  })

  it('acks and warns when dedup fails, and never retries the analysis', async () => {
    // THE decision this task turns on. A retry would call analysis_begin(),
    // get 'stored', ack as "not claimable" — so the dedup would never run
    // anyway — and would have burned ~45 vCPU-s of container time to
    // recompute a fingerprint already stored. dedup_pending() and the :47
    // cron are what actually recover this file.
    const d = deps({ dedup: vi.fn().mockRejectedValue(new Error('boom')) })
    const out = await handleMessage(BODY, 1, d)

    expect(out.action).toBe('ack')
    expect(out.reason).toMatch(/dedup deferred to cron/)
    expect(d.analyse).toHaveBeenCalledTimes(1)
  })

  it('does not run the matcher when persist itself failed', async () => {
    const d = deps({ persist: vi.fn().mockRejectedValue(new PostgrestError('boom', 500, null)) })
    expect((await handleMessage(BODY, 1, d)).action).toBe('retry')
    expect(d.dedup).not.toHaveBeenCalled()
  })
})

describe('[F5] handleDeadLetter', () => {
  it('marks the file failed and acks', async () => {
    const d = dlqDeps()
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('ack')
    expect(d.fail).toHaveBeenCalledWith(FILE_ID, 'dead-lettered after 5 attempts')
  })

  it('acks a malformed message instead of retrying it forever', async () => {
    const d = dlqDeps()
    const out = await handleDeadLetter({ nonsense: true }, 1, d, NOW)

    expect(out.action).toBe('ack')
    expect(out.reason).toContain('malformed')
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('acks, rather than retries, when the file is already gone (P0002)', async () => {
    const d = dlqDeps({
      fail: vi.fn().mockRejectedValue(new PostgrestError('unknown file', 404, NO_DATA_FOUND)),
    })
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('ack')
  })

  it('retries any other analysis_fail failure — the database having a bad minute is not terminal', async () => {
    const d = dlqDeps({ fail: vi.fn().mockRejectedValue(new PostgrestError('boom', 500, null)) })
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('retry')
  })

  // ---- [M4.5] the guard: a dead letter must not fail a healthy file ----

  it('refuses to fail a file that has since been STORED', async () => {
    // The dangerous one. A message exhausts its five attempts, the :31 cron
    // re-enqueues the file, the re-run succeeds — and THEN the dead letter
    // is delivered. Without this guard it would undo a completed analysis
    // and drop the track out of the pool.
    const d = dlqDeps({
      fileState: vi.fn().mockResolvedValue({ state: 'stored', state_changed_at: NOW_ISO }),
    })
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('ack')
    expect(out.reason).toContain("state is 'stored'")
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('refuses to fail a file another delivery is analysing right now', async () => {
    // 'analysing' INSIDE analysis_begin's 10-minute lease means a second
    // delivery holds the claim and is presumably still running it.
    const d = dlqDeps({
      fileState: vi.fn().mockResolvedValue({
        state: 'analysing',
        state_changed_at: new Date(NOW - 60_000).toISOString(),
      }),
    })
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('ack')
    expect(out.reason).toMatch(/another delivery holds the claim/)
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('DOES fail a file whose claim has outlived the lease', async () => {
    // Past the lease the claim is abandoned, which is the case this handler
    // exists for: the row would otherwise sit in 'analysing' forever and be
    // resurrected by the :31 cron every hour with no attempt ceiling.
    const d = dlqDeps({
      fileState: vi.fn().mockResolvedValue({ state: 'analysing', state_changed_at: STALE_ISO }),
    })
    expect((await handleDeadLetter(BODY, 1, d, NOW)).action).toBe('ack')
    expect(d.fail).toHaveBeenCalled()
  })

  it('acks without failing when the row is gone', async () => {
    const d = dlqDeps({ fileState: vi.fn().mockResolvedValue(null) })
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('ack')
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('retries rather than guessing when it cannot read the state', async () => {
    const d = dlqDeps({ fileState: vi.fn().mockRejectedValue(new Error('503')) })
    const out = await handleDeadLetter(BODY, 1, d, NOW)

    expect(out.action).toBe('retry')
    expect(d.fail).not.toHaveBeenCalled()
  })
})

describe('summarise', () => {
  it('reports null forensics as null rather than inventing a tier', () => {
    const line = summarise(response({ forensics: null }))
    expect(line).toContain('tier=null')
    expect(line).toContain('ancestor=null')
    expect(line).toContain('cutoff=nullHz')
  })

  it('reports the forensic verdict and the bandwidth it was read off', () => {
    const line = summarise(response({
      forensics: {
        meas_cutoff_hz: 16850, meas_cliff_db_500: 41.2, meas_eff_bit_depth: 16,
        meas_eff_sample_rate: 44100, lame_tag_present: false, lame_lowpass_hz: null,
        lame_vbr_method: null, encoder_string: null, lossy_ancestor: 'confirmed',
        inferred_source_kbps: 128, tier: 1, quality_score: 118.5,
        spectrogram_key: null,
      },
    }))
    expect(line).toContain('tier=1')
    expect(line).toContain('ancestor=confirmed')
    expect(line).toContain('cutoff=16850Hz')
  })

  it('logs whether layer 0 has an input, never the whole digest', () => {
    // 64 hex characters per track would bury every other field on the line.
    const line = summarise(response({ content_sha256: 'ab'.repeat(32) }))
    expect(line).toContain('sha=abababab')
    expect(line).not.toContain('ab'.repeat(32))
    expect(summarise(response({ content_sha256: '' }))).toContain('sha=none')
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
