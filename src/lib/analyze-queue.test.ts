// src/lib/analyze-queue.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same stand-in as r2.test.ts: `cloudflare:workers` is a workerd built-in
// that plain Vitest cannot resolve, and a mutable object lets the "binding
// is missing" branch be driven per test.
const mockEnv = vi.hoisted(() => ({} as Record<string, unknown>))
vi.mock('cloudflare:workers', () => ({ env: mockEnv }))

const { enqueueAnalysis, ANALYSIS_VERSION } = await import('./analyze-queue')

const FILE_ID = 'afd254ee-bbe9-4314-bda6-113746511d26'
const R2_KEY =
  'audio/8fbe5a86-7557-4011-bcd3-d3ce66521054/afd254ee-bbe9-4314-bda6-113746511d26.flac'

describe('enqueueAnalysis', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k]
    vi.restoreAllMocks()
  })

  it('sends exactly the three fields the consumer parses', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    mockEnv.ANALYZE_QUEUE = { send }

    await expect(enqueueAnalysis(FILE_ID, R2_KEY)).resolves.toBe(true)
    expect(send).toHaveBeenCalledWith({
      file_id: FILE_ID,
      r2_key: R2_KEY,
      analysis_version: ANALYSIS_VERSION,
    })
  })

  it('returns false instead of throwing when the send fails', async () => {
    // The upload has already been finalised and HEAD-verified at this point.
    // Throwing here would turn a queue hiccup into "your upload failed" and
    // invite a 40 MB re-upload for nothing.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockEnv.ANALYZE_QUEUE = { send: vi.fn().mockRejectedValue(new Error('queue unavailable')) }

    await expect(enqueueAnalysis(FILE_ID, R2_KEY)).resolves.toBe(false)
    expect(errorSpy.mock.calls[0].join(' ')).toContain(FILE_ID)
  })

  it('returns false when the binding is missing entirely', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(enqueueAnalysis(FILE_ID, R2_KEY)).resolves.toBe(false)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('stuck-job cron')
  })
})
