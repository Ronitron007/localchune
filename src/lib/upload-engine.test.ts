// src/lib/upload-engine.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// EVICTION: TAKING ONE FILE OUT OF A BATCH THE OWNER DID NOT CURATE.
//
// The owner selected their whole Downloads folder — 551 files staged, 2,268
// skipped — and said "clearly some of them aren't DJ tracks". Until now the
// only controls were Upload-all and Cancel-all, so one wrong file meant
// re-picking 551. This file is the contract for the ✕ on a row.
//
// WHY THE ENGINE IS TESTED HERE AND NOT THE COMPONENT. The suite runs in
// node with no DOM (vitest.config: environment 'node'), so there is no
// @solidjs/testing-library render to drive. That is not a gap, because
// UX.12 already put every number and every rule OUTSIDE the component:
// upload-engine.ts owns the queue, upload-progress.ts owns the arithmetic,
// and UploadDropzone.tsx is a viewport over both. Testing the engine tests
// the feature; the component contributes a `<Show>` and an aria-label, which
// upload-remove-ui.test.ts reads off the source.
//
// THE MOCKS, AND THE ONE THING DELIBERATELY LEFT REAL. The network
// (uploader.ts), the Web Worker (preflight.ts) and the byte sniffer
// (head-check.ts) are replaced — none of them exists under node. The
// JOURNAL IS NOT. upload-journal.ts already degrades to an in-memory Map
// when `indexedDB` is undefined, which is exactly the node case, so the
// resume-journal assertions below run against the real rememberFile /
// lookupFile / forgetFile rather than against a fake that would agree with
// whatever the implementation did.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UploadOutcome } from './uploader'

const mocks = vi.hoisted(() => ({
  checkBlobHead: vi.fn(),
  readDurationMs: vi.fn(),
  preflightFile: vi.fn(),
  uploadFile: vi.fn(),
  createBatch: vi.fn(),
}))

vi.mock('./head-check', () => ({ checkBlobHead: mocks.checkBlobHead }))

vi.mock('./preflight', () => ({
  readDurationMs: mocks.readDurationMs,
  preflightFile: mocks.preflightFile,
  formatDuration: (ms: number | null) => (ms === null ? '--:--' : '03:00'),
}))

