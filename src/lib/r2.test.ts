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

const { R2Error, objectUrl, readObjectUrl, presignGet, presignPut, deleteObjectQuietly } =
  await import('./r2')

const KEY = 'audio/00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111.mp3'
const DERIVED = 'derived/11111111-1111-1111-1111-111111111111/peaks.json'

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
 * The derived-key pattern. M3 Task 9's contract is that the analysis DO's
 * artifacts under `derived/<file_id>/` become signable for READ — and that
 * the write path does not move an inch while that happens. Both halves are
 * asserted here, because a second pattern bolted onto the existing check
 * would have quietly made `presignPut` accept derived keys too.
 */
describe('derived artifact keys', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k]
    mockEnv.R2_ACCOUNT_ID = 'acct'
    mockEnv.R2_ACCESS_KEY_ID = 'key'
    mockEnv.R2_SECRET_ACCESS_KEY = 'secret'
    mockEnv.R2_BUCKET = 'localchune-audio-dev'
  })

  it('readObjectUrl accepts a derived key', () => {
    expect(readObjectUrl(DERIVED))
      .toBe(`https://acct.r2.cloudflarestorage.com/localchune-audio-dev/${DERIVED}`)
  })

  it('readObjectUrl still accepts an audio key — the player falls back to the original', () => {
    expect(readObjectUrl(KEY)).toContain(KEY)
  })

  it.each(['peaks.json', 'preview.opus', 'artwork.jpg', 'spectrogram.png'])(
    'readObjectUrl accepts the artifact basename %s',
    (name) => {
      expect(readObjectUrl(`derived/11111111-1111-1111-1111-111111111111/${name}`))
        .toContain(name)
    },
  )

  it('objectUrl — the WRITE path — still refuses a derived key', () => {
    // This is the assertion that keeps the second pattern read-only.
    // presignPut, deleteObject, createMultipartUpload and listParts all
    // build their URL with objectUrl, so this one check covers every
    // mutating call.
    expect(() => objectUrl(DERIVED)).toThrow(R2Error)
    try {
      objectUrl(DERIVED)
    } catch (e) {
      expect((e as InstanceType<typeof R2Error>).code).toBe('BadKey')
    }
  })

  it('presignPut refuses a derived key', async () => {
    await expect(presignPut(DERIVED)).rejects.toThrow(R2Error)
  })

  it.each([
    ['derived/11111111-1111-1111-1111-111111111111/../../audio/x.mp3', 'traversal'],
    ['derived/11111111-1111-1111-1111-111111111111/sub/peaks.json', 'a nested path'],
    ['derived/not-a-uuid/peaks.json', 'a non-uuid directory'],
    ['derived/11111111-1111-1111-1111-111111111111/PEAKS.JSON', 'an uppercase basename'],
    ['derived/11111111-1111-1111-1111-111111111111/peaks', 'no extension'],
    ['derived//peaks.json', 'an empty directory'],
  ])('readObjectUrl refuses %s (%s)', (bad) => {
    expect(() => readObjectUrl(bad)).toThrow(R2Error)
  })

  it('presignGet signs a derived key for GET only', async () => {
    const url = await presignGet(DERIVED, { ttlSeconds: 60 })
    expect(url).toContain(DERIVED)
    expect(url).toContain('X-Amz-Expires=60')
    expect(url).toContain('X-Amz-Signature=')
  })

  it('presignGet refuses an implausible key rather than signing it', async () => {
    await expect(presignGet('derived/../secrets')).rejects.toThrow(R2Error)
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

describe('presignGet', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k]
    mockEnv.R2_ACCOUNT_ID = 'acct'
    mockEnv.R2_ACCESS_KEY_ID = 'key'
    mockEnv.R2_SECRET_ACCESS_KEY = 'secret'
    mockEnv.R2_BUCKET = 'bucket'
  })

  it('signs a derived-artifact key', async () => {
    const url = await presignGet(DERIVED)
    expect(url).toContain('/bucket/derived/')
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Expires=3600')
  })

  it('signs an upload key too, for the original download', async () => {
    expect(await presignGet(KEY)).toContain('X-Amz-Signature=')
  })

  it('carries the response-header overrides inside the signature', async () => {
    const url = await presignGet(KEY, { contentDisposition: 'attachment; filename="a.mp3"' })
    expect(url).toContain('response-content-disposition=')
  })

  it('still refuses anything that is neither shape', async () => {
    await expect(presignGet('derived/../../etc/passwd')).rejects.toThrow(R2Error)
    await expect(presignGet('audio/nope')).rejects.toThrow(R2Error)
  })

  it('does NOT loosen the write path', () => {
    // objectUrl feeds presignPut and the multipart control plane. A derived
    // key must never be writable through them.
    expect(() => objectUrl(DERIVED)).toThrow(R2Error)
    expect(readObjectUrl(DERIVED)).toContain('/bucket/derived/')
  })
})
