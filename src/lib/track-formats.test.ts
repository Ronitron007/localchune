// src/lib/track-formats.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  BITRATE_TITLE, formatBitrate, formatChannels, formatDownloadHref, formatName,
  formatPlayHref, formatSampleFormat, inferredBitrateKbps, showFormats,
  type TrackFormat,
} from './track-formats'

const row = (over: Partial<TrackFormat> = {}): TrackFormat => ({
  file_id: '11111111-2222-4333-8444-555555555555',
  track_id: '99999999-2222-4333-8444-555555555555',
  uploaded_by: 'u-1',
  uploader_name: 'ada',
  original_filename: 'Mochakk - Vida.flac',
  display_artist: 'Mochakk',
  display_title: 'Vida',
  container: 'flac',
  codec: 'flac',
  sample_rate: 44100,
  bit_depth: 16,
  channels: 2,
  byte_size: 30_000_000,
  duration_ms: 300_000,
  bpm: 128,
  key_camelot: '8A',
  key_open: '1m',
  key_musical: 'Am',
  quality_tier: 5,
  quality_score: 0.98,
  lossy_ancestor: 'none',
  meas_cutoff_hz: 22050,
  created_at: '2026-08-01T10:00:00Z',
  is_face: true,
  is_current: true,
  ...over,
})

describe('formatName — the headline word for a row', () => {
  it('leads with the CONTAINER, which is what a member calls the file', () => {
    expect(formatName('flac', 'flac')).toBe('FLAC')
    expect(formatName('mp3', 'mp3')).toBe('MP3')
  })

  it('drops a codec the container already implies', () => {
    // "m4a · aac" says nothing an .m4a did not already say.
    expect(formatName('m4a', 'aac')).toBe('M4A')
    expect(formatName('ogg', 'vorbis')).toBe('OGG')
    expect(formatName('wav', 'pcm_s16le')).toBe('WAV')
  })

  it('KEEPS a codec that contradicts the extension — the ALAC case', () => {
    // An .m4a holding ALAC is a lossless file wearing a lossy-looking
    // extension. That is the one time the codec is worth a word.
    expect(formatName('m4a', 'alac')).toBe('M4A · ALAC')
  })

  it('never guesses a container from the filename', () => {
    // A file whose analysis has not landed has no container. Migration 21's
    // discipline: an absent number is an em dash, not an inference.
    expect(formatName(null, null)).toBe('—')
    expect(formatName('', '')).toBe('—')
  })

  it('falls back to the codec when only that is known', () => {
    expect(formatName(null, 'aac')).toBe('AAC')
  })

  it('survives a row that carries neither key at all', () => {
    // Not hypothetical: an early draft read `codec.trim()` inside the
    // container-missing branch and threw on an undefined codec, taking the
    // whole page down. The seed for that row is "an old file the analyser
    // never finished", which is a row that really exists.
    const missing = undefined as unknown as string | null
    expect(formatName(missing, missing)).toBe('—')
    expect(formatName(missing, 'flac')).toBe('FLAC')
    expect(formatName('flac', missing)).toBe('FLAC')
  })
})

describe('inferredBitrateKbps — real bytes over real duration', () => {
  it('divides size by duration', () => {
    // 12 MB over 300 s = 320 kbps, the classic mp3.
    expect(inferredBitrateKbps(12_000_000, 300_000)).toBe(320)
    // 30 MB over 300 s = 800 kbps, a plausible FLAC.
    expect(inferredBitrateKbps(30_000_000, 300_000)).toBe(800)
  })

  it('returns null rather than 0 when there is nothing honest to divide', () => {
    // An unanalysed file has no measured duration, and 0 kbps would be a
    // claim about the audio rather than an admission about the metadata.
    expect(inferredBitrateKbps(12_000_000, null)).toBeNull()
    expect(inferredBitrateKbps(12_000_000, 0)).toBeNull()
    expect(inferredBitrateKbps(0, 300_000)).toBeNull()
    expect(inferredBitrateKbps(Number.NaN, 300_000)).toBeNull()
  })

  it('is NOT the declared bitrate, and the label says so', () => {
    // Migration 21 dropped files.bitrate_kbps because a 128 kbps transcode
    // remuxed as 320 still DECLARES 320. This number cannot be lied to
    // about size, but it is an average over the whole container — so the
    // `~` and the word "avg" are part of the contract, not decoration.
    expect(formatBitrate(12_000_000, 300_000)).toBe('~320 kbps')
    expect(formatBitrate(12_000_000, null)).toBe('—')
    expect(BITRATE_TITLE).toContain('Average')
    expect(BITRATE_TITLE).toContain('Not the declared bitrate')
  })
})

describe('formatSampleFormat — one field, because it is one fact', () => {
  it('joins rate and depth', () => {
    expect(formatSampleFormat(44100, 16)).toBe('44.1 kHz / 16-bit')
    expect(formatSampleFormat(48000, 24)).toBe('48 kHz / 24-bit')
  })

  it('shows the rate alone for a lossy encode, which has no bit depth', () => {
    expect(formatSampleFormat(44100, null)).toBe('44.1 kHz')
  })

  it('is an em dash when neither is known', () => {
    expect(formatSampleFormat(null, null)).toBe('—')
    expect(formatSampleFormat(0, 0)).toBe('—')
  })
})

describe('formatChannels', () => {
  it('spells out the two a member ever sees', () => {
    expect(formatChannels(1)).toBe('mono')
    expect(formatChannels(2)).toBe('stereo')
  })

  it('counts anything else and refuses to guess at null', () => {
    expect(formatChannels(6)).toBe('6 ch')
    expect(formatChannels(null)).toBe('—')
  })
})

describe('showFormats — a one-row section still earns its heading', () => {
  it('renders for a single-file recording', () => {
    // DECIDED, not overlooked. "Show all the formats available" answered
    // honestly for one file is "one: FLAC, tier 5" — and sample rate and
    // bit depth appeared NOWHERE on this page before this section, so the
    // single row carries information the page did not otherwise state.
    expect(showFormats([row()])).toBe(true)
  })

  it('renders for a merged pair', () => {
    expect(showFormats([row(), row({ file_id: 'b', is_face: false })])).toBe(true)
  })

  it('does NOT render for an empty list', () => {
    // Zero rows is a tombstoned or unanalysed seed. A heading over an empty
    // box would be the page claiming formats exist when none do.
    expect(showFormats([])).toBe(false)
  })
})

describe('the two hrefs a row owns', () => {
  it('play points at THAT file, not at the page it is on', () => {
    // The queue engine keys on file_id, so playing a non-preferred row has
    // to enqueue that row's own id or the wrong encode streams.
    expect(formatPlayHref('abc')).toBe('/track/abc')
  })

  it('download reuses the per-file route every other surface uses', () => {
    expect(formatDownloadHref('abc')).toBe('/api/track/abc/download')
  })
})
