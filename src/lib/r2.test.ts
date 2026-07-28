// src/lib/r2.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * r2.ts reads `env` from `cloudflare:workers`, a workerd built-in that plain
 * Vitest cannot resolve. `vi.hoisted` + `vi.mock` stand in a plain mutable
 * object so `conf()`'s "are all four vars present" check can be driven per
 * test — this is what lets Important 2 (the production-bucket trap) get a
 * real unit test instead of only a manual check.
 */
const mockEnv = vi.hoisted(() => ({} as Record<string, string | undefined>))
vi.mock('cloudflare:workers', () => ({ env: mockEnv }))

const { R2Error, objectUrl } = await import('./r2')

const KEY = 'audio/00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111.mp3'

describe('conf (exercised via objectUrl)', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k]
  })

  it('throws R2NotConfigured when R2_BUCKET is absent, even with real credentials present', () => {
    // This is exactly the trap Important 2 describes: a .dev.vars with
    // credentials but no R2_BUCKET line must fail closed, never fall back
    // to wrangler.jsonc's production bucket.
    mockEnv.R2_ACCOUNT_ID = 'acct'
    mockEnv.R2_ACCESS_KEY_ID = 'key'
    mockEnv.R2_SECRET_ACCESS_KEY = 'secret'

    let caught: unknown
    try {
      objectUrl(KEY)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(R2Error)
    expect((caught as InstanceType<typeof R2Error>).code).toBe('R2NotConfigured')
    expect((caught as InstanceType<typeof R2Error>).status).toBe(500)
  })

  it('throws R2NotConfigured when every var is absent', () => {
    expect(() => objectUrl(KEY)).toThrow(R2Error)
  })

  it('succeeds once all four vars, including R2_BUCKET, are present', () => {
    mockEnv.R2_ACCOUNT_ID = 'acct'
    mockEnv.R2_ACCESS_KEY_ID = 'key'
    mockEnv.R2_SECRET_ACCESS_KEY = 'secret'
    mockEnv.R2_BUCKET = 'localchune-audio-dev'

    expect(objectUrl(KEY)).toBe(`https://acct.r2.cloudflarestorage.com/localchune-audio-dev/${KEY}`)
  })
})
