// src/lib/upload-engine.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { produce } from 'solid-js/store'
import { planUpload } from './upload-policy'
import { readDurationMs, preflightFile, formatDuration } from './preflight'
import { checkBlobHead } from './head-check'
import { journalKey, lookupFile, rememberFile, forgetFile, pruneJournal } from './upload-journal'
import type { RowStatus } from './upload-progress'
import {
  httpApi, uploadFile, isAbortError, SessionExpiredError, UploadFailure,
  type UploadItem,
} from './uploader'
import { pump, FILE_CONCURRENCY, PREFLIGHT_CONCURRENCY } from './upload-queue'
import { currentBatchId, setCurrentBatchId } from './upload-batch'
import {
  setUploadNotice as setNotice, setUploadRows as setRows,
  setUploadRunning as setRunning, uploadLabel as label,
  uploadRows as rows, uploadRunning as running, type Row,
} from './upload-store'

/**
 * UX.12 — THE UPLOAD ENGINE, AND WHY IT LIVES IN A MODULE.
 *
 * Everything below used to be closure state inside UploadDropzone.tsx. That
 * made the engine a property of one island on one page, and Astro's
 * ClientRouter destroys an island the moment you navigate away from the page
 * that rendered it: the `astro-island` element is disconnected by the body
 * swap, `astro:unmount` fires on the next `astro:after-swap`, and
 * @astrojs/solid-js's client renderer calls the component's `dispose()`
 * (node_modules/@astrojs/solid-js/dist/client.js, last line). A 200-file
 * batch died on any click that left /upload.
 *
 * The fix is ownership, not interception. A module is evaluated ONCE per
 * document — ES modules are cached by URL, and a ClientRouter soft
 * navigation swaps the body without re-evaluating a module the browser has
 * already run (see Astro's own `detectScriptExecuted` in
 * dist/transitions/swap-functions.js). So the File handles, the
 * AbortController and the in-flight XHRs live here, and the queue itself
 * lives in upload-store.ts — both above the island lifecycle entirely, where
 * a soft navigation cannot reach them.
 *
 * THE STATE IS NEXT DOOR, ON PURPOSE. upload-store.ts holds the rows and the
 * signals and imports nothing but Solid, because UploadChip (mounted in
 * Shell, so present on every page) has to read the queue without dragging
 * this file's whole graph — a multipart S3 client, an IndexedDB journal and
 * a header parser — into every page in the app. That file's header explains
 * the split; this one is the actions over it.
 *
 * THE LOAD-BEARING MECHANISM IS THE MODULE, NOT `transition:persist`.
 * Shell.astro does mount UploadChip with `transition:persist` — that keeps
 * the CHIP's own DOM node and Solid render alive across a swap instead of
 * remounting and flickering, the same idiom the persisted `#player-audio`
 * element already uses. But the batch would survive even if the chip were
 * dropped (navigating to a page with no Shell, say), because nothing about
 * the batch is stored in a component. That distinction matters: it is also
 * why the popstate gap below closes for free.
 *
 * WHAT IS DELIBERATELY NOT HERE. The journal's resume semantics are
 * untouched by this move: `rememberFile` still writes before the first byte
 * moves, `lookupFile` still decides `resumed`, and `startFresh` still mints
 * a new file_id and leaves the old partial to the 24 h sweeper. Moving the
 * owner of the queue does not change what the queue does.
 */

// Deliberately NOT in the store. createStore deep-proxies plain objects, and
// a proxied File is no longer something xhr.send() will accept.
const handles = new Map<string, File>()
// Only a header-sourced duration ever goes here — the value sent to
// ingest_begin as client_duration_ms. An estimate is displayed (row.duration)
// but never stored in this map and never leaves the browser.
const clientDurations = new Map<string, number | null>()
const indexOf = new Map<string, number>()

let aborter: AbortController | null = null
let userId = ''
let started = false

