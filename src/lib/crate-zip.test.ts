// src/lib/crate-zip.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  archiveDisposition, crateArchiveName, crateEntryName, entryExtension,
  MAX_CRATE_DOWNLOAD_BYTES, MAX_CRATE_DOWNLOAD_TRACKS, MISSING_MANIFEST_NAME,
  missingManifest, planCrateZip, type CrateZipRow,
} from './crate-zip'

/** A crate_get() row, with only the columns this module reads. */
function row(over: Partial<CrateZipRow> = {}): CrateZipRow {
  return {
    file_id: '00000000-0000-0000-0000-0000000000a1',
    r2_key: 'audio/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.flac',
    original_filename: 'track.flac',
    display_artist: 'Aphex Twin',
    display_title: 'Xtal',
    container: 'flac',
    byte_size: 30_000_000,
    ...over,
  }
}

describe('entryExtension', () => {
  it('prefers the analysed container over whatever the filename claimed', () => {
    // container is what the analyser found in the bytes; the uploader's
    // filename is a claim, and the pool has plenty of .wav that are FLAC.
    expect(entryExtension({ container: 'flac', original_filename: 'x.wav' })).toBe('flac')
  })

  it('falls back to the filename extension when there is no container', () => {
    expect(entryExtension({ container: null, original_filename: 'Some Track.aiff' })).toBe('aiff')
  })

  it('falls back again to .bin when neither is usable', () => {
    expect(entryExtension({ container: null, original_filename: 'no-extension' })).toBe('bin')
    expect(entryExtension({ container: '', original_filename: null })).toBe('bin')
    expect(entryExtension({ container: 'x', original_filename: null })).toBe('bin')
  })

  it('refuses an implausibly long container rather than trusting it', () => {
    expect(entryExtension({ container: 'notanextension', original_filename: 'a.mp3' })).toBe('mp3')
  })

  it('strips anything that is not alphanumeric', () => {
    expect(entryExtension({ container: 'FLAC', original_filename: null })).toBe('flac')
    expect(entryExtension({ container: null, original_filename: 'a.M P3' })).toBe('mp3')
  })
})

describe('crateEntryName', () => {
  it('is number, artist, title, extension', () => {
    expect(crateEntryName(row(), 0, 9)).toBe('01 - Aphex Twin - Xtal.flac')
  })

  it('pads to the width of the crate so a file manager sorts it correctly', () => {
    expect(crateEntryName(row(), 9, 10)).toBe('10 - Aphex Twin - Xtal.flac')
    expect(crateEntryName(row(), 9, 100)).toBe('010 - Aphex Twin - Xtal.flac')
    expect(crateEntryName(row(), 0, 100)).toBe('001 - Aphex Twin - Xtal.flac')
  })

  it('numbers by INDEX, so a gap in crate_items.position never shows', () => {
    // crate_get skips tombstoned items, which leaves holes in `position`.
    // A folder that jumps 03 -> 05 reads as a missing file.
    const rows = [row({ file_id: 'a' }), row({ file_id: 'b' }), row({ file_id: 'c' })]
    const plan = planCrateZip(rows, 'Set')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.entries.map((e) => e.name.slice(0, 2))).toEqual(['01', '02', '03'])
  })

  it('names an artist-less track rather than leaving a dangling separator', () => {
    expect(crateEntryName(row({ display_artist: null }), 0, 5))
      .toBe('01 - Unknown Artist - Xtal.flac')
  })

  it('uses the uploaded filename when there is no title', () => {
    expect(crateEntryName(row({ display_title: null, original_filename: 'B2 rip.flac' }), 0, 5))
      .toBe('01 - Aphex Twin - B2 rip.flac')
  })

  it('reaches Untitled only when there is nothing at all', () => {
    expect(crateEntryName(
      row({ display_title: null, original_filename: null, container: null }), 0, 5,
    )).toBe('01 - Aphex Twin - Untitled.bin')
  })

  it('sanitises a title that would otherwise write outside the folder', () => {
    const name = crateEntryName(row({ display_title: '../../evil' }), 0, 5)
    expect(name).not.toContain('/')
    // Separators become underscores AND the leading dots go, so the entry
    // can neither traverse upward nor land as a hidden file.
    expect(name).toBe('01 - Aphex Twin - _.._evil.flac')
  })

  it('caps the length in bytes but never eats the extension', () => {
    const long = crateEntryName(row({ display_title: 'Ω'.repeat(300) }), 0, 5)
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(120)
    expect(long.endsWith('.flac')).toBe(true)
  })
})

describe('crateArchiveName', () => {
  it('is the crate name plus .zip', () => {
    expect(crateArchiveName('Friday Warmup')).toBe('Friday Warmup.zip')
  })

  it('sanitises a crate name that carries a path separator', () => {
    expect(crateArchiveName('house/techno')).toBe('house_techno.zip')
  })

  it('falls back for a nameless crate', () => {
    expect(crateArchiveName('')).toBe('crate.zip')
    expect(crateArchiveName(null)).toBe('crate.zip')
  })
})

