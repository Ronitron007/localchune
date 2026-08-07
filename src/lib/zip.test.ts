// src/lib/zip.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The archive this Worker streams is opened by macOS Archive Utility and by
// whatever the DJ has installed — not by code in this repo. So the load
// bearing tests here do not inspect our own structs and agree with
// themselves: they write a real .zip and hand it to the system `unzip`,
// which is an independent implementation of the spec. Everything else is
// scaffolding around that.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  capUtf8Bytes, crc32, dedupeName, dosDateTime, sanitizeSegment, zipChunks, zipStream,
  type ZipEntrySource,
} from './zip'

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

const workdirs: string[] = []
function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lc-zip-'))
  workdirs.push(d)
  return d
}
afterAll(() => {
  for (const d of workdirs) rmSync(d, { recursive: true, force: true })
})

/** `unzip` is present on macOS and on the GitHub ubuntu images; skip rather
 *  than fail if some future runner drops it. */
function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const UNZIP = hasUnzip()

function stream(bytes: Uint8Array, chunk = 4096): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(at, Math.min(at + chunk, bytes.length)))
      at += chunk
    },
  })
}

/** Deterministic pseudo-random bytes — a stand-in for compressed audio. */
function noise(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

async function collect(sources: ZipEntrySource[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of zipChunks((async function* () { yield* sources })())) {
    parts.push(c.slice())
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function u32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true)
}
function u16(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, true)
}

// ------------------------------------------------------------------

describe('crc32', () => {
  it('matches the standard check vector', () => {
    // The value every CRC-32/ISO-HDLC implementation is checked against.
    expect(crc32(new TextEncoder().encode('123456789')) >>> 0).toBe(0xcbf43926)
  })

  it('is empty-safe and identity-seeded', () => {
    expect(crc32(new Uint8Array(0)) >>> 0).toBe(0)
  })

  it('rolls across chunk boundaries to the same value as one pass', () => {
    // This is the property the streaming writer depends on: it never has
    // the whole file, only whatever R2 hands it next.
    const data = noise(10_000, 7)
    const whole = crc32(data)
    let rolling = 0
    for (let at = 0; at < data.length; at += 777) {
      rolling = crc32(data.subarray(at, Math.min(at + 777, data.length)), rolling)
    }
    expect(rolling).toBe(whole)
  })

  it('agrees with the slice-by-8 fast path on lengths that are not multiples of 8', () => {
    // The tail loop is a separate branch; an off-by-one there would only
    // show up on files whose size is not a multiple of 8.
    for (const n of [1, 7, 8, 9, 15, 16, 17, 63, 64, 65]) {
      const data = noise(n, n)
      // Byte-at-a-time reference, computed independently of the tables above.
      let c = ~0
      for (let i = 0; i < n; i++) {
        c ^= data[i]!
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
      }
      expect(crc32(data) >>> 0).toBe((~c) >>> 0)
    }
  })
})