/**
 * The batch id is NOT a second piece of state here. `currentBatchId` in
 * upload-batch.ts is already the module-scope signal FileStateTicker polls
 * from, so the engine reads and writes that one rather than keeping a
 * private copy in step with it. One value, one owner, no drift.
 */
export const batchStarted = (): boolean => currentBatchId() !== null

/**
 * Called by UploadDropzone on mount. It is the only island that knows the
 * member's id (Shell does not read `Astro.locals.member`), and the journal
 * key is per-member on purpose — see upload-journal.ts's `journalKey`.
 *
 * Idempotent: /upload can be entered many times per document, and the
 * journal must be pruned once, not once per visit.
 */
export function configureEngine(id: string): void {
  userId = id
  if (started) return
  started = true
  void pruneJournal()
  installUnloadGuard()
}

/**
 * THE ONE GUARD THAT SURVIVES, AND THE ONE THAT DID NOT.
 *
 * `beforeunload` stays, and it stays here rather than in a component so it
 * cannot be torn down by an island being disposed. It covers the cases that
 * are still fatal, because they end this document and take the module — and
 * therefore the File handles and the open XHRs — with it: tab close, hard
 * reload, a typed URL, an external link, a `data-astro-reload` link, and the
 * Sign out form's POST (AppNav.astro).
 *
 * The capture-phase document CLICK guard that used to sit beside it is GONE,
 * and nav-guard.ts with it. It existed for exactly one reason: a
 * ClientRouter soft navigation is not an unload, so `beforeunload` never
 * fired for it, and the batch died silently. That is no longer true — a soft
 * navigation now costs the batch nothing — so the guard's only remaining
 * effect would be to interrupt a safe click with a false alarm. Two of those
 * false alarms were already reachable:
 *   - Clicking a play link (`a.play`) mid-batch. It never navigates at all —
 *     site.ts preventDefaults it and plays into the persisted <audio>. The
 *     guard could not tell, because it ran before site.ts's own handler.
 *     (PR #24 moves site.ts's delegations to the capture phase to win an
 *     unrelated race with ClientRouter; that would have re-ordered the two
 *     but not made the dialog any less wrong. Deleting the guard removes the
 *     interaction rather than tuning it.)
 *   - Clicking "Upload" in the nav to get BACK to the queue, which is now the
 *     single most likely click a member makes mid-batch.
 *
 * THE POPSTATE GAP IS CLOSED, and not by guarding it. The long investigation
 * this file inherited (browser back/forward drives a soft transition that no
 * listener can cancel: popstate's target is `window`, so no capture-phase
 * ordering trick is available; the history pointer has already moved by the
 * time it fires; `preventDefault()` on astro:before-preparation only forces a
 * hard reload of the page you already landed on; and restoring history
 * yourself makes Astro re-swap THIS page, remounting every island and
 * destroying the very File handles the guard existed to protect) concluded
 * that back/forward could not be guarded without causing the data loss it
 * was guarding against. All of that stays true. None of it matters any more:
 * a popstate soft transition does not re-evaluate this module either, so
 * back/forward is now exactly as safe as a link click, and the case that
 * could not be guarded no longer needs guarding. The one popstate case that
 * IS a real unload — `transitionEnabledOnThisPage()` false making onPopState
 * call `location.reload()`, unreachable here because Shell.astro always
 * renders <ClientRouter /> — was always covered by `beforeunload`, and still is.
 */
let unloadGuardInstalled = false
function installUnloadGuard(): void {
  if (unloadGuardInstalled || typeof window === 'undefined') return
  unloadGuardInstalled = true
  window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
    if (running()) event.preventDefault()
  })
}

const patch = (key: string, next: Partial<Row>) => {
  const index = indexOf.get(key)
  if (index !== undefined) setRows(index, next)
}

