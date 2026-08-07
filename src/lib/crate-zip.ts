// src/lib/crate-zip.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Turning a crate_get() result into a ZIP PLAN: what the archive is called,
 * what each entry inside it is called, and whether the crate is small
 * enough to serve at all.
 *
 * Deliberately pure — no R2, no `cloudflare:workers`, no Supabase. The
 * route wires those in. Everything that decides a NAME or a LIMIT lives
 * here so it can be tested without a network.
 */

import { capUtf8Bytes, dedupeName, sanitizeSegment } from './zip'

/**
 * The most tracks one archive may carry.
 *
 * A crate is a DJ set, not a library: the real ones run 10-50 tracks. 200
 * is roughly four times the largest plausible set, which makes this a
 * runaway guard rather than a product limit — nobody reaches it by using
 * the feature as intended. It also bounds the sequential R2 opens, since
 * the writer opens one object at a time.
 */
export const MAX_CRATE_DOWNLOAD_TRACKS = 200

/**
 * The most bytes one archive may carry: 6 GiB.
 *
 * This number comes from CPU, not from storage. Store-method ZIP copies
 * bytes, so the only per-byte work in the whole route is CRC32 — measured
 * at 1.24 GB/s (slice-by-8, see zip.ts) on an M-series laptop. Assuming a
 * Worker isolate manages a third of that, 6 GiB is ~15 s of CPU against
 * the platform's 30 s default ceiling: a 2x margin on a pessimistic
 * assumption.
 *
 * The number is chosen to sit ABOVE 4 GiB on purpose. A cap below it would
 * make the ZIP64 path in zip.ts unreachable — dead code that nobody would
 * notice was broken. A 25-track FLAC crate is 1-2 GB, so the realistic
 * case clears this with room to spare.
 */
export const MAX_CRATE_DOWNLOAD_BYTES = 6 * 1024 * 1024 * 1024

/** The longest entry name, in BYTES. Leaves room under every filesystem's 255. */
const MAX_ENTRY_NAME_BYTES = 120

/** The longest archive name, in bytes, before `.zip`. */
const MAX_ARCHIVE_NAME_BYTES = 100

/**
 * The columns of a crate_get() row this module reads. Narrower than
 * org-api's CrateItem on purpose: that type is the RENDERING contract and
 * omits r2_key, which is the one column that matters here.
 */
export type CrateZipRow = {
  file_id: string
  r2_key: string | null
  original_filename: string | null
  display_artist: string | null
  display_title: string | null
  container: string | null
  byte_size: number | null
}

export type CrateZipEntry = {
  fileId: string
  r2Key: string
  /** Sanitized, deduped, byte-capped. Ready for the ZIP writer verbatim. */
  name: string
  /** What the database believes. Only ever a hint; R2 is asked again. */
  byteSize: number
}

export type CrateZipPlan =
  | { ok: true; entries: CrateZipEntry[]; totalBytes: number; archiveName: string }
  | { ok: false; code: 'empty_crate' | 'too_many_tracks' | 'too_large'; message: string }

/**
 * The file extension for an entry.
 *
 * `container` is what the analyser actually found in the bytes, so it beats
 * whatever the uploader's filename claimed. The filename is the fallback,
 * and it is sanitised the same way as everything else because ".fl/ac" is
 * a legal thing to have typed.
 */
export function entryExtension(row: Pick<CrateZipRow, 'container' | 'original_filename'>): string {
  const fromContainer = (row.container ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (fromContainer.length >= 2 && fromContainer.length <= 5) return fromContainer

  const name = row.original_filename ?? ''
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const ext = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (ext.length >= 2 && ext.length <= 5) return ext
  }
  return 'bin'
}

/**
 * `01 - Artist - Title.flac`.
 *
 * The number is the track's INDEX in the crate, not crate_items.position:
 * positions carry gaps (an item hidden by a tombstone is skipped, and
 * reorder renumbers around it), and a folder that jumps 03 -> 05 reads as
 * a missing file. Padded to the width of the crate, minimum two, so the
 * set sorts correctly in any file manager.
 *
 * The artist and title are capped BEFORE the extension is attached, so the
 * cap can never eat the ".flac" that tells the OS what the file is.
 */
