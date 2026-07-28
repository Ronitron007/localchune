// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { requeueStuck, sweep, type Env } from './index'

/**
 * Important #1 (M2 final review): before env.dev existed, `wrangler dev`
 * against this config defaulted straight to the PRODUCTION bucket, so a
 * "quick SWEEP_OLDER_THAN=5 minutes test" would mark every genuinely
 * in-flight upload as abandoned and delete its object. sweep() now refuses
 * to run at all in that combination — these tests are the guard, not the
 * rest of the sweeper, which needs a real Supabase/R2 round trip and stays
 * covered by the manual verification run instead.
 */
function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUDIO: {} as R2Bucket,
    ANALYZE_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['ANALYZE_QUEUE'],
    R2_BUCKET: 'localchune-audio-dev',
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_KEY: 'service-key',
    RECONCILE_DELETE_ORPHANS: 'false',
    RECONCILE_DELETE_PENDING: 'false',
    ...overrides,
  }
}

describe('sweep — production-bucket guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses to run when SWEEP_OLDER_THAN is set and R2_BUCKET is the production bucket', async () => {
    const env = fakeEnv({ R2_BUCKET: 'localchune-audio', SWEEP_OLDER_THAN: '5 minutes' })
    await expect(sweep(env)).rejects.toThrow(/SWEEP_OLDER_THAN/)
  })

  it('names both the flag and the bucket in the failure message', async () => {
    const env = fakeEnv({ R2_BUCKET: 'localchune-audio', SWEEP_OLDER_THAN: '5 minutes' })
    await expect(sweep(env)).rejects.toThrow(/localchune-audio/)
  })

  it('never touches Supabase once it refuses', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const env = fakeEnv({ R2_BUCKET: 'localchune-audio', SWEEP_OLDER_THAN: '5 minutes' })
    await expect(sweep(env)).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('runs a manual-verification sweep against the dev bucket', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
    const env = fakeEnv({ R2_BUCKET: 'localchune-audio-dev', SWEEP_OLDER_THAN: '5 minutes' })
    await expect(sweep(env)).resolves.toBeUndefined()
  })

  it('runs the real hourly cron against the production bucket when no override is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
    const env = fakeEnv({ R2_BUCKET: 'localchune-audio' })
    await expect(sweep(env)).resolves.toBeUndefined()
  })
})

/**
 * M3's stuck-job cron. The state_changed_at-not-created_at rule lives in
 * analysis_stuck() and is proved by pgTAP (supabase/tests/analysis.sql);
 * what is testable here is that this job asks for the right window and turns
 * every row it gets back into a message the consumer can actually parse.
 */
describe('requeueStuck', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const ROWS = [
    { file_id: 'afd254ee-bbe9-4314-bda6-113746511d26',
      r2_key: 'audio/8fbe5a86-7557-4011-bcd3-d3ce66521054/afd254ee-bbe9-4314-bda6-113746511d26.flac',
      state: 'received' },
    { file_id: '9d03238f-59bd-4820-9835-eb6ec5eac765',
      r2_key: 'audio/8fbe5a86-7557-4011-bcd3-d3ce66521054/9d03238f-59bd-4820-9835-eb6ec5eac765.m4a',
      state: 'analysing' },
  ]

  it('asks analysis_stuck for the one-hour window and sends one message per row', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(Response.json(ROWS))
    vi.stubGlobal('fetch', fetchSpy)
    const env = fakeEnv()

    await requeueStuck(env)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/rest/v1/rpc/analysis_stuck')
    expect(JSON.parse(init.body as string))
      .toEqual({ p_older_than: '1 hour', p_limit: 100 })

    const send = env.ANALYZE_QUEUE.send as ReturnType<typeof vi.fn>
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith({
      file_id: ROWS[0].file_id, r2_key: ROWS[0].r2_key, analysis_version: 'v1',
    })
  })

  it('re-enqueues a stale received row, not only a stale analysing one', async () => {
    // The pool's first two uploads predate the producer entirely: nothing
    // ever enqueued them, and only this job will.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([ROWS[0]])))
    const env = fakeEnv()

    await requeueStuck(env)

    expect(env.ANALYZE_QUEUE.send).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when nothing is stuck', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([])))
    const env = fakeEnv()

    await requeueStuck(env)

    expect(env.ANALYZE_QUEUE.send).not.toHaveBeenCalled()
  })

  it('keeps going when one send fails — the rest of the batch still moves', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(ROWS)))
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue(undefined)
    const env = fakeEnv({ ANALYZE_QUEUE: { send } as unknown as Env['ANALYZE_QUEUE'] })

    await expect(requeueStuck(env)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
    expect(errorSpy.mock.calls[0].join(' ')).toContain(ROWS[0].file_id)
  })

  it('throws when the RPC itself fails, so the cron invocation is recorded as failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))

    await expect(requeueStuck(fakeEnv())).rejects.toThrow(/analysis_stuck/)
  })
})