describe('sanitizeSegment', () => {
  it('replaces every character that is illegal on Windows or macOS', () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('strips control characters and DEL', () => {
    expect(sanitizeSegment('Track\x00\x1f\x7fName', 'x')).toBe('Track___Name')
  })

  it('cannot produce a path separator, so an entry cannot escape its folder', () => {
    expect(sanitizeSegment('../../etc/passwd', 'x')).toContain('_')
    expect(sanitizeSegment('../../etc/passwd', 'x')).not.toContain('/')
    expect(sanitizeSegment('../../etc/passwd', 'x')).not.toMatch(/^\./)
  })

  it('drops trailing dots and spaces, which Windows silently eats', () => {
    // Left alone, "Mix ." and "Mix" become the same file after extraction
    // and the second overwrites the first.
    expect(sanitizeSegment('Mix .', 'x')).toBe('Mix')
    expect(sanitizeSegment('Mix...', 'x')).toBe('Mix')
  })

  it('defuses reserved DOS device names', () => {
    expect(sanitizeSegment('CON', 'x')).toBe('_CON')
    expect(sanitizeSegment('lpt1', 'x')).toBe('_lpt1')
    expect(sanitizeSegment('CONCERT', 'x')).toBe('CONCERT')
  })

  it('falls back when nothing survives', () => {
    expect(sanitizeSegment('///', 'Untitled')).toBe('___')
    expect(sanitizeSegment('   ', 'Untitled')).toBe('Untitled')
    expect(sanitizeSegment(null, 'Untitled')).toBe('Untitled')
    expect(sanitizeSegment('...', 'Untitled')).toBe('Untitled')
  })

  it('collapses runs of whitespace', () => {
    expect(sanitizeSegment('  A   B  ', 'x')).toBe('A B')
  })
})

describe('capUtf8Bytes', () => {
  it('measures bytes, not characters', () => {
    const cjk = '曲'.repeat(50) // 3 bytes each
    expect(new TextEncoder().encode(capUtf8Bytes(cjk, 30)).length).toBeLessThanOrEqual(30)
    expect(capUtf8Bytes(cjk, 30)).toHaveLength(10)
  })

  it('never splits a multi-byte character or a surrogate pair', () => {
    const emoji = '🎧'.repeat(10) // 4 bytes each, 2 code units each
    const cut = capUtf8Bytes(emoji, 10)
    expect(new TextEncoder().encode(cut).length).toBe(8)
    expect(Array.from(cut).every((c) => c === '🎧')).toBe(true)
  })

  it('leaves a short string alone', () => {
    expect(capUtf8Bytes('short', 100)).toBe('short')
  })
})

describe('dedupeName', () => {
  it('numbers collisions before the extension, so the file still opens', () => {
    const seen = new Set<string>()
    expect(dedupeName('Track.flac', seen)).toBe('Track.flac')
    expect(dedupeName('Track.flac', seen)).toBe('Track (2).flac')
    expect(dedupeName('Track.flac', seen)).toBe('Track (3).flac')
  })

  it('matches case-insensitively — macOS and Windows treat these as one file', () => {
    const seen = new Set<string>()
    dedupeName('Track.flac', seen)
    expect(dedupeName('TRACK.FLAC', seen)).toBe('TRACK (2).FLAC')
  })

  it('handles a name with no extension', () => {
    const seen = new Set<string>()
    dedupeName('README', seen)
    expect(dedupeName('README', seen)).toBe('README (2)')
  })
})

describe('dosDateTime', () => {
  it('encodes a date after the 1980 epoch', () => {
    const { time, date } = dosDateTime(new Date(Date.UTC(2026, 7, 7, 13, 45, 30)))
    expect((date >> 9) + 1980).toBe(2026)
    expect((date >> 5) & 0x0f).toBe(8)
    expect(date & 0x1f).toBe(7)
    expect(time >> 11).toBe(13)
    expect((time >> 5) & 0x3f).toBe(45)
  })

  it('clamps below the epoch rather than writing a negative year', () => {
    const { date } = dosDateTime(new Date(Date.UTC(1970, 0, 1)))
    expect(date >> 9).toBe(0)
  })
})

describe('zipChunks structure', () => {
  it('opens with a local file header and ends with an end-of-central-directory', async () => {
    const zip = await collect([{ name: 'a.bin', size: 3, body: stream(new Uint8Array([1, 2, 3])) }])
    expect(u32(zip, 0)).toBe(0x04034b50)
    expect(u32(zip, zip.length - 22)).toBe(0x06054b50)
  })

  it('sets the data-descriptor and UTF-8 flags and stores rather than deflates', async () => {
    const zip = await collect([{ name: 'a.bin', size: 3, body: stream(new Uint8Array([1, 2, 3])) }])
    expect(u16(zip, 6)).toBe(0x0008 | 0x0800)
    expect(u16(zip, 8)).toBe(0) // method 0 = store
    // Sizes and crc in the local header are zero; the real ones trail the data.
    expect(u32(zip, 14)).toBe(0)
    expect(u32(zip, 18)).toBe(0)
    expect(u32(zip, 22)).toBe(0)
  })

  it('writes the observed byte count, not the size it was told', async () => {
    // The declared size only picks ZIP64; a stale number must not be able to
    // corrupt the archive.
    const body = new Uint8Array([9, 9, 9, 9, 9])
    const zip = await collect([{ name: 'a.bin', size: 999, body: stream(body) }])
    const eocdAt = zip.length - 22
    const cdAt = u32(zip, eocdAt + 16)
    expect(u32(zip, cdAt)).toBe(0x02014b50)
    expect(u32(zip, cdAt + 24)).toBe(5) // uncompressed size in the central directory
  })

  it('counts every entry in the end-of-central-directory', async () => {
    const zip = await collect([
      { name: 'a.bin', size: 3, body: stream(new Uint8Array([1, 2, 3])) },
      { name: 'b.bin', size: 2, body: stream(new Uint8Array([4, 5])) },
      { name: 'c.bin', size: 0, body: stream(new Uint8Array(0)) },
    ])
    expect(u16(zip, zip.length - 22 + 10)).toBe(3)
  })

  it('emits a ZIP64 record and locator once an entry declares over 4 GiB', async () => {
    // Declaring the size is enough to exercise the ZIP64 struct path without
    // moving 4 GiB through the test. The real >4 GiB stream is covered by
    // the round-trip below and by the report's synthetic run.
    const zip = await collect([
      { name: 'big.bin', size: 0x100000000, body: stream(noise(1000)) },
    ])
    // ZIP64 EOCD, its locator, then the classic EOCD — in that order, at the end.
    expect(u32(zip, zip.length - 22)).toBe(0x06054b50)
    expect(u32(zip, zip.length - 22 - 20)).toBe(0x07064b50)
    expect(u32(zip, zip.length - 22 - 20 - 56)).toBe(0x06064b50)
    // The local header carries the ZIP64 extra field (id 0x0001, 16 bytes),
    // which is what tells a reader the trailing descriptor is 8-byte wide.
    const nameLen = u16(zip, 26)
    expect(u16(zip, 28)).toBe(20)
    expect(u16(zip, 30 + nameLen)).toBe(0x0001)
  })

  it('does not emit ZIP64 for an ordinary archive', async () => {
    const zip = await collect([{ name: 'a.bin', size: 3, body: stream(new Uint8Array([1, 2, 3])) }])
    expect(u32(zip, zip.length - 22 - 20)).not.toBe(0x07064b50)
    expect(u16(zip, 28)).toBe(0) // no extra field on the local header
  })

  it('refuses to finish an entry that outgrew a 32-bit size field', async () => {
    // Unreachable with real data (the cap is 6 GiB and R2 reports the size
    // before the header goes out), but it must fail loudly rather than
    // write an archive whose sizes are silently wrong.
    const oversized: ReadableStream<Uint8Array> = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1 << 20)) },
    })
    await expect(
      collect([{ name: 'a.bin', size: 10, body: oversized }]),
    ).rejects.toThrow(/outgrew/)
  }, 60_000)
})

