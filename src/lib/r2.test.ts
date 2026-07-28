// src/lib/r2.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * r2.ts reads `env` from `cloudflare:workers`, a workerd built-in that plain
 * Vitest cannot resolve. `vi.hoisted` + `vi.mock` stand in a plain mutable
 * object so `conf()`'s "are all four vars present" check can be driven per
 * test — this is what lets Important 2 (the production-bucket trap) get a
 * real unit test instead of only a manual check.
 */
const mockEnv = vi.hoisted(() => ({} as Record<string, string | undefined>))
vi.mock('cloudflare:workers', () => ({ env: mockEnv }))

const { R2Error, objectUrl, deleteObjectQuietly } = await import('./r2')

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

/**
 * Critical #1's fix: complete.ts (size_mismatch, object_missing) and
 * abort.ts both call this instead of deleteObject directly, specifically so
 * an R2 hiccup on the cleanup delete can never surface as the response the
 * client sees — the completion/abort has already been decided by the time
 * either route calls this.
 */
describe('deleteObjectQuietly', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k]
    mockEnv.R2_ACCOUNT_ID = 'acct'
    mockEnv.R2_ACCESS_KEY_ID = 'key'
    mockEnv.R2_SECRET_ACCESS_KEY = 'secret'
    mockEnv.R2_BUCKET = 'localchune-audio-dev'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves and issues a real DELETE when R2 accepts it', async () => {
    // aws4fetch's AwsClient.fetch signs a Request and calls fetch(request) —
    // one argument, not fetch(url, init) — so the method/URL live on the
    // Request object itself.
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(deleteObjectQuietly(KEY)).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [signed] = fetchSpy.mock.calls[0] as [Request]
    expect(signed.method).toBe('DELETE')
    expect(signed.url).toContain(KEY)
  })

  it('swallows an R2 failure instead of throwing — the caller must never see this fail', async () => {
    // 403, not 500: aws4fetch's AwsClient retries any >= 500 response up to
    // 10 times with real setTimeout backoff, which would make this test
    // itself the slow, flaky thing. 403 (bad credentials, the realistic R2
    // failure here) returns to the caller on the first try.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })))

    await expect(deleteObjectQuietly(KEY)).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0].join(' ')).toContain(KEY)
  })

  it('swallows a misconfiguration (missing R2_BUCKET) the same way', async () => {
    delete mockEnv.R2_BUCKET
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // conf() throws before any fetch happens — deleteObjectQuietly must
    // catch that too, not just an R2Error surfaced after a real request.
    await expect(deleteObjectQuietly(KEY)).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