/**
 * REMOVING ONE FILE FROM A BATCH NOBODY CURATED.
 *
 * The owner selected their entire Downloads folder: 551 files staged, 2,268
 * skipped, and — their words — "clearly some of them aren't DJ tracks". The
 * queue's only controls were Upload-everything and Cancel-everything, so one
 * wrong file cost a re-pick of all 551. This is the third verb.
 *
 * THE RULE, AS A SET RATHER THAN AS A CONDITION. A file may be evicted while
 * it is still only a NAME IN A LIST — nothing has been sent, nothing exists
 * server-side, and the only trace it can have left is a journal entry from an
 * earlier session, which removeRow deletes.
 *
 *   checking  the pre-flight is still reading its header. 551 files go four
 *             at a time, so this is where most of the queue sits for the
 *             first seconds — exactly when a member skimming the list spots
 *             the first thing that is not a track.
 *   queued    accepted, waiting for a transfer slot.
 *   skipped   pre-flight or the byte sniffer already rejected it. It has no
 *             bytes to lose and never will; 2,268 of these is the clutter
 *             the ✕ exists to clear.
 *
 * Everything else is refused, and each for its own reason rather than as one
 * blanket "it started":
 *
 *   uploading   bytes are moving. Dropping the row would abandon a multipart
 *               upload mid-part with no abort — Cancel is the control that
 *               ends a transfer, and it ends it properly.
 *   done/already the file is IN. The row is now a receipt.
 *   failed      the row is a task: it carries the reason and a Retry that
 *               fixes it. Removing it hides the problem rather than solving
 *               it.
 *   cancelled   not "never started". rememberFile has run, a multipart
 *               upload exists in R2 and a `files` row exists in Postgres, and
 *               Retry RESUMES from where it stopped. Evicting it would strand
 *               that partial for the 24 h sweeper and throw away the finish
 *               that was still free.
 */
const REMOVABLE: ReadonlySet<RowStatus> = new Set<RowStatus>(['checking', 'queued', 'skipped'])

/** Whether a row in this state may be evicted. Exported so the ✕ renders in
 *  exactly the states removeRow will honour — one rule, not two. */
export const removable = (status: RowStatus): boolean => REMOVABLE.has(status)

export type Eviction = 'removed' | 'refused'

/**
 * `indexOf` maps key -> position, and EVERY write in this module goes through
 * `patch(key, …)` -> `setRows(index, …)`. Splice a row out of the middle and
 * every position after it shifts by one; leave the map alone and each later
 * row's progress, status and error message land on its NEIGHBOUR. Nothing
 * throws — the queue just quietly narrates the wrong file.
 *
 * Rebuilt wholesale rather than decremented from the removal point, because
 * the store is the truth and a map derived from it in one pass cannot drift
 * from it. 551 rows is 551 Map.set calls; a member clicking ✕ cannot outrun
 * that.
 */
function reindex(): void {
  indexOf.clear()
  for (let i = 0; i < rows.length; i += 1) indexOf.set(rows[i].key, i)
}

/**
 * Take one file out of the queue. The ENGINE does this, not the component:
 * the chip on every other page reads the same store, and a UI that spliced
 * its own copy of the list would be the second source of truth UX.12 exists
 * to prevent.
 *
 * THE SYNCHRONOUS PREFIX IS THE WHOLE CONCURRENCY ARGUMENT. Everything that
 * decides the outcome — the status test, the two map deletes, the splice and
 * the reindex — runs before the first `await`. Read against runOne(), which
 * sets its row to 'uploading' in ITS synchronous prefix, before ITS first
 * await: between the pump choosing a file and that file becoming
 * un-removable there is no suspension point for a click to land in. Either
 * this function wins (the row and its File handle are gone, so runOne's
 * opening guard returns) or runOne does (the status is 'uploading', so this
 * refuses). "Never the in-flight file" is not a race that usually goes our
 * way; there is no race.
 *
 * THE JOURNAL IS CLEANED, NOT TOMBSTONED. `forgetFile` deletes the
 * name|size|mtime -> file_id mapping, so a later visit that meets this file
 * again treats it as new instead of offering to resume it — eviction is not
 * a pause. That mints a new file_id if the file ever comes back, leaving any
 * earlier partial to the 24 h sweeper, which is the same honest price
 * `startFresh` already documents and states in its own notice. A tombstone
 * was the alternative and would be worse: it is a row that has to be pruned,
 * has to be skipped by `lookupFile`, and would make "I removed it by mistake,
 * let me drag it back in" resume a partial the member believes they deleted.
 */
