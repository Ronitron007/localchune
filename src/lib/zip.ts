// src/lib/zip.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * A STREAMING, STORE-ONLY ZIP WRITER.
 *
 * WHY HAND-ROLLED RATHER THAN A LIBRARY. Almost all of what a zip library
 * sells is a DEFLATE implementation, and this writer must never deflate:
 * every byte it carries is already-compressed audio (FLAC, MP3, AAC, Opus),
 * where deflate spends CPU to make the file marginally BIGGER. Method 0
 * (store) is the whole point — it is what lets a crate stream out at
 * line rate with nothing buffered but one R2 chunk at a time. Strip the
 * codec and a zip library is a few hundred lines of struct packing, which
 * is what this file is. `client-zip` was the alternative considered: it is
 * genuinely Workers-friendly and streams, but it would add a dependency to
 * the Worker bundle for structs we still have to understand well enough to
 * test, and this repo already hand-rolls the same shape of thing in
 * `s3-xml.ts` rather than take a parser dependency.
 *
 * ZIP64 IS A LIVE PATH HERE, NOT DEAD CODE. A crate of FLACs runs to
 * gigabytes and the download cap (see crate-zip.ts) sits deliberately ABOVE
 * 4 GiB, so the 32-bit fields really do overflow in normal use. Every
 * overflow-capable field is decided per entry at the moment its size is
 * known, and the archive ends with a ZIP64 end-of-central-directory record
 * plus its locator whenever any of them tripped.
 *
 * NOTHING IS BUFFERED. Sizes and CRCs are unknown when an entry's local
 * header goes out, so every entry sets general-purpose bit 3 and reports
 * both in a trailing data descriptor. That is what makes a 6 GiB archive
 * cost a few hundred KB of memory instead of 6 GiB.
 */

/** The value a 32-bit ZIP field carries when the real number lives in ZIP64. */
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_EOCD = 0x06054b50

/** Bit 3: crc and sizes follow the data. Bit 11: the name is UTF-8. */
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800

const METHOD_STORE = 0
const VERSION_BASE = 20
const VERSION_ZIP64 = 45
/** Host 3 = UNIX, so `external attributes` is read as a mode. */
const MADE_BY_UNIX = 3 << 8
/** Regular file, 0644. Without this every entry unpacks as mode 0000 on UNIX. */
const EXTERNAL_ATTRS_FILE = 0o100644 << 16

// ============================================================
// CRC32 — slice-by-8.
//
// This is the ONLY per-byte work in the whole download path, so it decides
// the byte cap. Measured on an M-series laptop: 1.24 GB/s slice-by-8 versus
// 0.36 GB/s for the textbook byte-at-a-time loop — 3.4x, for eight tables
// instead of one. At the Worker's 30 s CPU ceiling that difference is what
// makes a multi-gigabyte crate finish at all.
// ============================================================

/** Eight 256-entry tables, laid end to end in one Int32Array. */
function buildCrcTables(): Int32Array {
  const t = new Int32Array(8 * 256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  for (let i = 0; i < 256; i++) {
    let c = t[i]
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8)
      t[k * 256 + i] = c
    }
  }
  return t
}

const CRC_TABLES = buildCrcTables()

/**
 * Rolling CRC32. Seed with 0 and feed chunks in order; the return of one
 * call is the seed of the next. Returns a SIGNED int32 (>>> 0 at the end
 * to print it) — keeping it signed is what avoids a float round trip per
 * chunk.
 */
export function crc32(buf: Uint8Array, seed = 0): number {
  const t = CRC_TABLES
  let c = ~seed
  let i = 0
  const n = buf.length
  const n8 = n - (n % 8)
  while (i < n8) {
    c ^= buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16) | (buf[i + 3]! << 24)
    c = t[7 * 256 + (c & 0xff)]! ^ t[6 * 256 + ((c >>> 8) & 0xff)]! ^
        t[5 * 256 + ((c >>> 16) & 0xff)]! ^ t[4 * 256 + ((c >>> 24) & 0xff)]! ^
        t[3 * 256 + buf[i + 4]!]! ^ t[2 * 256 + buf[i + 5]!]! ^
        t[1 * 256 + buf[i + 6]!]! ^ t[0 * 256 + buf[i + 7]!]!
    i += 8
  }
  while (i < n) c = t[(c ^ buf[i++]!) & 0xff]! ^ (c >>> 8)
  return ~c
}