// Fully replaced rather than spread over the real module: the engine's
// `instanceof SessionExpiredError` / `instanceof UploadFailure` checks must
// see the same classes this file constructs, and nothing here needs the real
// multipart client.
vi.mock('./uploader', () => ({
  httpApi: { createBatch: mocks.createBatch },
  uploadFile: mocks.uploadFile,
  isAbortError: (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
  SessionExpiredError: class SessionExpiredError extends Error {},
  UploadFailure: class UploadFailure extends Error { rowDiscarded = false },
}))

type Engine = typeof import('./upload-engine')
type Store = typeof import('./upload-store')
type Journal = typeof import('./upload-journal')

let engine: Engine
let store: Store
let journal: Journal

const USER = 'member-1'

const makeFile = (name: string, size: number, lastModified = 1_700_000_000_000): File => {
  // A real File with real bytes, so blob.slice() in any surviving code path
  // behaves. Size is what the row displays and what the byte totals sum, so
  // it has to be the true length.
  const file = new File([new Uint8Array(size)], name, { type: 'audio/mpeg', lastModified })
  return file
}

/** Resolves once `predicate` holds, letting the microtask queue drain. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

const keyOf = (file: File): string => journal.journalKey(USER, file)
const statuses = (): string[] => store.uploadRows.map((r) => r.status)
const names = (): string[] => store.uploadRows.map((r) => r.name)

beforeEach(async () => {
  // The engine, the store and the journal are all MODULE SINGLETONS — that is
  // the whole of UX.12. A test that mutated one would leak into the next, so
  // the graph is rebuilt per test. All three are imported after the reset so
  // they are the same instance of each other, exactly as the browser sees
  // them; importing one before the reset is how you accidentally test two
  // stores.
  vi.resetModules()
  vi.clearAllMocks()

  mocks.checkBlobHead.mockResolvedValue({ ok: true })
  mocks.readDurationMs.mockResolvedValue({ durationMs: 180_000, source: 'header' })
  mocks.preflightFile.mockImplementation((f: { name: string; size: number }) => ({
    verdict: { ok: true, reason: null, name: f.name },
    clientDurationMs: 180_000,
    displayDurationMs: 180_000,
    estimated: false,
    message: 'ready',
  }))
  mocks.createBatch.mockResolvedValue({ batchId: 'batch-1' })
  mocks.uploadFile.mockResolvedValue('received' satisfies UploadOutcome)

  engine = await import('./upload-engine')
  store = await import('./upload-store')
  journal = await import('./upload-journal')
  engine.configureEngine(USER)
})

// --------------------------------------------------------------- staged

describe('eviction before Upload is pressed', () => {
  it('takes the named row out and leaves the others in order', async () => {
    const [a, b, c] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200), makeFile('c.mp3', 400)]
    await engine.enqueue([a, b, c])
    expect(statuses()).toEqual(['queued', 'queued', 'queued'])

    expect(await engine.removeRow(keyOf(b))).toBe('removed')

    expect(names()).toEqual(['a.mp3', 'c.mp3'])
  })

  it('recomputes "N files selected", the Upload button count and the byte total', async () => {
    const { aggregateUploads } = await import('./upload-progress')
    const [a, b, c] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200), makeFile('c.mp3', 400)]
    await engine.enqueue([a, b, c])

    // Every number the dropzone renders is derived from the store, so this is
    // the same arithmetic the page runs — selectedCount is rows.length,
    // queuedCount filters 'queued', the byte line is aggregateUploads.
    expect(store.uploadRows.length).toBe(3)
    expect(aggregateUploads(store.uploadRows).totalBytes).toBe(700)

    await engine.removeRow(keyOf(b))

    expect(store.uploadRows.length).toBe(2)
    const agg = aggregateUploads(store.uploadRows)
    expect(agg.total).toBe(2)
    expect(agg.totalBytes).toBe(500)
    expect(store.uploadRows.filter((r) => r.status === 'queued').length).toBe(2)
  })

  it('re-derives the resume prompt — "N of these were uploaded before"', async () => {
    const [a, b] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200)]
    // Both were started in an earlier session, so both would resume.
    for (const f of [a, b]) {
      await journal.rememberFile({
        key: keyOf(f), userId: USER, fileId: `file-${f.name}`, batchId: 'old',
        name: f.name, size: f.size, lastModified: f.lastModified,
      })
    }
    await engine.enqueue([a, b])
    const resumable = () => store.uploadRows.filter((r) => r.resumed && r.status === 'queued').length
    expect(resumable()).toBe(2)

    await engine.removeRow(keyOf(a))

    expect(resumable()).toBe(1)
  })

  it('evicts a skipped row too — 2,268 of them is the mess this is for', async () => {
    mocks.checkBlobHead.mockResolvedValue({ ok: false, reason: 'magic_mismatch' })
    const junk = makeFile('cover.mp3', 10)
    await engine.enqueue([junk])
    expect(statuses()).toEqual(['skipped'])

    expect(await engine.removeRow(keyOf(junk))).toBe('removed')
    expect(store.uploadRows.length).toBe(0)
  })

  it('refuses a key that is not in the queue rather than throwing', async () => {
    expect(await engine.removeRow('no-such-key')).toBe('refused')
  })

  it('lets the same file be re-added after it is evicted', async () => {
    // indexOf is what makes enqueue idempotent. An eviction that left the key
    // behind would silently ignore the re-drop, and the member would conclude
    // the picker was broken.
    const a = makeFile('a.mp3', 100)
    await engine.enqueue([a])
    await engine.removeRow(keyOf(a))
    await engine.enqueue([a])
    expect(names()).toEqual(['a.mp3'])
  })
})

// ------------------------------------------------- the index map is truth

describe('the row index map survives a removal from the middle', () => {
  it('still patches the right row after the one before it is gone', async () => {
    // THE BUG THIS EXISTS FOR. upload-engine keeps `indexOf: key -> position`
    // and every write goes through `patch(key, …)` -> `setRows(index, …)`.
    // Splice a row out of the middle and every position after it shifts by
    // one; leave the map alone and each later row's progress, status and
    // error message land on its NEIGHBOUR. Nothing would throw — the queue
    // would just quietly narrate the wrong file.
    const [a, b, c] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200), makeFile('c.mp3', 400)]
    await engine.enqueue([a, b, c])
    await engine.removeRow(keyOf(a))

    await engine.startBatch()

    expect(names()).toEqual(['b.mp3', 'c.mp3'])
    expect(statuses()).toEqual(['done', 'done'])
  })

  it('routes a failure message to the file that failed', async () => {
    const [a, b] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200)]
    await engine.enqueue([a, b])
    const c = makeFile('c.mp3', 400)
    await engine.enqueue([c])
    await engine.removeRow(keyOf(a))

    mocks.uploadFile.mockImplementation(async (_batch: string, item: { fileId: string; file: File }) => {
      if (item.file.name === 'c.mp3') throw new Error('R2 said no')
      return 'received'
    })
    await engine.startBatch()

    expect(store.uploadRows.map((r) => [r.name, r.status, r.message])).toEqual([
      ['b.mp3', 'done', 'uploaded'],
      ['c.mp3', 'failed', 'R2 said no'],
    ])
  })
})

// ------------------------------------------------------------- mid-batch

describe('eviction while the batch is running', () => {
  /**
   * FILE_CONCURRENCY is 3, so with five files the pump holds three in flight
   * and two waiting. `release` lets the three finish on command, which is how
   * a test gets to stand in the middle of a running batch.
   */
  const gatedBatch = async () => {
    const files = [1, 2, 3, 4, 5].map((n) => makeFile(`t${n}.mp3`, n * 1000))
    await engine.enqueue(files)
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const seen: string[] = []
    mocks.uploadFile.mockImplementation(async (_b: string, item: { file: File }) => {
      seen.push(item.file.name)
      await gate
      return 'received'
    })
    const running = engine.startBatch()
    await until(() => seen.length === 3, 'three files in flight')
    return { files, release, seen, running }
  }

  it('removes a row that has not started, and never uploads it', async () => {
    const { files, release, seen, running } = await gatedBatch()
    const pending = store.uploadRows.filter((r) => r.status === 'queued')
    expect(pending).toHaveLength(2)

    expect(await engine.removeRow(pending[0].key)).toBe('removed')
    expect(store.uploadRows).toHaveLength(4)

    release()
    await running

    expect(seen).not.toContain(files.find((f) => keyOf(f) === pending[0].key)!.name)
    expect(seen).toHaveLength(4)
    expect(statuses()).toEqual(['done', 'done', 'done', 'done'])
  })

  it('shrinks the "X of Y done" denominator and the byte total', async () => {
    const { aggregateUploads } = await import('./upload-progress')
    const { release, running } = await gatedBatch()
    expect(aggregateUploads(store.uploadRows).total).toBe(5)
    expect(aggregateUploads(store.uploadRows).totalBytes).toBe(15_000)

    const pending = store.uploadRows.filter((r) => r.status === 'queued')
    await engine.removeRow(pending[0].key)
    await engine.removeRow(pending[1].key)

    const mid = aggregateUploads(store.uploadRows)
    expect(mid.total).toBe(3)
    expect(mid.totalBytes).toBe(6_000)

    release()
    await running
    const end = aggregateUploads(store.uploadRows)
    expect(end.finished).toBe(3)
    expect(end.total).toBe(3)
    expect(end.percent).toBe(100)
  })

  it('leaves pump concurrency alone — the three in flight still finish', async () => {
    const { release, seen, running } = await gatedBatch()
    const pending = store.uploadRows.filter((r) => r.status === 'queued')
    await engine.removeRow(pending[0].key)
    await engine.removeRow(pending[1].key)

    expect(seen).toHaveLength(3)
    release()
    await running

    // No fourth slot opened for an evicted file, and no in-flight transfer
    // was disturbed by the queue shrinking under it.
    expect(seen).toHaveLength(3)
    expect(store.uploadRows.every((r) => r.status === 'done')).toBe(true)
    expect(store.uploadRunning()).toBe(false)
  })

  it('REFUSES the file whose bytes are moving — no torn multipart', async () => {
    const { release, running } = await gatedBatch()
    const inFlight = store.uploadRows.filter((r) => r.status === 'uploading')
    expect(inFlight).toHaveLength(3)

    for (const row of inFlight) {
      expect(await engine.removeRow(row.key)).toBe('refused')
    }

    expect(store.uploadRows).toHaveLength(5)
    expect(store.uploadRows.filter((r) => r.status === 'uploading')).toHaveLength(3)
    release()
    await running
  })

  it('a row is uploading BEFORE the pump can yield, so there is no window to evict it in', async () => {
    // The invariant behind "never the in-flight file". runOne() sets the row
    // to 'uploading' in its synchronous prefix — before its first await — so
    // between "the pump chose this file" and "this file is un-removable"
    // there is no suspension point for a click to land in. The guard is not a
    // race that usually goes our way; there is no race.
    const files = [makeFile('t1.mp3', 100)]
    await engine.enqueue(files)
    let observed = ''
    mocks.uploadFile.mockImplementation(async () => {
      observed = store.uploadRows[0].status
      return 'received'
    })
    await engine.startBatch()
    expect(observed).toBe('uploading')
  })
})

