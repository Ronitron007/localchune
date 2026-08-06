// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// PERF TASK 2.5 — the pre-flight worker's shape, pinned.
//
// THE MEASUREMENT THAT MADE THIS FILE. Vite's `worker.format` defaults to
// `'iife'`, and an IIFE cannot code split: every dynamic import inside the
// worker graph gets inlined. music-metadata's `parseBlob` picks its parser
// by container at runtime, so an IIFE worker shipped ALL sixteen — MP4,
// Mpeg, Ogg, Flac, Matroska, ASF, APE, Musepack, WavPack, DSD, AIFF, WAVE
// and the ID3 readers — 219,425 B raw / 64,284 B gzip, to read one duration
// out of one header.
//
//   worker entry   219,425 / 64,284 gz  ->  96,265 / 28,621 gz
//   an MP3 session          64,284 gz   ->  ~43,100 gz (entry + 4 parsers)
//   a FLAC session          64,284 gz   ->  ~37,000 gz (entry + 2 parsers)
//
// That default is invisible: nothing in the source says `iife`, no test
// fails when it comes back, and the cost only shows up in a chunk table
// nobody runs. Hence a guard on the config line itself.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT: that music-metadata appears
// in exactly one graph. Vite builds a worker as a SEPARATE rollup pass, so
// the worker's parser chunks cannot be shared with the main thread's — the
// manifest holds two sets either way. The plan's other branch, deleting the
// main-thread fallback, would collapse them, and it would save a real
// session exactly zero bytes: nobody downloads the fallback unless
// `new Worker` throws. What it would cost is the duration read on a browser
// with no module-worker support, and with it the 15-minute gate, since only
// a header duration may reject a file. Manifest weight is free; that is
// not. The fallback stays, and this file pins that it stays.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8')

describe('the pre-flight worker code splits', () => {
  it('astro.config.ts asks for an ES-module worker', () => {
    expect(read('../../astro.config.ts')).toMatch(/worker:\s*\{\s*format:\s*'es'\s*\}/)
  })

  it('the call site still constructs a module worker from a static URL', () => {
    // This exact syntax is what Vite detects to emit the worker bundle at
    // all; any indirection and the worker is silently not bundled, which
    // fails only in the production build.
    expect(read('./preflight.ts'))
      .toMatch(/new Worker\(new URL\('\.\/preflight\.worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/)
  })
})

describe('the main-thread fallback survives', () => {
  const preflight = read('./preflight.ts')

  it('still parses inline when Worker construction fails', () => {
    expect(preflight).toMatch(/await import\('\.\/preflight\.worker'\)\)\.parseAudioHeader/)
  })

  it('still treats every failure as an unknown duration, never a rejection', () => {
    expect(preflight).toMatch(/source: 'unknown'/)
  })
})

describe('the worker is warmed before the first file', () => {
  it('preflight.ts exports the warm hook', () => {
    expect(read('./preflight.ts')).toMatch(/export function warmPreflightWorker\(\): void/)
  })

  it('the dropzone calls it on hover, on focus and on drag', () => {
    const dropzone = read('../components/UploadDropzone.tsx')
    expect(dropzone).toMatch(/onPointerEnter=\{warmPreflightWorker\}/)
    expect(dropzone).toMatch(/onFocusIn=\{warmPreflightWorker\}/)
    expect(dropzone).toMatch(/onDragOver=\{[^}]*warmPreflightWorker\(\)/)
  })

  it('imports one function, not the parser graph — survive-list #4', () => {
    const dropzone = read('../components/UploadDropzone.tsx')
    expect(dropzone).toMatch(/import \{ warmPreflightWorker \} from '\.\.\/lib\/preflight'/)
    expect(dropzone).not.toMatch(/from 'music-metadata'/)
  })
})
