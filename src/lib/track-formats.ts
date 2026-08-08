// src/lib/track-formats.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * THE FORMATS SECTION on /track/[id] — the pure half.
 *
 * OWNER, 2026-08-08: "no way to select the format to play....instead what
 * should happen is each track detail page should show all the different
 * formats available."
 *
 * Migration 38's `track_formats(uuid)` answers WHICH files. This module
 * answers HOW EACH ONE READS, and it holds no DOM and no network so the
 * whole vocabulary is unit-testable.
 *
 * NOTHING HERE SORTS. The server ordered the list (preferred first, then
 * tier, then inferred bitrate) and re-deciding it in the client is how two
 * surfaces come to disagree about which encode is best. The row order this
 * module sees is the row order it renders.
 */

/** One row of `track_formats(uuid)`, migration 38. A strict subset of
 *  pool_get's vocabulary plus the four technical columns pool_tracks does
 *  not carry (codec, sample_rate, bit_depth, channels) — and no raw_tags
 *  and no r2_key, because the function returns neither. */
export type TrackFormat = {
  file_id: string
  track_id: string | null
  uploaded_by: string
  uploader_name: string
  original_filename: string
  display_artist: string | null
  display_title: string
  container: string | null
  codec: string | null
  sample_rate: number | null
  bit_depth: number | null
  channels: number | null
  byte_size: number
  duration_ms: number | null
  bpm: number | null
  key_camelot: string | null
  key_open: string | null
  key_musical: string | null
  quality_tier: number | null
  quality_score: number | null
  lossy_ancestor: string | null
  meas_cutoff_hz: number | null
  created_at: string
  /** `track_face_file()`'s verdict (migration 34), surfaced as a boolean.
   *  The row the collapsed surfaces show; labelled "preferred" here. */
  is_face: boolean
  /** The file whose page this is. */
  is_current: boolean
}

/**
 * THE HEADLINE WORD FOR A ROW: FLAC, MP3, M4A, AAC…
 *
 * The CONTAINER leads, not the codec, because the container is what a
 * member's file manager, DJ software and ears all call the thing — "the
 * flac" and "the 320" are how the owner asked the question. The codec is
 * shown beside it only when it says something the container did not: an
 * `.m4a` holding AAC is an m4a to everyone, but an `.m4a` holding ALAC is a
 * lossless file wearing a lossy-looking extension, and that is worth a
 * word.
 *
 * Upper-cased, and never invented: a file whose analysis has not written a
 * container yet reads as the honest em dash rather than being guessed at
 * from the filename. Migration 21's discipline, applied to a label.
 */
export function formatName(container: string | null, codec: string | null): string {
  // Both coalesced ONCE, before either is read. An earlier draft tested
  // `codec.trim()` inside the container-missing branch and threw on a row
  // that simply had no codec key — the exact failure a page must not have,
  // because the seed for it is "an old file the analyser never finished".
  const c = (container ?? '').trim()
  const cod = (codec ?? '').trim().toUpperCase()
  if (c === '') return cod === '' ? '—' : cod
  const box = c.toUpperCase()
  // Same word twice ("MP3 · mp3") is noise. So is the pairing everybody
  // already assumes: m4a/aac, ogg/vorbis, flac/flac, wav/pcm.
  const IMPLIED: Record<string, string[]> = {
    M4A: ['AAC'], MP4: ['AAC'], OGG: ['VORBIS'], OPUS: ['OPUS'],
    FLAC: ['FLAC'], WAV: ['PCM_S16LE', 'PCM_S24LE', 'PCM'], AIFF: ['PCM'],
    MP3: ['MP3'],
  }
  if (cod === '' || cod === box || (IMPLIED[box] ?? []).includes(cod)) return box
  return `${box} · ${cod}`
}