// ============================================================
// Byte packing
// ============================================================

/** Little-endian writer over a fixed-size buffer. Every ZIP field is LE. */
class Packer {
  private readonly view: DataView
  private at = 0
  readonly bytes: Uint8Array

  constructor(size: number) {
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }

  u16(v: number): this { this.view.setUint16(this.at, v, true); this.at += 2; return this }
  u32(v: number): this { this.view.setUint32(this.at, v >>> 0, true); this.at += 4; return this }
  /** JS numbers are exact to 2^53, far past any archive this serves. */
  u64(v: number): this { this.view.setBigUint64(this.at, BigInt(v), true); this.at += 8; return this }
  raw(b: Uint8Array): this { this.bytes.set(b, this.at); this.at += b.length; return this }
}

/**
 * MS-DOS date and time, the only timestamp a base ZIP record carries.
 * Two-second resolution, and the epoch is 1980 — a date before that clamps
 * rather than writing a negative year that some readers render as 2107.
 */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getUTCFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

// ============================================================
// Entry names
// ============================================================

/**
 * Everything that is illegal in a path segment on Windows or macOS, plus
 * the C0 controls and DEL. `/` and `\` are in here for a second reason: a
 * name carrying either would unpack as a DIRECTORY somewhere, which is how
 * a zip escapes the folder it was extracted into.
 */
const ILLEGAL_SEGMENT = /[/\\:*?"<>|\x00-\x1f\x7f]/g

/** Reserved DOS device names — still rejected by Win32 today, extension or not. */
const DOS_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * One path segment, safe to write on Windows, macOS and Linux.
 *
 * The trailing-dot and trailing-space strip is not cosmetic: Windows
 * silently DROPS both when creating a file, so "Mix ." and "Mix" collide
 * after extraction even though they are distinct zip entries — and a
 * collision is what makes the second file overwrite the first.
 */
export function sanitizeSegment(raw: string | null | undefined, fallback: string): string {
  let s = (raw ?? '').normalize('NFC').replace(ILLEGAL_SEGMENT, '_')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^\.+/, '')
  s = s.replace(/[. ]+$/, '')
  if (DOS_DEVICE.test(s)) s = `_${s}`
  return s || fallback
}

/**
 * Truncate to a BYTE budget without splitting a character. Filesystems cap
 * a name in bytes, not code points, so a 255-character name of CJK titles
 * is already over the limit on ext4 at 85 characters.
 */
export function capUtf8Bytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= maxBytes) return s
  // Cut by code point (not code unit) so a surrogate pair stays whole.
  const points = Array.from(s)
  let out = ''
  let used = 0
  for (const p of points) {
    const size = enc.encode(p).length
    if (used + size > maxBytes) break
    out += p
    used += size
  }
  return out.replace(/[. ]+$/, '')
}

/**
 * Make `name` unique within `seen`, mutating `seen`. Collisions are real:
 * two rips of the same track differing only by an extension the sanitizer
 * folded, or a crate holding the same recording twice.
 *
 * The counter goes BEFORE the extension (`Track (2).flac`), because a
 * suffix after it produces a file the OS no longer knows how to open.
 * Matching is case-insensitive — macOS and Windows both treat
 * "Track.flac" and "TRACK.FLAC" as one file.
 */
export function dedupeName(name: string, seen: Set<string>): string {
  const key = name.toLowerCase()
  if (!seen.has(key)) { seen.add(key); return name }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10000; n++) {
    const candidate = `${stem} (${n})${ext}`
    const ck = candidate.toLowerCase()
    if (!seen.has(ck)) { seen.add(ck); return candidate }
  }
  /* istanbul ignore next — 9998 identical names is not a reachable crate. */
  const fallback = `${stem} (${Date.now()})${ext}`
  seen.add(fallback.toLowerCase())
  return fallback
}

// ============================================================
// The writer
// ============================================================

export type ZipEntrySource = {
  /** Already sanitized and deduped — this writer does not rewrite names. */
  name: string
  /**
   * The size R2 reported when the object was opened, used ONLY to decide
   * whether this entry needs ZIP64. The sizes actually written are the
   * bytes observed, so a stale number cannot corrupt the archive.
   */
  size: number
  body: ReadableStream<Uint8Array>
  modified?: Date
}

