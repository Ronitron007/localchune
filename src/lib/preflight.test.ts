// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  classifyDuration, preflightFile, formatDuration, readDurationMs, UNKNOWN_DURATION,
  type DurationRead,
} from './preflight'
import { parseAudioHeader } from './preflight.worker'
import { MAX_DURATION_MS } from './upload-policy'

// ---------------------------------------------------------------- fixtures
// Every fixture is bytes we author here. No .mp3 checked into the repo, and
// no ffmpeg on the test machine.

/** 42 bytes: 'fLaC' + a last-block STREAMINFO. Duration is totalSamples/rate. */
function synthFlac(totalSamples: number, sampleRate = 44100): Blob {
  const b = new Uint8Array(4 + 4 + 34)
  b.set([0x66, 0x4c, 0x61, 0x43], 0)          // 'fLaC'
  b[4] = 0x80                                  // last-metadata-block | type 0
  b[7] = 34                                    // block length
  const v = new DataView(b.buffer)
  v.setUint16(8, 4096); v.setUint16(10, 4096)  // min/max block size
  // 20 bits sampleRate | 3 bits (channels-1) | 5 bits (bps-1) | 36 bits samples
  const packed = (BigInt(sampleRate) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(totalSamples)
  v.setBigUint64(18, packed)
  return new Blob([b], { type: 'audio/flac' })
}

/** A real 44-byte RIFF header followed by `dataBytes` of silence. */
function synthWav(dataBytes: number, sampleRate = 44100): Uint8Array<ArrayBuffer>[] {
  const channels = 2, bitsPerSample = 16
  const blockAlign = channels * (bitsPerSample / 8)
  const h = new Uint8Array(44)
  const v = new DataView(h.buffer)
  const ascii = (s: string, off: number) => {
    for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i)
  }
  ascii('RIFF', 0); v.setUint32(4, 36 + dataBytes, true); ascii('WAVE', 8)
  ascii('fmt ', 12); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * blockAlign, true); v.setUint16(32, blockAlign, true)
  v.setUint16(34, bitsPerSample, true)
  ascii('data', 36); v.setUint32(40, dataBytes, true)
  return [h, new Uint8Array(dataBytes)]
}

/** MPEG-1 Layer III, 44.1 kHz, stereo, no CRC. frameSize = 144*bitrate/44100. */
const MP3_FRAME: Record<number, { byte2: number; size: number }> = {
  128: { byte2: 0x90, size: 417 },
  192: { byte2: 0xb0, size: 626 },
}

function mp3Frame(kbps: number): Uint8Array<ArrayBuffer> {
  const f = MP3_FRAME[kbps]
  const b = new Uint8Array(f.size)
  b[0] = 0xff; b[1] = 0xfb; b[2] = f.byte2; b[3] = 0x00
  return b
}

/** One bitrate = CBR. Alternating bitrates = VBR, and no Xing header either way. */
function synthMp3(bitrates: number[], repeat: number): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let i = 0; i < repeat; i++) for (const k of bitrates) parts.push(mp3Frame(k))
  return new Blob(parts, { type: 'audio/mpeg' })
}

/** Counts every byte the parser actually pulls out of the blob. */
class CountingBlob extends Blob {
  bytesRead = 0
  slice(start?: number, end?: number, type?: string): Blob {
    this.bytesRead += (end ?? this.size) - (start ?? 0)
    return super.slice(start, end, type)
  }
}

// ---------------------------------------------------------------- pure logic

describe('classifyDuration', () => {
  it('trusts a container-header duration', () => {
    expect(classifyDuration({ durationSec: 372, bitrate: 320_000, byteSize: 14_880_000, container: 'MPEG' }))
      .toEqual({ durationMs: 372_000, source: 'header' })
  })
  it('falls back to bitrate x size when the header carried no duration', () => {
    const read = classifyDuration({ durationSec: null, bitrate: 192_000, byteSize: 521_500, container: 'MPEG' })
    expect(read.source).toBe('estimate')
    expect(read.durationMs).toBe(Math.round((521_500 * 8 * 1000) / 192_000))
  })
  it('is unknown when there is neither', () => {
    expect(classifyDuration({ durationSec: null, bitrate: null, byteSize: 1000, container: null }).source)
      .toBe('unknown')
  })
  it('treats a zero or non-finite duration as absent', () => {
    expect(classifyDuration({ durationSec: 0, bitrate: null, byteSize: 10, container: null }).source).toBe('unknown')
    expect(classifyDuration({ durationSec: Number.NaN, bitrate: null, byteSize: 10, container: null }).source).toBe('unknown')
  })
})