// --------------------------------------------------------- settled rows

describe('a settled row keeps its status', () => {
  it.each([
    ['done', async () => { mocks.uploadFile.mockResolvedValue('received') }],
    ['already', async () => { mocks.uploadFile.mockResolvedValue('already') }],
    ['failed', async () => { mocks.uploadFile.mockRejectedValue(new Error('nope')) }],
  ])('refuses a %s row', async (expected, arrange) => {
    await arrange()
    const a = makeFile('a.mp3', 100)
    await engine.enqueue([a])
    await engine.startBatch()
    expect(statuses()).toEqual([expected])

    expect(await engine.removeRow(keyOf(a))).toBe('refused')
    expect(store.uploadRows).toHaveLength(1)
    expect(statuses()).toEqual([expected])
  })

  it('refuses a cancelled row — it has server state, like a failed one', async () => {
    // A cancelled row is not "never started": rememberFile has run, a
    // multipart upload exists in R2 and a `files` row exists in Postgres.
    // Retry RESUMES it. Removing it would strand the partial for the 24 h
    // sweeper with nothing on screen saying so, and the retry that would have
    // finished it for free is what the row is still there to offer.
    const a = makeFile('a.mp3', 100)
    await engine.enqueue([a])
    mocks.uploadFile.mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    await engine.startBatch()
    expect(statuses()).toEqual(['cancelled'])

    expect(await engine.removeRow(keyOf(a))).toBe('refused')
    expect(statuses()).toEqual(['cancelled'])
  })

  it('names exactly the three removable statuses', () => {
    // Stated positively so a new RowStatus has to make a decision here rather
    // than default into being evictable.
    expect(engine.removable('checking')).toBe(true)
    expect(engine.removable('queued')).toBe(true)
    expect(engine.removable('skipped')).toBe(true)
    for (const s of ['uploading', 'done', 'already', 'failed', 'cancelled'] as const) {
      expect(engine.removable(s), s).toBe(false)
    }
  })
})