export function crateEntryName(
  row: CrateZipRow,
  index: number,
  total: number,
): string {
  const width = Math.max(2, String(total).length)
  const number = String(index + 1).padStart(width, '0')

  const artist = sanitizeSegment(row.display_artist, 'Unknown Artist')
  // A file with no title still has the name it arrived under; that beats a
  // folder of "Untitled (2)", "Untitled (3)".
  const fallbackTitle = (row.original_filename ?? '').replace(/\.[^.]*$/, '')
  const title = sanitizeSegment(row.display_title || fallbackTitle, 'Untitled')

  const ext = entryExtension(row)
  const stem = capUtf8Bytes(`${number} - ${artist} - ${title}`, MAX_ENTRY_NAME_BYTES - ext.length - 1)
  return `${stem}.${ext}`
}

/**
 * The archive's own filename — the crate's name, because that is the
 * folder the user believes they are downloading.
 */
export function crateArchiveName(crateName: string | null | undefined): string {
  return `${capUtf8Bytes(sanitizeSegment(crateName, 'crate'), MAX_ARCHIVE_NAME_BYTES)}.zip`
}

/**
 * Plan the archive, or refuse with a reason the route can render.
 *
 * A row with no r2_key is dropped rather than refused: crate_get already
 * filters to pool-visible states, so a null key here means a row that is
 * mid-flight or whose object was reclaimed, and one such track must not
 * cost the user the other twenty-four.
 */
export function planCrateZip(rows: CrateZipRow[], crateName: string | null): CrateZipPlan {
  const usable = rows.filter((r) => !!r.r2_key)
  if (usable.length === 0) {
    return { ok: false, code: 'empty_crate', message: 'this crate has no downloadable tracks' }
  }
  if (usable.length > MAX_CRATE_DOWNLOAD_TRACKS) {
    return {
      ok: false,
      code: 'too_many_tracks',
      message: `this crate holds ${usable.length} tracks; ${MAX_CRATE_DOWNLOAD_TRACKS} is the most one download can carry`,
    }
  }

  const totalBytes = usable.reduce((sum, r) => sum + Math.max(0, r.byte_size ?? 0), 0)
  if (totalBytes > MAX_CRATE_DOWNLOAD_BYTES) {
    const gib = (totalBytes / (1024 * 1024 * 1024)).toFixed(1)
    const capGib = MAX_CRATE_DOWNLOAD_BYTES / (1024 * 1024 * 1024)
    return {
      ok: false,
      code: 'too_large',
      message: `this crate is ${gib} GB; ${capGib} GB is the most one download can carry`,
    }
  }

  const seen = new Set<string>()
  const entries = usable.map((row, i) => ({
    fileId: row.file_id,
    r2Key: row.r2_key as string,
    name: dedupeName(crateEntryName(row, i, usable.length), seen),
    byteSize: Math.max(0, row.byte_size ?? 0),
  }))

  return { ok: true, entries, totalBytes, archiveName: crateArchiveName(crateName) }
}

/**
 * Content-Disposition for the archive. Two forms, exactly as the
 * single-track route does it: a plain ASCII fallback for old clients and
 * RFC 5987 for everything else.
 */
export function archiveDisposition(archiveName: string): string {
  const ascii = archiveName.replace(/[^\w.\- ]+/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`
}

/**
 * The note that goes in the archive when an object could not be read.
 *
 * A silent gap is the thing to avoid: a DJ who asked for 25 tracks and got
 * 24 must be told which one is missing and why, inside the archive itself,
 * where they will still have it tomorrow.
 */
export function missingManifest(missing: { name: string; reason: string }[]): string {
  return [
    'Some tracks could not be included in this download.',
    '',
    ...missing.map((m) => `  ${m.name} — ${m.reason}`),
    '',
    'The audio for these is not readable from storage right now.',
    'Everything else in this archive is complete and verified.',
    '',
  ].join('\n')
}

/** The filename of that note. Leading underscore sorts it to the top. */
export const MISSING_MANIFEST_NAME = '_missing-tracks.txt'