type CentralRecord = {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  time: number
  date: number
  zip64: boolean
}

/** The ZIP64 extended-information extra field, as it appears in a LOCAL header. */
function localZip64Extra(): Uint8Array {
  // header id 0x0001, 16 data bytes: uncompressed then compressed, both 0
  // because bit 3 puts the real values in the data descriptor. Its PRESENCE
  // is the signal that makes the descriptor's size fields 8 bytes wide.
  return new Packer(20).u16(0x0001).u16(16).u64(0).u64(0).bytes
}

function localHeader(name: Uint8Array, time: number, date: number, zip64: boolean): Uint8Array {
  const extra = zip64 ? localZip64Extra() : new Uint8Array(0)
  return new Packer(30 + name.length + extra.length)
    .u32(SIG_LOCAL)
    .u16(zip64 ? VERSION_ZIP64 : VERSION_BASE)
    .u16(FLAG_DESCRIPTOR | FLAG_UTF8)
    .u16(METHOD_STORE)
    .u16(time).u16(date)
    .u32(0).u32(0).u32(0) // crc, compressed, uncompressed — in the descriptor
    .u16(name.length).u16(extra.length)
    .raw(name).raw(extra)
    .bytes
}

/** Store method: compressed size and uncompressed size are the same number. */
function dataDescriptor(crc: number, size: number, zip64: boolean): Uint8Array {
  const p = new Packer(zip64 ? 24 : 16).u32(SIG_DESCRIPTOR).u32(crc)
  if (zip64) p.u64(size).u64(size)
  else p.u32(size).u32(size)
  return p.bytes
}

function centralHeader(r: CentralRecord): Uint8Array {
  // `r.zip64` — not just "the number is big" — because the LOCAL header
  // already committed this entry to ZIP64 and wrote an 8-byte data
  // descriptor. If the central record then described a plain 2.0 entry, a
  // reader that streams local headers and a reader that seeks the central
  // directory would disagree about how wide the descriptor is. Marking the
  // 32-bit fields 0xFFFFFFFF and putting the true values in the extra is
  // the spec's own way of saying "this entry is ZIP64", whatever its size.
  const bigSize = r.zip64 || r.size > U32_MAX
  const bigOffset = r.offset > U32_MAX
  const needs64 = bigSize || bigOffset
  // Field order in the extra block is fixed by the spec: uncompressed,
  // compressed, offset — and ONLY the ones whose 32-bit slot was maxed out.
  let extraLen = 0
  if (needs64) extraLen = 4 + (bigSize ? 16 : 0) + (bigOffset ? 8 : 0)

  const p = new Packer(46 + r.name.length + extraLen)
    .u32(SIG_CENTRAL)
    .u16(MADE_BY_UNIX | (needs64 ? VERSION_ZIP64 : VERSION_BASE))
    .u16(needs64 || r.zip64 ? VERSION_ZIP64 : VERSION_BASE)
    .u16(FLAG_DESCRIPTOR | FLAG_UTF8)
    .u16(METHOD_STORE)
    .u16(r.time).u16(r.date)
    .u32(r.crc)
    .u32(bigSize ? U32_MAX : r.size)
    .u32(bigSize ? U32_MAX : r.size)
    .u16(r.name.length).u16(extraLen)
    .u16(0) // comment length
    .u16(0) // disk number start
    .u16(0) // internal attributes
    .u32(EXTERNAL_ATTRS_FILE)
    .u32(bigOffset ? U32_MAX : r.offset)
    .raw(r.name)

  if (needs64) {
    p.u16(0x0001).u16(extraLen - 4)
    if (bigSize) p.u64(r.size).u64(r.size)
    if (bigOffset) p.u64(r.offset)
  }
  return p.bytes
}