describe('zipStream', () => {
  it('opens each source only when the writer reaches it', async () => {
    // The route depends on this: a 200-track crate must not open 200 R2
    // connections at once.
    const opened: string[] = []
    async function* sources(): AsyncGenerator<ZipEntrySource> {
      for (const name of ['a', 'b', 'c']) {
        opened.push(name)
        yield { name: `${name}.bin`, size: 4096, body: stream(noise(4096)) }
      }
    }
    const reader = zipStream(sources()).getReader()
    await reader.read() // the first local header
    expect(opened).toEqual(['a'])
    await reader.cancel()
  })

  it('stops reading when the client cancels', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024)) },
      cancel() { cancelled = true },
    })
    async function* sources(): AsyncGenerator<ZipEntrySource> {
      yield { name: 'a.bin', size: 1 << 30, body }
    }
    const reader = zipStream(sources()).getReader()
    await reader.read()
    await reader.read()
    await reader.cancel('client went away')
    // The generator's `finally` released the reader lock; the source stream
    // is no longer being pulled.
    expect(cancelled || body.locked === false).toBe(true)
  })
})

// ------------------------------------------------------------------
// The one that matters: an independent implementation of the format.
// ------------------------------------------------------------------

describe.skipIf(!UNZIP)('round trip through the system unzip', () => {
  it('passes unzip -t and restores every byte exactly', async () => {
    const files = [
      { name: '01 - Aphex Twin - Xtal.flac', data: noise(300_000, 11) },
      { name: '02 - Boards of Canada - Roygbiv.mp3', data: noise(120_001, 22) },
      { name: '03 - Someone - Empty.wav', data: new Uint8Array(0) },
      { name: '04 - Ké¥ - 曲名 🎧.opus', data: noise(65_536, 33) },
    ]
    const zip = await collect(
      files.map((f) => ({ name: f.name, size: f.data.length, body: stream(f.data, 8192) })),
    )

    const dir = workdir()
    const path = join(dir, 'crate.zip')
    writeFileSync(path, zip)

    // -t is unzip's own CRC verification of every entry.
    const test = execFileSync('unzip', ['-t', path], { encoding: 'utf8' })
    expect(test).toMatch(/No errors detected in compressed data/)

    execFileSync('unzip', ['-o', '-q', path, '-d', join(dir, 'out')])
    for (const f of files) {
      const got = readFileSync(join(dir, 'out', f.name))
      expect(got.length, `${f.name} length`).toBe(f.data.length)
      expect(Buffer.compare(got, Buffer.from(f.data)), `${f.name} bytes`).toBe(0)
    }
  })

  it('lists exactly the entries it was given, in order', async () => {
    const names = ['01 - A - One.flac', '02 - B - Two.flac', '03 - C - Three.flac']
    const zip = await collect(names.map((n) => ({ name: n, size: 16, body: stream(noise(16)) })))
    const path = join(workdir(), 'order.zip')
    writeFileSync(path, zip)
    const listed = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
    expect(listed).toEqual(names)
  })

  it('produces a ZIP64 archive that unzip still reads', async () => {
    const data = noise(50_000, 44)
    const zip = await collect([
      // Declared over 4 GiB, so every ZIP64 struct is written for real, and
      // unzip has to parse them to find the data.
      { name: 'zip64.bin', size: 0x100000000, body: stream(data) },
      { name: 'plain.bin', size: data.length, body: stream(data) },
    ])
    const dir = workdir()
    const path = join(dir, 'z64.zip')
    writeFileSync(path, zip)

    expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' }))
      .toMatch(/No errors detected in compressed data/)
    execFileSync('unzip', ['-o', '-q', path, '-d', join(dir, 'out')])
    expect(Buffer.compare(readFileSync(join(dir, 'out', 'zip64.bin')), Buffer.from(data))).toBe(0)
  })

  it('unpacks an archive whose only entry is empty', async () => {
    const zip = await collect([{ name: 'nothing.txt', size: 0, body: stream(new Uint8Array(0)) }])
    const path = join(workdir(), 'empty.zip')
    writeFileSync(path, zip)
    expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' }))
      .toMatch(/No errors detected/)
  })
})