export async function removeRow(key: string): Promise<Eviction> {
  const index = indexOf.get(key)
  if (index === undefined) return 'refused'
  if (!removable(rows[index].status)) return 'refused'

  handles.delete(key)
  clientDurations.delete(key)
  setRows(produce((list) => { list.splice(index, 1) }))
  reindex()

  // After the store is already correct: the ✕ must feel instant, and the
  // journal delete is a round trip to IndexedDB. It cannot fail in a way that
  // matters — withStore resolves null when IndexedDB is absent or blocked,
  // and an absent key (the common case by a wide margin: 551 files staged,
  // none of them ever started) is a no-op.
  await forgetFile(key)
  return 'removed'
}

export async function enqueue(picked: File[]): Promise<void> {
  const added: { key: string; file: File }[] = []
  for (const file of picked) {
    const key = journalKey(userId, file)
    if (indexOf.has(key)) continue
    handles.set(key, file)
    setRows(rows.length, {
      key, fileId: '', name: file.name, size: file.size,
      status: 'checking', loaded: 0, message: 'reading header…', duration: '--:--',
      resumed: false, discarded: false,
    })
    indexOf.set(key, rows.length - 1)
    added.push({ key, file })
  }

  await pump(
    added.map(({ key, file }) => async () => {
      // UX.11's content-integrity gate, BEFORE the duration parse: a few
      // KB read that rejects a known extension whose bytes contradict it
      // (all-zero torrent-preallocated head, missing magic). The duration
      // preflight below deliberately fails OPEN on a parse failure, which
      // is how 29 hollow FLACs once uploaded in full only to die in
      // analysis — this is the one check allowed to fail CLOSED, and only
      // on proof. head-check.ts holds the rules and the incident story.
      const integrity = await checkBlobHead(file.name, file)
      if (!integrity.ok) {
        handles.delete(key)
        patch(key, { status: 'skipped', message: 'skipped — file looks incomplete or corrupt' })
        return
      }
      // Task 6 reads the duration off the header in a Web Worker. It never
      // decodes: decodeAudioData needs ~212 MB of RAM for a 10-minute stereo
      // track to obtain a number that lives in the first 100 bytes. It never
      // rejects — every failure resolves to { durationMs: null, source: 'unknown' }.
      const read = await readDurationMs(file)
      const p = preflightFile({ name: file.name, size: file.size }, read)
      if (!p.verdict.ok) {
        handles.delete(key)
        patch(key, { status: 'skipped', message: p.message })
        return
      }
      // The row can be evicted WHILE this task is suspended — 'checking' is
      // removable, and with PREFLIGHT_CONCURRENCY at 4 a 551-file queue sits
      // here for seconds. `patch` is already a no-op for a key with no index,
      // but the two lines below are not: one would resurrect an entry in
      // clientDurations for a file that no longer exists, and the other is an
      // IndexedDB round trip for an answer nobody will read.
      if (!indexOf.has(key)) return
      // Only a header duration is trustworthy enough to send to the server
      // (Task 2's client_duration_ms column). An estimate is display-only.
      clientDurations.set(key, p.clientDurationMs)
      const remembered = await lookupFile(key)
      patch(key, {
        status: 'queued',
        fileId: remembered?.fileId ?? crypto.randomUUID(),
        resumed: remembered !== null,
        duration: formatDuration(p.displayDurationMs) + (p.estimated ? '~' : ''),
        message: remembered !== null ? 'started before — will resume' : p.message,
      })
    }),
    { concurrency: PREFLIGHT_CONCURRENCY },
  )
}