/**
 * THE BITRATE, INFERRED — and the word "inferred" is load-bearing.
 *
 * Migration 21 dropped `files.bitrate_kbps` and stated why: the only number
 * available from a container is the DECLARED bitrate, and declared bitrate
 * lies — a 128 kbps transcode remuxed as 320 still declares 320. Nothing
 * re-adds it.
 *
 * This is a different number. Real bytes counted at upload, divided by the
 * real duration the analyser measured. It cannot lie about the file's size,
 * but it is an AVERAGE over the whole container — the tag block and any
 * embedded artwork are in the numerator — so a three-minute MP3 with a 2 MB
 * cover reads high. It is therefore rendered with a `~` and the word
 * "avg", never as a spec.
 *
 * Returns null rather than a number when there is nothing honest to divide:
 * a file with no measured duration has no average bitrate, and 0 would be a
 * claim.
 */
export function inferredBitrateKbps(
  byteSize: number, durationMs: number | null,
): number | null {
  if (!Number.isFinite(byteSize) || byteSize <= 0) return null
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null
  // bytes * 8 bits / (ms / 1000) s = bits per second; / 1000 = kbps.
  return Math.round((byteSize * 8) / durationMs)
}

/** The same figure as a string, with the two marks that say "approximate".
 *  One function so the `~` and the unit cannot be typed differently on two
 *  surfaces. */
export function formatBitrate(byteSize: number, durationMs: number | null): string {
  const kbps = inferredBitrateKbps(byteSize, durationMs)
  return kbps === null ? '—' : `~${kbps} kbps`
}

/** Why the figure carries a `~`. Attached to the number as a tooltip so the
 *  caveat travels with the claim instead of living in a legend. */
export const BITRATE_TITLE =
  'Average over the whole file: size divided by duration, so tags and embedded artwork count toward it. Not the declared bitrate — a transcode can declare anything.'

/**
 * Sample rate and bit depth, as one field, because they are read as one
 * fact ("44.1 kHz / 16-bit"). A lossy encode has no meaningful bit depth
 * and the analyser leaves it null; the field then shows the rate alone
 * rather than inventing 16.
 */
export function formatSampleFormat(
  sampleRate: number | null, bitDepth: number | null,
): string {
  const rate = typeof sampleRate === 'number' && sampleRate > 0
    ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`
    : null
  const depth = typeof bitDepth === 'number' && bitDepth > 0 ? `${bitDepth}-bit` : null
  if (rate === null && depth === null) return '—'
  return [rate, depth].filter((s) => s !== null).join(' / ')
}

/** Mono/stereo, spelled out; anything else says how many. Null stays an
 *  em dash — an unanalysed file has no channel count, and "stereo" would
 *  be a guess. */
export function formatChannels(channels: number | null): string {
  if (typeof channels !== 'number' || channels <= 0) return '—'
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels} ch`
}

/**
 * SHOULD THE SECTION RENDER AT ALL?
 *
 * Yes for one row as well as for many, and this is a decision rather than
 * an oversight. The owner's ask was "show all the different formats
 * available" — for a single-file recording the honest answer to that is
 * "one: FLAC, tier 5, 30.1 MB", which is information the page did not
 * otherwise state in one place (container and size live in Source quality,
 * sample rate and bit depth lived NOWHERE before this section). A member
 * who is deciding whether to download needs the same row either way, and a
 * section that vanishes for some tracks teaches nobody where to look.
 *
 * NO for an empty list, which is not the same case. Zero rows means the
 * RPC found nothing pool-visible — a tombstoned or unanalysed seed — and a
 * heading over an empty box would be the page saying "there are formats"
 * when there are none.
 */
export function showFormats(rows: TrackFormat[]): boolean {
  return rows.length > 0
}

/** The queue entry a Formats row plays is THAT file, not the page's file.
 *  Named here so the page and its test agree on the contract site.ts
 *  scrapes: `a.play[data-track-id]` carrying its own five data-* values. */
export function formatPlayHref(fileId: string): string {
  return `/track/${fileId}`
}

/** Per-row download reuses the route every other surface uses. */
export function formatDownloadHref(fileId: string): string {
  return `/api/track/${fileId}/download`
}