function endOfCentralDirectory(
  count: number, cdSize: number, cdOffset: number, anyZip64: boolean,
): Uint8Array {
  // ZIP64 is required when any of the three EOCD fields overflows — and
  // also emitted whenever an ENTRY is ZIP64, even on an archive small
  // enough not to need it. That is what Info-ZIP does, and readers use the
  // record's presence as the cue to expect ZIP64 extra fields at all. The
  // record is additive: a reader that does not understand it still finds
  // the classic EOCD at the very end and sees the 0xFF.. sentinels.
  const needs64 = anyZip64 || count > U16_MAX || cdSize > U32_MAX || cdOffset > U32_MAX
  const eocd = new Packer(22)
    .u32(SIG_EOCD)
    .u16(0).u16(0)
    .u16(count > U16_MAX ? U16_MAX : count)
    .u16(count > U16_MAX ? U16_MAX : count)
    .u32(cdSize > U32_MAX ? U32_MAX : cdSize)
    .u32(cdOffset > U32_MAX ? U32_MAX : cdOffset)
    .u16(0)
    .bytes
  if (!needs64) return eocd

  const eocd64Offset = cdOffset + cdSize
  const rec64 = new Packer(56)
    .u32(SIG_EOCD64)
    .u64(44) // size of this record minus its signature and this field
    .u16(MADE_BY_UNIX | VERSION_ZIP64)
    .u16(VERSION_ZIP64)
    .u32(0).u32(0)
    .u64(count).u64(count)
    .u64(cdSize).u64(cdOffset)
    .bytes
  const locator = new Packer(20)
    .u32(SIG_EOCD64_LOCATOR)
    .u32(0)
    .u64(eocd64Offset)
    .u32(1)
    .bytes

  const out = new Uint8Array(rec64.length + locator.length + eocd.length)
  out.set(rec64, 0)
  out.set(locator, rec64.length)
  out.set(eocd, rec64.length + locator.length)
  return out
}

/**
 * The archive, as a sequence of chunks.
 *
 * `sources` is consumed LAZILY and one at a time — that is deliberate. The
 * crate route opens each R2 object only when the writer reaches it, so a
 * 200-track crate never has 200 connections in flight, and a client that
 * cancels the download stops the reads immediately.
 */
export async function* zipChunks(
  sources: AsyncIterable<ZipEntrySource>,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  const central: CentralRecord[] = []
  let offset = 0

  for await (const source of sources) {
    const name = encoder.encode(source.name)
    const { time, date } = dosDateTime(source.modified ?? new Date())
    // Decided from the size R2 reported for THIS object a moment ago, not
    // from anything the database remembers.
    const zip64 = source.size > U32_MAX || offset > U32_MAX
    const start = offset

    const header = localHeader(name, time, date, zip64)
    offset += header.length
    yield header

    let crc = 0
    let written = 0
    const reader = source.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value.length === 0) continue
        crc = crc32(value, crc)
        written += value.length
        // A 32-bit size field cannot hold what is now streaming, and the
        // local header already went out saying it could. Abort loudly:
        // a truncated transfer is visible to the user, a silently corrupt
        // archive is not.
        if (!zip64 && written > U32_MAX) {
          throw new Error(`zip: ${source.name} outgrew its declared size past 4 GiB`)
        }
        yield value
      }
    } finally {
      reader.releaseLock()
    }
    offset += written

    const descriptor = dataDescriptor(crc, written, zip64)
    offset += descriptor.length
    yield descriptor

    central.push({ name, crc, size: written, offset: start, time, date, zip64 })
  }

  const cdOffset = offset
  let cdSize = 0
  let anyZip64 = false
  for (const record of central) {
    if (record.zip64 || record.size > U32_MAX || record.offset > U32_MAX) anyZip64 = true
    const bytes = centralHeader(record)
    cdSize += bytes.length
    yield bytes
  }
  yield endOfCentralDirectory(central.length, cdSize, cdOffset, anyZip64)
}

/**
 * `zipChunks` as a ReadableStream, for a Response body.
 *
 * `pull` (not `start`) is what gives this backpressure: the generator is
 * advanced only when the client has taken what it already has, so a DJ on
 * hotel wifi throttles the R2 reads rather than filling the Worker's heap.
 */
export function zipStream(sources: AsyncIterable<ZipEntrySource>): ReadableStream<Uint8Array> {
  const it = zipChunks(sources)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await it.next()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    async cancel(reason) {
      // Runs when the browser cancels the download. Returning the generator
      // runs its `finally` blocks, which release the R2 reader.
      await it.return?.(reason)
    },
  })
}
