// src/lib/head-check.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { HEAD_CHECK_BYTES, checkBlobHead, checkHead, extensionOf } from './head-check'

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** Build a head: leading bytes given, the rest padded with `pad`. */
const head = (bytes: number[], length = 512, pad = 0x11): Uint8Array => {
  const out = new Uint8Array(length).fill(pad)
  out.set(bytes)
  return out
}

/** ID3v2 header for a tag whose BODY is `size` bytes. Syncsafe encoded. */
const id3Header = (size: number, flags = 0): number[] => [
  ...ascii('ID3'), 4, 0, flags,
  (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
]

describe('extensionOf', () => {
  it('lowercases the extension', () => {
    expect(extensionOf('Track.FLAC')).toBe('flac')
  })
  it('takes the last dot only', () => {
    expect(extensionOf('01. Artist - Title.remix.mp3')).toBe('mp3')
  })
  it('null for no extension, dotfile, trailing dot', () => {
    expect(extensionOf('README')).toBeNull()
    expect(extensionOf('.flac')).toBeNull()
    expect(extensionOf('track.')).toBeNull()
  })
})

describe('checkHead — the incident: preallocated zero heads', () => {
  const zeros = new Uint8Array(HEAD_CHECK_BYTES)
  it.each(['flac', 'mp3', 'wav', 'aiff', 'm4a', 'ogg', 'opus'])(
    'rejects an all-zero head for .%s',
    (ext) => {
      expect(checkHead(ext, zeros)).toEqual({ ok: false, reason: 'zero_head' })
    },
  )
  it('allows an all-zero head for an unknown extension', () => {
    expect(checkHead('xyz', zeros)).toEqual({ ok: true })
    expect(checkHead(null, zeros)).toEqual({ ok: true })
  })
  it('allows a zero-length head (nothing to prove with)', () => {
    expect(checkHead('flac', new Uint8Array(0))).toEqual({ ok: true })
  })
})

describe('checkHead — flac', () => {
  it('passes a bare fLaC head', () => {
    expect(checkHead('flac', head(ascii('fLaC')))).toEqual({ ok: true })
  })
  it('passes fLaC behind an ID3v2 tag', () => {
    const h = head([...id3Header(64), ...new Array<number>(64).fill(0), ...ascii('fLaC')])
    expect(checkHead('flac', h)).toEqual({ ok: true })
  })
  it('accounts for the ID3v2 footer flag (0x10)', () => {
    const h = head([
      ...id3Header(32, 0x10),
      ...new Array<number>(32).fill(0), // tag body
      ...new Array<number>(10).fill(0), // footer
      ...ascii('fLaC'),
    ])
    expect(checkHead('flac', h)).toEqual({ ok: true })
  })
  it('passes two stacked ID3v2 tags before fLaC', () => {
    const h = head([
      ...id3Header(8), ...new Array<number>(8).fill(0),
      ...id3Header(4), ...new Array<number>(4).fill(0),
      ...ascii('fLaC'),
    ])
    expect(checkHead('flac', h)).toEqual({ ok: true })
  })
  it('allows when the ID3v2 tag is bigger than the read window (in doubt)', () => {
    // Declared body of 1 MB — fLaC would sit far past any head we read.
    const h = head(id3Header(1024 * 1024), 4096)
    expect(checkHead('flac', h)).toEqual({ ok: true })
  })
  it('allows a malformed syncsafe size (cannot tell)', () => {
    const h = head([...ascii('ID3'), 4, 0, 0, 0x80, 0, 0, 0])
    expect(checkHead('flac', h)).toEqual({ ok: true })
  })
  it('rejects wrong magic', () => {
    expect(checkHead('flac', head(ascii('RIFF')))).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
  it('rejects an ID3v2 tag followed by garbage where fLaC must be', () => {
    const h = head([...id3Header(16), ...new Array<number>(16).fill(0), ...ascii('JUNK')], 512, 0x00)
    expect(checkHead('flac', h)).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
})

describe('checkHead — mp3', () => {
  it('passes an ID3v2 head', () => {
    expect(checkHead('mp3', head(id3Header(100), 512, 0))).toEqual({ ok: true })
  })
  it('passes a bare frame sync at byte 0', () => {
    expect(checkHead('mp3', head([0xff, 0xfb, 0x90, 0x00], 512, 0))).toEqual({ ok: true })
  })
  it('passes a frame sync found mid-head (leading junk is legal mp3)', () => {
    const h = new Uint8Array(512).fill(0x20) // spaces
    h[300] = 0xff
    h[301] = 0xf3
    expect(checkHead('mp3', h)).toEqual({ ok: true })
  })
  it('rejects 0xFF not followed by sync bits', () => {
    const h = new Uint8Array(512).fill(0x20)
    h[10] = 0xff
    h[11] = 0x1f // top three bits not set
    expect(checkHead('mp3', h)).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
  it('rejects a head with neither ID3 nor any frame sync', () => {
    const h = new Uint8Array(512).fill(0x41) // 'AAAA…' — plain text
    expect(checkHead('mp3', h)).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
})

describe('checkHead — wav / aiff', () => {
  it('passes RIFF for wav and wave', () => {
    expect(checkHead('wav', head(ascii('RIFF')))).toEqual({ ok: true })
    expect(checkHead('wave', head(ascii('RIFF')))).toEqual({ ok: true })
  })
  it('passes RF64 (the >4 GB RIFF variant) for wav', () => {
    expect(checkHead('wav', head(ascii('RF64')))).toEqual({ ok: true })
  })
  it('rejects wrong magic for wav', () => {
    expect(checkHead('wav', head(ascii('fLaC')))).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
  it('passes FORM for aiff, aif, aifc', () => {
    for (const ext of ['aiff', 'aif', 'aifc']) {
      expect(checkHead(ext, head(ascii('FORM')))).toEqual({ ok: true })
    }
  })
  it('rejects wrong magic for aiff', () => {
    expect(checkHead('aiff', head(ascii('RIFF')))).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
})

describe('checkHead — m4a / mp4 / mov', () => {
  const ftypAt = (offset: number): Uint8Array => {
    const h = new Uint8Array(512).fill(0x01)
    h.set(ascii('ftyp'), offset)
    return h
  }
  it('passes ftyp at the standard offset 4', () => {
    for (const ext of ['m4a', 'mp4', 'mov']) {
      expect(checkHead(ext, ftypAt(4))).toEqual({ ok: true })
    }
  })
  it('passes ftyp anywhere within the first 64 bytes', () => {
    expect(checkHead('m4a', ftypAt(60))).toEqual({ ok: true })
  })
  it('rejects ftyp past the first 64 bytes', () => {
    expect(checkHead('m4a', ftypAt(120))).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
  it('rejects a head with no ftyp at all', () => {
    expect(checkHead('m4a', new Uint8Array(512).fill(0x01))).toEqual({ ok: false, reason: 'magic_mismatch' })
  })
})

describe('checkHead — ogg family and unknowns stay open', () => {
  it('ogg/oga/opus: any non-zero head passes (no magic rule on purpose)', () => {
    for (const ext of ['ogg', 'oga', 'opus']) {
      expect(checkHead(ext, head(ascii('OggS')))).toEqual({ ok: true })
      expect(checkHead(ext, new Uint8Array(512).fill(0x37))).toEqual({ ok: true })
    }
  })
  it('unknown extensions pass whatever the bytes', () => {
    expect(checkHead('txt', new Uint8Array(512).fill(0x41))).toEqual({ ok: true })
    expect(checkHead('shn', head(ascii('ajkg')))).toEqual({ ok: true })
    expect(checkHead(null, head(ascii('anything')))).toEqual({ ok: true })
  })
})

// TS 5.7 types a Uint8Array over ArrayBufferLike, which BlobPart refuses;
// the runtime accepts it fine. Confined to this helper.
const blobOf = (bytes: Uint8Array): Blob => new Blob([bytes as unknown as BlobPart])

describe('checkBlobHead', () => {
  it('reads the head off a Blob and rejects the incident file', async () => {
    // 1 MB of zeros with a .flac name — the torrent-preallocation shape.
    const blob = blobOf(new Uint8Array(1024 * 1024))
    expect(await checkBlobHead('still-downloading.flac', blob)).toEqual({
      ok: false, reason: 'zero_head',
    })
  })
  it('passes a real flac head', async () => {
    const blob = blobOf(head(ascii('fLaC'), 8192))
    expect(await checkBlobHead('track.flac', blob)).toEqual({ ok: true })
  })
  it('resolves ok when the read itself fails (fail open)', async () => {
    const broken = {
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('io')) }),
    } as unknown as Blob
    expect(await checkBlobHead('track.flac', broken)).toEqual({ ok: true })
  })
})
