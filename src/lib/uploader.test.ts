// src/lib/uploader.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  classifyStatus, backoffDelayMs, normaliseEtag, contiguousRanges,
  MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS, PART_PRESIGN_CHUNK,
  newZeroStatusTracker, noteAttemptStatus,
} from './uploader'
import { MAX_PART_URLS_PER_CALL } from './upload-api'

describe('classifyStatus', () => {
  it('treats 200, 201 and 204 as success', () => {
    for (const s of [200, 201, 204]) expect(classifyStatus(s)).toBe('ok')
  })

  it('retries a status of 0', () => {
    // XHR reports a network drop, a DNS failure and a CORS rejection
    // identically as status 0. Retrying costs one round trip; classifyStatus
    // itself does not try to tell them apart — noteAttemptStatus below is
    // where two consecutive 0s start pointing at CORS specifically.
    expect(classifyStatus(0)).toBe('retry')
  })

  it('re-presigns on 403', () => {
    expect(classifyStatus(403)).toBe('represign')
  })

  it('restarts on 404', () => {
    // NoSuchUpload: the 24 h sweeper or the R2 lifecycle rule already aborted
    // this multipart. There is nothing left to resume.
    expect(classifyStatus(404)).toBe('restart')
  })

  it('retries 408, 429 and every 5xx', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(classifyStatus(s)).toBe('retry')
  })

  it('fails permanently on 400, 401, 413, 415 and 422', () => {
    for (const s of [400, 401, 413, 415, 422]) expect(classifyStatus(s)).toBe('fatal')
  })
})

describe('backoffDelayMs', () => {
  it('is zero when the RNG returns zero', () => {
    expect(backoffDelayMs(0, () => 0)).toBe(0)
    expect(backoffDelayMs(4, () => 0)).toBe(0)
  })

  it('is full jitter bounded by base * 2^attempt', () => {
    // Full jitter, not equal jitter: a 200-file batch produces synchronised
    // retries, and full jitter is what actually decorrelates them.
    const almostOne = () => 0.999999
    expect(backoffDelayMs(0, almostOne)).toBeLessThan(BACKOFF_BASE_MS)
    expect(backoffDelayMs(1, almostOne)).toBeLessThan(BACKOFF_BASE_MS * 2)
    expect(backoffDelayMs(2, almostOne)).toBeLessThan(BACKOFF_BASE_MS * 4)
  })

  it('is capped', () => {
    expect(backoffDelayMs(30, () => 0.999999)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
  })

  it('is always a non-negative integer', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const d = backoffDelayMs(attempt)
      expect(Number.isInteger(d)).toBe(true)
      expect(d).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('normaliseEtag', () => {
  it('strips the quotes R2 wraps the header in', () => {
    expect(normaliseEtag('"9b2cf5341234abcd"')).toBe('9b2cf5341234abcd')
  })

  it('strips a weak-validator prefix', () => {
    expect(normaliseEtag('W/"9b2cf5341234abcd"')).toBe('9b2cf5341234abcd')
  })

  it('is null when the header is missing', () => {
    // The CORS symptom: without ExposeHeaders: ["ETag"] in the bucket rule,
    // getResponseHeader('ETag') is null and multipart completion is
    // impossible. It presents as an inexplicable undefined, not as an error.
    expect(normaliseEtag(null)).toBeNull()
    expect(normaliseEtag('')).toBeNull()
  })
})

describe('contiguousRanges', () => {
  it('is one range for a gap-free list', () => {
    expect(contiguousRanges([1, 2, 3, 4], 100)).toEqual([[1, 4]])
  })

  it('splits at a gap', () => {
    // /api/upload/parts accepts exactly one inclusive [from, to] range per
    // call, never an arbitrary list — a gap from an out-of-order retry has
    // to become two range requests, not one that silently spans it.
    expect(contiguousRanges([4, 5, 9, 10, 11], 100)).toEqual([[4, 5], [9, 11]])
  })

  it('splits a run longer than maxLength', () => {
    expect(contiguousRanges([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5, 5]])
  })

  it('returns nothing for an empty list', () => {
    expect(contiguousRanges([], 100)).toEqual([])
  })

  it('never emits a range longer than PART_PRESIGN_CHUNK in practice', () => {
    const all = Array.from({ length: 250 }, (_, i) => i + 1)
    for (const [from, to] of contiguousRanges(all, PART_PRESIGN_CHUNK)) {
      expect(to - from + 1).toBeLessThanOrEqual(PART_PRESIGN_CHUNK)
    }
  })
})

describe('noteAttemptStatus (Minor 3: the CORS hint tracker)', () => {
  it('does nothing on the first zero-status failure', () => {
    const t = newZeroStatusTracker()
    expect(noteAttemptStatus(t, 0)).toBe(false)
    expect(t.consecutive).toBe(1)
    expect(t.hinted).toBe(false)
  })

  it('fires exactly once, on the second consecutive zero-status failure', () => {
    const t = newZeroStatusTracker()
    expect(noteAttemptStatus(t, 0)).toBe(false)
    expect(noteAttemptStatus(t, 0)).toBe(true)
    expect(t.hinted).toBe(true)
    // A third, fourth, ... zero-status failure must not fire again — the
    // hint should not repeat on every remaining retry.
    expect(noteAttemptStatus(t, 0)).toBe(false)
    expect(noteAttemptStatus(t, 0)).toBe(false)
  })

  it('resets the streak on any real HTTP status, even a failure', () => {
    const t = newZeroStatusTracker()
    noteAttemptStatus(t, 0)
    expect(noteAttemptStatus(t, 500)).toBe(false) // a real 500 is not a CORS symptom
    expect(t.consecutive).toBe(0)
    // Back to needing two in a row again.
    expect(noteAttemptStatus(t, 0)).toBe(false)
  })

  it('resets on success (any non-zero status) between two isolated status-0 blips', () => {
    const t = newZeroStatusTracker()
    noteAttemptStatus(t, 0)
    noteAttemptStatus(t, 200) // one flaky attempt, then it worked
    expect(noteAttemptStatus(t, 0)).toBe(false) // an unrelated later blip does not carry over
    expect(t.consecutive).toBe(1)
  })
})

describe('PART_PRESIGN_CHUNK vs MAX_PART_URLS_PER_CALL (Minor 2)', () => {
  it('stays equal to the server-side cap /api/upload/parts enforces', () => {
    // These are two independent constants — this file's PART_PRESIGN_CHUNK
    // (client) and upload-api.ts's MAX_PART_URLS_PER_CALL (server) — with
    // nothing at the type level binding them together. uploader.ts cannot
    // import upload-api.ts directly (see upload-api.ts's header: it is kept
    // free of r2.ts so it stays testable, and pulling server-side RPC/
    // ownership helpers into the client bundle for one constant would be a
    // worse trade than this test). If PART_PRESIGN_CHUNK is ever raised
    // without raising MAX_PART_URLS_PER_CALL to match, the client starts
    // asking for more part URLs per call than the server will sign, and
    // /api/upload/parts 400s mid-batch on any file over 1.6 GiB (100 parts
    // x 16 MiB). This assertion is the tripwire.
    expect(PART_PRESIGN_CHUNK).toBe(MAX_PART_URLS_PER_CALL)
  })
})
