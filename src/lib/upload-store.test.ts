// src/lib/upload-store.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE OTHER HALF OF SURVIVE-LIST #4, WHICH NOTHING WAS CHECKING.
//
// The list names the UX.12 bundle split as a contract and names three guard
// tests for it: shell-bundle.test.ts, queue-store's own guard, and
// queue-wiring.test.ts. Read them and the asymmetry is plain — all three
// protect the QUEUE drawer's half. `upload-store.ts` is the file the split
// was invented for and it had no guard of its own: shell-bundle.test.ts
// asserts UploadChip is the only island in Shell, but nothing asserted that
// the module that island imports stays cheap.
//
// It matters more than the queue's half, not less. Shell.astro mounts
// UploadChip on EVERY page, so one `import { removeRow } from
// './upload-engine'` added here to save a keystroke would ship a multipart
// S3 client, an IndexedDB journal, a byte sniffer and a music-metadata
// header parser to /login — the page the audit already had to strip 222 KB
// off. There would be no build error and no failing test, and the only
// symptom would be a number in a bundle report nobody reads until the next
// audit.
//
// Written while adding row eviction, which is exactly the kind of change
// that invites the import: the ✕ lives in the component, the rule lives in
// the engine, and the store sits between them looking like a convenient
// place to put either.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { uploadRows, uploadRunning, uploadLabel, uploadNotice } from './upload-store'

const source = readFileSync(new URL('./upload-store.ts', import.meta.url), 'utf8')
const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])

describe('THE STORE MUST NOT DRAG THE ENGINE INTO EVERY PAGE', () => {
  it('imports Solid and one type module, and nothing else', () => {
    expect(imports).toEqual(['solid-js', 'solid-js/store', './upload-progress'])
  })

  it('the one project import it has is type-only, so it costs zero bytes', () => {
    // ProgressRow and RowStatus are erased at build. upload-progress.ts is in
    // the every-page bundle anyway (the chip runs its arithmetic), but the
    // store must not be the reason.
    expect(source).toMatch(/import type \{[^}]*\} from '\.\/upload-progress'/)
  })

  it.each([
    './upload-engine', './uploader', './upload-journal', './preflight',
    './head-check', './upload-policy', './upload-queue', './upload-batch',
  ])('does not import %s', (mod) => {
    expect(imports).not.toContain(mod)
  })

  it('touches no browser API — it is state, not behaviour', () => {
    // Comments stripped first: the header DISCUSSES the journal and the S3
    // client at length, which is the point. What must not exist is a call.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const api of ['indexedDB', 'XMLHttpRequest', 'fetch(', 'document', 'localStorage']) {
      expect(code, api).not.toContain(api)
    }
  })
})

describe('the queue is one store, read-only from the outside', () => {
  it('exports the four readers both viewports share', () => {
    // /upload's queue and the chip on every other page read THESE. A second
    // createStore anywhere would be a second, silent queue — the trap
    // upload-batch.ts already documents.
    expect(Array.isArray(uploadRows)).toBe(true)
    expect(typeof uploadRunning).toBe('function')
    expect(typeof uploadLabel).toBe('function')
    expect(typeof uploadNotice).toBe('function')
  })

  it('creates exactly one store and one running signal', () => {
    // `createStore<Row[]>([])` — the call site carries a type argument, so
    // the bracket class matches the call and not the prose above it, which
    // names `createStore` on purpose.
    expect([...source.matchAll(/createStore[<(]/g)]).toHaveLength(1)
    expect([...source.matchAll(/createSignal\(/g)]).toHaveLength(3)
  })
})