describe('preflightFile', () => {
  const header = (ms: number): DurationRead => ({ durationMs: ms, source: 'header' })
  const estimate = (ms: number): DurationRead => ({ durationMs: ms, source: 'estimate' })

  it('sends a header duration to the server and accepts', () => {
    const p = preflightFile({ name: 'track.mp3', size: 14_000_000 }, header(372_000))
    expect(p.verdict.ok).toBe(true)
    expect(p.clientDurationMs).toBe(372_000)
    expect(p.estimated).toBe(false)
  })

  it('rejects a header duration over 15 minutes', () => {
    const p = preflightFile({ name: 'set.flac', size: 300_000_000 }, header(MAX_DURATION_MS + 1))
    expect(p.verdict).toEqual({ ok: false, reason: 'too_long' })
    expect(p.message).toContain('15 minutes')
  })

  // THE decision of this task: an estimate never rejects, and never reaches
  // ingest_jobs.client_duration_ms. The size gate and M3's decode are the
  // enforcement. A first-frame bitrate is wrong in BOTH directions.
  it('never rejects on an estimate, and never sends one', () => {
    const p = preflightFile({ name: 'vbr.mp3', size: 20_000_000 }, estimate(1_200_000))
    expect(p.verdict.ok).toBe(true)
    expect(p.clientDurationMs).toBeNull()
    expect(p.displayDurationMs).toBe(1_200_000)
    expect(p.estimated).toBe(true)
    expect(p.message).toContain('estimate')
  })

  it('still applies the size gate to an estimate', () => {
    const p = preflightFile({ name: 'dj-set.mp3', size: 288_000_000 }, estimate(300_000))
    expect(p.verdict).toEqual({ ok: false, reason: 'too_large' })
  })

  it('accepts a file whose duration could not be read at all', () => {
    const p = preflightFile({ name: 'weird.ogg', size: 9_000_000 }, UNKNOWN_DURATION)
    expect(p.verdict.ok).toBe(true)
    expect(p.clientDurationMs).toBeNull()
    expect(p.displayDurationMs).toBeNull()
  })

  it('rejects an unsupported container whatever the duration says', () => {
    const p = preflightFile({ name: 'mix.exe', size: 10 }, header(1000))
    expect(p.verdict).toEqual({ ok: false, reason: 'unsupported_container' })
  })
})

describe('formatDuration', () => {
  it('is mm:ss', () => {
    expect(formatDuration(372_000)).toBe('6:12')
    expect(formatDuration(9_000)).toBe('0:09')
    expect(formatDuration(null)).toBe('--:--')
  })
})

// ------------------------------------------------- real music-metadata parse

describe('parseAudioHeader', () => {
  it('reads FLAC duration out of STREAMINFO in 42 bytes', async () => {
    const facts = await parseAudioHeader(synthFlac(44_100 * 372))
    expect(facts.container).toBe('FLAC')
    expect(facts.durationSec).toBeCloseTo(372, 6)
    expect(classifyDuration(facts)).toEqual({ durationMs: 372_000, source: 'header' })
  })

  it('reads an 8 MiB WAV without reading the audio', async () => {
    const blob = new CountingBlob(synthWav(8 * 1024 * 1024), { type: 'audio/wav' })
    const facts = await parseAudioHeader(blob)
    expect(facts.durationSec).toBeCloseTo(47.554, 3)
    // Constraint 16: never pull the payload into memory. 79 bytes, measured.
    expect(blob.bytesRead).toBeLessThan(4096)
  })

  it('is silently WRONG on a truncated prefix — never slice before parsing', async () => {
    const whole = new Blob(synthWav(8 * 1024 * 1024), { type: 'audio/wav' })
    const facts = await parseAudioHeader(whole.slice(0, 65536))
    expect(facts.durationSec).toBeCloseTo(0.371, 3)   // not 47.554, and no error
  })

  it('gets a CBR MP3 duration from the frame header plus the file size', async () => {
    const facts = await parseAudioHeader(synthMp3([128], 500))
    expect(facts.container).toBe('MPEG')
    expect(facts.durationSec).toBeCloseTo(13.06, 2)
    expect(classifyDuration(facts).source).toBe('header')
  })

  it('gets NO duration from a VBR MP3 with no Xing header', async () => {
    const facts = await parseAudioHeader(synthMp3([128, 192], 500))
    expect(facts.durationSec).toBeNull()
    expect(facts.bitrate).toBeGreaterThan(0)
    const read = classifyDuration(facts)
    expect(read.source).toBe('estimate')
    // True length is 1000 frames x 1152 / 44100 = 26.12 s. The estimate is
    // ~21.7 s — 17% low — because one frame's bitrate is not the average.
    expect(read.durationMs! / 1000).toBeLessThan(26)
  })

  it('rejects bytes it cannot identify, rather than inventing a duration', async () => {
    await expect(parseAudioHeader(new Blob([new Uint8Array(64)]))).rejects.toThrow()
  })
})

describe('readDurationMs', () => {
  // Node has Blob but no Worker, so this exercises the inline fallback path
  // that a browser without module workers would take. The worker path itself
  // is browser-only and is verified by hand in Step 8.
  it('falls back to an inline parse when there is no Worker global', async () => {
    expect(typeof Worker).toBe('undefined')
    expect(await readDurationMs(synthFlac(44_100 * 372)))
      .toEqual({ durationMs: 372_000, source: 'header' })
  })

  it('never throws — an unreadable file is an unknown duration', async () => {
    const read = await readDurationMs(new Blob([new Uint8Array(64)]))
    expect(read.source).toBe('unknown')
    expect(read.durationMs).toBeNull()
  })
})
