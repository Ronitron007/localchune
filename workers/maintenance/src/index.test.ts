// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweep, type Env } from './index'

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
