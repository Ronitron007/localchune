// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  MAX_DURATION_MS, MULTIPART_THRESHOLD_BYTES, PART_SIZE_BYTES, MAX_PARTS,
  containerFromFilename, contentTypeFor, maxBytesFor, partSizeFor,
  planUpload, partRange, preflight, preflightMessage,
} from './upload-policy'

describe('containerFromFilename', () => {
  it('reads the extension case-insensitively', () => {
    expect(containerFromFilename('Artist - Title (Extended Mix).FLAC')).toBe('flac')
  })
  it('folds .aif to aiff', () => {
    expect(containerFromFilename('rip.aif')).toBe('aiff')
  })
  it('folds .oga to ogg', () => {
    expect(containerFromFilename('rip.oga')).toBe('ogg')
  })
  it('survives dots in the stem', () => {
    expect(containerFromFilename('DJ Koze - Pick Up (feat. Someone).v2.mp3')).toBe('mp3')
  })
  it('rejects anything not on the allowlist', () => {
    expect(containerFromFilename('mix.exe')).toBeNull()
    expect(containerFromFilename('noextension')).toBeNull()
    expect(containerFromFilename('.flac')).toBeNull()
  })
})

describe('maxBytesFor', () => {
  // The gate IS the duration lower bound: bytes * 8 / max_bitrate is the
  // minimum possible duration, so "smaller than a 15-minute file" and
  // "could conceivably be under 15 minutes" are the same inequality.
  it('is 15 minutes at the container ceiling plus 10% for tags', () => {
    expect(maxBytesFor('mp3')).toBe(39_600_000)     // 900s @ 320kbps
    expect(maxBytesFor('m4a')).toBe(63_360_000)     // 900s @ 512kbps
    expect(maxBytesFor('flac')).toBe(570_240_000)   // 900s @ 4608kbps (24/96 stereo)
    expect(maxBytesFor('wav')).toBe(maxBytesFor('flac'))
    expect(maxBytesFor('aiff')).toBe(maxBytesFor('flac'))
  })
  it('inverts back to ~15 minutes of headroom', () => {
    const minSeconds = (maxBytesFor('flac') * 8) / 4_608_000
    expect(minSeconds).toBeGreaterThan(900)
    expect(minSeconds).toBeLessThan(1000)
  })
})

describe('preflight', () => {
  const ok = (v: ReturnType<typeof preflight>) => v.ok

  it('accepts a normal 320 mp3', () => {
    expect(ok(preflight('track.mp3', 14_000_000, 372_000))).toBe(true)
  })
  it('accepts a file whose header carried no duration', () => {
    // Header-less VBR MP3 / non-faststart M4A. Not a rejection: the size
    // gate still applies and the analysis worker is authoritative.
    expect(ok(preflight('track.mp3', 14_000_000, null))).toBe(true)
  })
  it('rejects a duration the client itself admits is over 15 minutes', () => {
    const v = preflight('set.mp3', 20_000_000, 900_001)
    expect(v).toEqual({ ok: false, reason: 'too_long' })
  })
  it('accepts exactly 15 minutes', () => {
    expect(ok(preflight('track.mp3', 20_000_000, MAX_DURATION_MS))).toBe(true)
  })
  it('rejects a 2-hour mp3 on size alone, whatever the client claims', () => {
    const v = preflight('dj-set.mp3', 288_000_000, 300_000)
    expect(v).toEqual({ ok: false, reason: 'too_large' })
  })
  it('accepts a 15-minute 24/96 wav but not a 24/192 one', () => {
    expect(ok(preflight('a.wav', 518_400_000, null))).toBe(true)
    expect(ok(preflight('a.wav', 1_036_800_000, null))).toBe(false)
  })
  it('rejects an unsupported container before looking at size', () => {
    expect(preflight('mix.exe', 10, 1000)).toEqual({ ok: false, reason: 'unsupported_container' })
  })
  it('rejects a zero-byte file', () => {
    expect(preflight('empty.flac', 0, 1000)).toEqual({ ok: false, reason: 'empty' })
  })
  it('returns the container and the plan on success', () => {
    const v = preflight('big.flac', 100_000_000, 372_000)
    expect(v).toMatchObject({
      ok: true,
      container: 'flac',
      plan: { multipart: true, partSize: PART_SIZE_BYTES, partCount: 6 },
    })
  })
  it('produces a message for every rejection reason', () => {
    for (const reason of ['unsupported_container', 'too_long', 'too_large', 'empty'] as const) {
      expect(preflightMessage({ ok: false, reason }).length).toBeGreaterThan(10)
    }
  })
})

describe('planUpload', () => {
  it('is a single PUT below the threshold', () => {
    expect(planUpload(MULTIPART_THRESHOLD_BYTES - 1))
      .toEqual({ multipart: false, partSize: null, partCount: null })
  })
  it('is multipart at the threshold, and the smallest one is 3 parts', () => {
    expect(planUpload(MULTIPART_THRESHOLD_BYTES))
      .toEqual({ multipart: true, partSize: PART_SIZE_BYTES, partCount: 3 })
  })
  it('rounds the part count up', () => {
    expect(planUpload(PART_SIZE_BYTES * 6 + 1).partCount).toBe(7)
  })
})

describe('partSizeFor', () => {
  it('is the fixed 16 MiB for anything an audio file can be', () => {
    expect(partSizeFor(570_240_000)).toBe(PART_SIZE_BYTES)
  })
  it('grows only to stay under the 10,000-part ceiling', () => {
    const huge = PART_SIZE_BYTES * MAX_PARTS + 1
    const size = partSizeFor(huge)
    expect(size).toBeGreaterThan(PART_SIZE_BYTES)
    expect(Math.ceil(huge / size)).toBeLessThanOrEqual(MAX_PARTS)
    expect(size % (1024 * 1024)).toBe(0)
  })
})

describe('partRange', () => {
  // R2 validates "every non-trailing part is the same length" at
  // CompleteMultipartUpload, i.e. after every byte is uploaded. Offsets are
  // therefore derived from the ONE stored partSize, never recomputed.
  it('is 1-based and contiguous', () => {
    expect(partRange(1, 100, 250)).toEqual({ start: 0, end: 100 })
    expect(partRange(2, 100, 250)).toEqual({ start: 100, end: 200 })
  })
  it('truncates only the final part', () => {
    expect(partRange(3, 100, 250)).toEqual({ start: 200, end: 250 })
  })
  it('rejects a part number outside the file', () => {
    expect(() => partRange(4, 100, 250)).toThrow('part 4 is past')
    expect(() => partRange(0, 100, 250)).toThrow('part numbers are 1-based')
  })
})

describe('contentTypeFor', () => {
  it('maps every container', () => {
    expect(contentTypeFor('mp3')).toBe('audio/mpeg')
    expect(contentTypeFor('flac')).toBe('audio/flac')
    expect(contentTypeFor('m4a')).toBe('audio/mp4')
  })
})