export async function startFresh(): Promise<void> {
  for (const row of rows) {
    if (!row.resumed || row.status !== 'queued') continue
    await forgetFile(row.key)
    patch(row.key, {
      fileId: crypto.randomUUID(), resumed: false, message: 'ready (fresh upload)',
    })
  }
  // A fresh file_id means a second row and a second object for the same
  // bytes. The old one is left to the 24 h sweeper — that is the honest
  // price of "start over".
  setNotice('Starting fresh. The earlier partial uploads are cleaned up automatically within 24 hours.')
}

async function runOne(key: string, signal: AbortSignal): Promise<void> {
  const file = handles.get(key)
  const index = indexOf.get(key)
  const batchId = currentBatchId()
  if (file === undefined || index === undefined || batchId === null) return
  const row = rows[index]

  patch(key, {
    status: 'uploading',
    loaded: 0,
    message: row.resumed ? 'resuming…' : 'starting…',
  })

  // BEFORE the first byte moves. A journal entry written on success is
  // useless — the case it exists for is the tab closing at 40%.
  await rememberFile({
    key, userId, fileId: row.fileId, batchId,
    name: file.name, size: file.size, lastModified: file.lastModified,
  })

  const item: UploadItem = {
    key,
    fileId: row.fileId,
    file,
    clientDurationMs: clientDurations.get(key) ?? null,
    plan: planUpload(file.size),
  }

  try {
    const outcome = await uploadFile(batchId, item, httpApi, signal, {
      onProgress: (loaded) => patch(key, { loaded }),
      onStatus: (message) => patch(key, { message }),
    })
    patch(key, {
      status: outcome === 'already' ? 'already' : 'done',
      loaded: file.size,
      message: outcome === 'already' ? 'already uploaded' : 'uploaded',
    })
  } catch (err) {
    if (isAbortError(err)) {
      patch(key, { status: 'cancelled', message: 'cancelled — Retry resumes it' })
      return
    }
    if (err instanceof SessionExpiredError) {
      aborter?.abort(new DOMException('signed out', 'AbortError'))
      setNotice(err.message)
      patch(key, { status: 'failed', message: err.message })
      return
    }
    patch(key, {
      status: 'failed',
      discarded: err instanceof UploadFailure && err.rowDiscarded,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runKeys(keys: string[]): Promise<void> {
  if (keys.length === 0 || running()) return
  setRunning(true)
  setNotice('')
  const controller = new AbortController()
  aborter = controller
  try {
    if (currentBatchId() === null) {
      // Publishing it IS storing it — FileStateTicker (a sibling island that
      // cannot read this module's private state) polls the same signal.
      setCurrentBatchId((await httpApi.createBatch(label().trim() || null)).batchId)
    }
    await pump(
      keys.map((key) => (signal: AbortSignal) => runOne(key, signal)),
      { concurrency: FILE_CONCURRENCY, signal: controller.signal },
    )
  } catch (err) {
    setNotice(err instanceof Error ? err.message : String(err))
  } finally {
    setRunning(false)
    aborter = null
  }
}

export const startBatch = (): Promise<void> =>
  runKeys(rows.filter((r) => r.status === 'queued').map((r) => r.key))

export async function retryRow(key: string): Promise<void> {
  const index = indexOf.get(key)
  if (index === undefined) return
  if (rows[index].discarded) {
    // The server row is `failed`, which ingest_mark_uploading will not move
    // back to `uploading`. Only a new file_id can recover it.
    await forgetFile(key)
    patch(key, { fileId: crypto.randomUUID(), discarded: false, resumed: false })
  }
  patch(key, { status: 'queued', loaded: 0, message: 'queued' })
  await runKeys([key])
}

export const retryAllFailed = (): Promise<void> =>
  runKeys(rows.filter((r) => r.status === 'failed' || r.status === 'cancelled').map((r) => r.key))

export const cancel = (): void => aborter?.abort(new DOMException('cancelled', 'AbortError'))