// ----------------------------------------------------------- the journal

describe('the resume journal after an eviction', () => {
  it('forgets the evicted file, so a later session does not offer to resume it', async () => {
    const a = makeFile('a.mp3', 100)
    await journal.rememberFile({
      key: keyOf(a), userId: USER, fileId: 'file-a', batchId: 'old',
      name: a.name, size: a.size, lastModified: a.lastModified,
    })
    await engine.enqueue([a])
    expect(store.uploadRows[0].resumed).toBe(true)

    await engine.removeRow(keyOf(a))

    expect(await journal.lookupFile(keyOf(a))).toBeNull()
  })

  it('a re-added evicted file comes back FRESH, not resuming', async () => {
    // The end-to-end statement of the rule: eviction is not a pause.
    const a = makeFile('a.mp3', 100)
    await journal.rememberFile({
      key: keyOf(a), userId: USER, fileId: 'file-a', batchId: 'old',
      name: a.name, size: a.size, lastModified: a.lastModified,
    })
    await engine.enqueue([a])
    await engine.removeRow(keyOf(a))
    await engine.enqueue([a])

    expect(store.uploadRows[0].resumed).toBe(false)
    expect(store.uploadRows[0].fileId).not.toBe('file-a')
    expect(store.uploadRows[0].message).toBe('ready')
  })

  it('tolerates a file that was never in the journal', async () => {
    // The common case by a wide margin: 551 files staged, none of them ever
    // started. forgetFile on an absent key must be a no-op, not a throw, or
    // the ✕ fails on the very first click of the feature.
    const a = makeFile('a.mp3', 100)
    await engine.enqueue([a])
    expect(await journal.lookupFile(keyOf(a))).toBeNull()

    expect(await engine.removeRow(keyOf(a))).toBe('removed')
    expect(store.uploadRows).toHaveLength(0)
  })

  it('leaves OTHER files journal entries alone', async () => {
    const [a, b] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200)]
    for (const f of [a, b]) {
      await journal.rememberFile({
        key: keyOf(f), userId: USER, fileId: `file-${f.name}`, batchId: 'old',
        name: f.name, size: f.size, lastModified: f.lastModified,
      })
    }
    await engine.enqueue([a, b])

    await engine.removeRow(keyOf(a))

    expect(await journal.lookupFile(keyOf(a))).toBeNull()
    expect((await journal.lookupFile(keyOf(b)))?.fileId).toBe('file-b.mp3')
  })

  it('startFresh still works over an evicted queue', async () => {
    // startFresh walks `rows` and forgets each resumable one. It must not
    // trip over a queue that shrank under it.
    const [a, b] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200)]
    for (const f of [a, b]) {
      await journal.rememberFile({
        key: keyOf(f), userId: USER, fileId: `file-${f.name}`, batchId: 'old',
        name: f.name, size: f.size, lastModified: f.lastModified,
      })
    }
    await engine.enqueue([a, b])
    await engine.removeRow(keyOf(a))

    await engine.startFresh()

    expect(store.uploadRows).toHaveLength(1)
    expect(store.uploadRows[0].resumed).toBe(false)
    expect(store.uploadRows[0].message).toBe('ready (fresh upload)')
  })
})

// ------------------------------------------------------- checking phase

describe('eviction during the pre-flight', () => {
  it('removes a row that is still reading its header', async () => {
    // 551 files pre-flight four at a time, so most of the queue sits in
    // 'checking' for the first few seconds — the exact window in which a
    // member skimming the list spots the first thing that is not a track.
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    mocks.readDurationMs.mockImplementation(async () => {
      await gate
      return { durationMs: 180_000, source: 'header' }
    })
    const [a, b] = [makeFile('a.mp3', 100), makeFile('b.mp3', 200)]
    const enqueued = engine.enqueue([a, b])
    await until(() => store.uploadRows.length === 2, 'both rows staged')
    expect(statuses()).toEqual(['checking', 'checking'])

    expect(await engine.removeRow(keyOf(a))).toBe('removed')

    release()
    await enqueued
    // The in-flight pre-flight for the evicted row resolves AFTER it is gone
    // and must not resurrect it, nor write its verdict onto its neighbour.
    expect(names()).toEqual(['b.mp3'])
    expect(statuses()).toEqual(['queued'])
  })
})