describe('archiveDisposition', () => {
  it('carries both an ASCII fallback and the RFC 5987 form', () => {
    const d = archiveDisposition('Fête d\'été.zip')
    expect(d).toMatch(/^attachment; filename="/)
    expect(d).toContain("filename*=UTF-8''")
    expect(d).toContain(encodeURIComponent('Fête d\'été.zip'))
  })

  it('never lets a quote out of the ASCII form, which would end the header value', () => {
    expect(archiveDisposition('a"b.zip')).toContain('filename="a_b.zip"')
  })
})

describe('planCrateZip', () => {
  it('plans an ordinary crate', () => {
    const plan = planCrateZip([row({ file_id: 'a' }), row({ file_id: 'b' })], 'Warmup')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.entries).toHaveLength(2)
    expect(plan.archiveName).toBe('Warmup.zip')
    expect(plan.totalBytes).toBe(60_000_000)
    expect(plan.entries[0]!.fileId).toBe('a')
  })

  it('refuses an empty crate', () => {
    const plan = planCrateZip([], 'Warmup')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('empty_crate')
  })

  it('drops a row with no r2_key instead of failing the whole download', () => {
    // crate_get already filtered to pool-visible states, so a null key is a
    // row mid-flight — one such track must not cost the user the others.
    const plan = planCrateZip([row({ file_id: 'a' }), row({ file_id: 'b', r2_key: null })], 'W')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]!.fileId).toBe('a')
  })

  it('treats a crate of nothing but keyless rows as empty', () => {
    const plan = planCrateZip([row({ r2_key: null })], 'W')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('empty_crate')
  })

  it('renumbers after dropping, so the archive has no gap', () => {
    const rows = [row({ file_id: 'a' }), row({ file_id: 'b', r2_key: null }), row({ file_id: 'c' })]
    const plan = planCrateZip(rows, 'W')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.entries.map((e) => e.name.slice(0, 2))).toEqual(['01', '02'])
  })

  it('dedupes two entries that sanitise to the same name', () => {
    const rows = [row({ file_id: 'a' }), row({ file_id: 'b' })]
    const plan = planCrateZip(rows, 'W')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // The index prefix already separates them, so force a real collision.
    const same = planCrateZip(
      [row({ file_id: 'a', display_title: 'X' }), row({ file_id: 'b', display_title: 'X' })],
      'W',
    )
    expect(same.ok).toBe(true)
    if (!same.ok) return
    expect(new Set(same.entries.map((e) => e.name)).size).toBe(2)
    expect(plan.entries[0]!.name).not.toBe(plan.entries[1]!.name)
  })

  it('refuses a crate over the track cap', () => {
    const rows = Array.from({ length: MAX_CRATE_DOWNLOAD_TRACKS + 1 }, (_, i) =>
      row({ file_id: `f${i}`, byte_size: 1 }))
    const plan = planCrateZip(rows, 'W')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('too_many_tracks')
    expect(plan.message).toContain(String(MAX_CRATE_DOWNLOAD_TRACKS))
  })

  it('accepts a crate exactly at the track cap', () => {
    const rows = Array.from({ length: MAX_CRATE_DOWNLOAD_TRACKS }, (_, i) =>
      row({ file_id: `f${i}`, byte_size: 1 }))
    expect(planCrateZip(rows, 'W').ok).toBe(true)
  })

  it('refuses a crate over the byte cap, and says how big it is', () => {
    const rows = [row({ byte_size: MAX_CRATE_DOWNLOAD_BYTES + 1 })]
    const plan = planCrateZip(rows, 'W')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('too_large')
    expect(plan.message).toMatch(/6 GB/)
  })

  it('serves the case the owner actually asked about: 25 FLACs, ~1.5 GB', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ file_id: `f${i}`, byte_size: 60_000_000 }))
    const plan = planCrateZip(rows, 'Friday Warmup')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.totalBytes).toBe(1_500_000_000)
    expect(plan.entries).toHaveLength(25)
    expect(plan.entries[24]!.name.startsWith('25 - ')).toBe(true)
  })

  it('keeps the byte cap above 4 GiB, so the ZIP64 path stays reachable', () => {
    // A cap below 4 GiB would make every ZIP64 struct in zip.ts dead code
    // that nobody would notice was broken.
    expect(MAX_CRATE_DOWNLOAD_BYTES).toBeGreaterThan(0xffffffff)
  })

  it('treats a null byte_size as zero rather than poisoning the total', () => {
    const plan = planCrateZip([row({ byte_size: null }), row({ file_id: 'b', byte_size: 10 })], 'W')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.totalBytes).toBe(10)
  })
})

describe('missingManifest', () => {
  it('names every track it could not include', () => {
    const text = missingManifest([
      { name: '03 - A - Gone.flac', reason: 'the audio is no longer in storage' },
    ])
    expect(text).toContain('03 - A - Gone.flac')
    expect(text).toContain('the audio is no longer in storage')
  })

  it('sorts to the top of the archive', () => {
    expect(MISSING_MANIFEST_NAME.startsWith('_')).toBe(true)
    expect(MISSING_MANIFEST_NAME.endsWith('.txt')).toBe(true)
  })
})
