// src/components/UploadDropzone.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createSignal, createMemo, onMount, onCleanup, For, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { planUpload } from '../lib/upload-policy'
import {
  walkEntries, filterFlatFiles, MAX_FILES,
  type FileSystemEntryLike, type FileEntryLike,
} from '../lib/dir-walk'
// readDurationMs resolves to a DurationRead ({ durationMs, source, note? }),
// never a bare number — a bare number cannot say "this is an estimate", and
// that distinction is the entire point of Task 6. preflightFile wraps
// upload-policy's preflight()/preflightMessage() so this component never
// calls them directly, and formatDuration is imported rather than
// reimplemented here.
import { readDurationMs, preflightFile, formatDuration } from '../lib/preflight'
import {
  journalKey, lookupFile, rememberFile, forgetFile, pruneJournal,
} from '../lib/upload-journal'
import {
  httpApi, uploadFile, isAbortError, SessionExpiredError, UploadFailure,
  type UploadItem,
} from '../lib/uploader'
import { pump, FILE_CONCURRENCY, PREFLIGHT_CONCURRENCY } from '../lib/upload-queue'
import { formatBytes } from '../lib/format'
import { setCurrentBatchId } from '../lib/upload-batch'
import StatusRegion from './StatusRegion'

type RowStatus =
  | 'checking' | 'skipped' | 'queued' | 'uploading'
  | 'done' | 'already' | 'failed' | 'cancelled'

interface Row {
  key: string
  fileId: string
  name: string
  size: number
  status: RowStatus
  loaded: number
  message: string
  /** mm:ss from formatDuration, suffixed "~" when it is an estimate
   *  (a VBR mp3 with no Xing header — Task 6 measured that ~17% low). */
  duration: string
  /** The journal recognised this file: it will resume, not restart. */
  resumed: boolean
  /** /api/upload/abort was called, so the server row is `failed` and terminal.
   *  Retry must mint a new file_id. */
  discarded: boolean
}

const ACCEPT = '.mp3,.flac,.wav,.wave,.aiff,.aif,.aifc,.m4a,.mp4,.ogg,.oga,.opus,audio/*'

/**
 * A DJ drags a FOLDER of 200 tracks, not 200 selected files. dataTransfer.files
 * is empty for a directory drop, so the entry API is the only way to read it.
 * The actual recursive walk — including the readEntries() pagination loop
 * and the extension/dotfile/__MACOSX/zero-byte/depth/count filtering — is
 * dir-walk.ts, pure and unit-tested in node. This function is only the DOM
 * boundary: pulling entries out of a DataTransfer and narrowing them to
 * dir-walk's minimal FileSystemEntryLike shape.
 *
 * A loose file dropped alongside (or instead of) a folder is NOT run
 * through dir-walk's filter — it is handed straight to enqueue(), same as
 * before, so preflightFile still reports a visible, specific reason
 * ("skipped — not an audio file…") instead of the file silently
 * vanishing. The filter exists to declutter a folder's worth of
 * .DS_Store/cover-art/__MACOSX junk, not to police a file the user picked
 * on purpose.
 */
async function collectFiles(transfer: DataTransfer): Promise<{ files: File[]; truncated: boolean; skipped_unsupported: number }> {
  const items = [...transfer.items]
  const entries = items.map((item) =>
    typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)
  if (entries.every((entry) => entry === null)) {
    // No File and Directory Entries API support at all. Degrade to the flat
    // list DataTransfer gives directly — folder contents may simply be
    // absent in that case, which is the browser's limitation, not this
    // module's.
    return { files: [...transfer.files], truncated: false, skipped_unsupported: 0 }
  }

  const files: File[] = []
  let truncated = false
  let skipped_unsupported = 0
  for (const entry of entries) {
    if (entry === null) continue
    if (entry.isDirectory) {
      const remaining = MAX_FILES - files.length
      const result = await walkEntries([entry as unknown as FileSystemEntryLike], { maxFiles: remaining })
      files.push(...result.files)
      skipped_unsupported += result.skipped_unsupported
      if (!result.ok) truncated = true
    } else {
      const file = await new Promise<File | null>((resolve) => {
        (entry as unknown as FileEntryLike).file(resolve, () => resolve(null))
      })
      if (file !== null) files.push(file)
    }
    if (truncated) break
  }
  return { files, truncated, skipped_unsupported }
}

export default function UploadDropzone(props: { userId: string }) {
  const [rows, setRows] = createStore<Row[]>([])
  const [label, setLabel] = createSignal('')
  const [running, setRunning] = createSignal(false)
  const [notice, setNotice] = createSignal('')
  const [over, setOver] = createSignal(false)
  const selectedCount = createMemo(() => rows.length)

  // Refs to the two hidden native inputs — the "Choose files"/"Choose
  // folder" buttons below are the only visible, keyboard-reachable pickers;
  // clicking one forwards to input.click() to open the OS dialog.
  let fileInputEl: HTMLInputElement | undefined
  let folderInputEl: HTMLInputElement | undefined

  // Deliberately NOT in the store. createStore deep-proxies plain objects, and
  // a proxied File is no longer something xhr.send() will accept.
  const handles = new Map<string, File>()
  // Only a header-sourced duration ever goes here — the value sent to
  // ingest_begin as client_duration_ms. An estimate is displayed (row.duration)
  // but never stored in this map and never leaves the browser.
  const clientDurations = new Map<string, number | null>()
  const indexOf = new Map<string, number>()

  let batchId: string | null = null
  let aborter: AbortController | null = null

  onMount(() => {
    // onMount, not the component body: this island is server-rendered for its
    // initial HTML, and the body runs in the Worker where neither indexedDB
    // nor window exists.
    void pruneJournal()
    const warn = (event: BeforeUnloadEvent) => { if (running()) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    onCleanup(() => window.removeEventListener('beforeunload', warn))
  })

  const patch = (key: string, next: Partial<Row>) => {
    const index = indexOf.get(key)
    if (index !== undefined) setRows(index, next)
  }

  const enqueue = async (picked: File[]) => {
    const added: { key: string; file: File }[] = []
    for (const file of picked) {
      const key = journalKey(props.userId, file)
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

  const onDrop = async (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    if (event.dataTransfer === null) return
    const { files, truncated, skipped_unsupported } = await collectFiles(event.dataTransfer)
    const notices: string[] = []
    if (skipped_unsupported > 0) {
      notices.push(`${skipped_unsupported} file${skipped_unsupported === 1 ? '' : 's'} skipped — unsupported format or empty.`)
    }
    if (truncated) {
      notices.push(`Only the first ${MAX_FILES} files in that folder were used.`)
    }
    if (notices.length > 0) setNotice(notices.join(' '))
    await enqueue(files)
  }

  const onPick = async (event: Event & { currentTarget: HTMLInputElement }) => {
    const list = event.currentTarget.files
    if (list !== null) await enqueue([...list])
    event.currentTarget.value = ''
  }

  /**
   * The picker's folder path: a second `<input type="file" webkitdirectory>`
   * next to the plain file input — a single `<input>` cannot be BOTH a file
   * picker and a folder picker at once, hence two inputs. The browser has
   * already done the recursion by the time `files` lands here; only the
   * shared dir-walk filter (extension allowlist, dotfiles, __MACOSX,
   * zero-byte, the same 2,000-file cap) needs applying.
   */
  const onPickFolder = async (event: Event & { currentTarget: HTMLInputElement }) => {
    const list = event.currentTarget.files
    if (list !== null) {
      const result = filterFlatFiles(list)
      const notices: string[] = []
      if (result.skipped_unsupported > 0) {
        notices.push(`${result.skipped_unsupported} file${result.skipped_unsupported === 1 ? '' : 's'} skipped — unsupported format or empty.`)
      }
      if (!result.ok) {
        notices.push(`Only the first ${MAX_FILES} files in that folder were used.`)
      }
      if (notices.length > 0) setNotice(notices.join(' '))
      await enqueue(result.files)
    }
    event.currentTarget.value = ''
  }

  const startFresh = async () => {
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

  const runOne = async (key: string, signal: AbortSignal): Promise<void> => {
    const file = handles.get(key)
    const index = indexOf.get(key)
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
      key, userId: props.userId, fileId: row.fileId, batchId,
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

  const runKeys = async (keys: string[]) => {
    if (keys.length === 0 || running()) return
    setRunning(true)
    setNotice('')
    const controller = new AbortController()
    aborter = controller
    try {
      if (batchId === null) {
        batchId = (await httpApi.createBatch(label().trim() || null)).batchId
        // Publish to FileStateTicker, which is a sibling island and cannot
        // read this closure.
        setCurrentBatchId(batchId)
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

  const startBatch = () =>
    runKeys(rows.filter((r) => r.status === 'queued').map((r) => r.key))

  const retryRow = async (key: string) => {
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

  const retryAllFailed = () =>
    runKeys(rows.filter((r) => r.status === 'failed' || r.status === 'cancelled').map((r) => r.key))

  const cancel = () => aborter?.abort(new DOMException('cancelled', 'AbortError'))

  const active = createMemo(() => rows.filter((r) => r.status !== 'skipped'))
  const totalBytes = createMemo(() => active().reduce((sum, r) => sum + r.size, 0))
  const sentBytes = createMemo(() => active().reduce((sum, r) => sum + r.loaded, 0))
  const queuedCount = createMemo(() => rows.filter((r) => r.status === 'queued').length)
  const finishedCount = createMemo(() =>
    rows.filter((r) => r.status === 'done' || r.status === 'already').length)
  const failedCount = createMemo(() =>
    rows.filter((r) => r.status === 'failed' || r.status === 'cancelled').length)
  const resumableCount = createMemo(() =>
    rows.filter((r) => r.resumed && r.status === 'queued').length)

  return (
    <section class="upload">
      <div
        class={over() ? 'dropzone over' : 'dropzone'}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p>Drop audio files or a folder here.</p>
        <p>mp3, flac, wav, aiff, m4a, ogg, opus — up to 15 minutes each.</p>
        <p>
          <button type="button" class="btn-secondary" onClick={() => fileInputEl?.click()}>
            Choose files
          </button>
          {' '}
          <button type="button" class="btn-secondary" onClick={() => folderInputEl?.click()}>
            Choose folder
          </button>
          {/* The two pickers below are visually hidden (.sr-only), not
              display:none — file inputs still respond to .click() either
              way, but keeping them in the a11y tree with tabindex="-1" +
              aria-hidden means the buttons above are the only stop in the
              tab order and the only thing a screen reader announces; two
              native "No file chosen" labels reading side by side is
              exactly the duplicate-picker confusion this replaces. */}
          <input
            type="file"
            multiple
            accept={ACCEPT}
            class="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onInput={onPick}
            ref={(el) => { fileInputEl = el }}
          />
          {/* webkitdirectory is not in Solid's InputHTMLAttributes typings
              (it is a non-standard, unratified attribute), so it is set
              imperatively via ref rather than as a JSX prop. A folder
              picker and a file picker cannot share one <input> — selecting
              webkitdirectory turns the OS dialog into a folder chooser and
              silently disables multi-file selection. */}
          <input
            type="file"
            class="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            ref={(el) => {
              folderInputEl = el
              el.setAttribute('webkitdirectory', '')
              el.setAttribute('directory', '')
            }}
            onInput={onPickFolder}
          />
        </p>
        <Show when={selectedCount() > 0}>
          <p class="picker-status" aria-live="polite">
            {selectedCount()} file{selectedCount() === 1 ? '' : 's'} selected
          </p>
        </Show>
      </div>

      <p>
        <label>
          Batch label{' '}
          <input
            type="text" placeholder="july promos" value={label()}
            disabled={batchId !== null}
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
        </label>
      </p>

      <Show when={resumableCount() > 0}>
        <p class="resume-prompt" aria-live="polite">
          {resumableCount()} of these were uploaded before and can carry on from where they
          stopped.{' '}
          <button type="button" class="btn" onClick={startBatch} disabled={running()}>Resume</button>{' '}
          <button type="button" class="btn-secondary" onClick={startFresh} disabled={running()}>Start fresh</button>
        </p>
      </Show>

      <p>
        <button type="button" class="btn" onClick={startBatch} disabled={running() || queuedCount() === 0}>
          Upload {queuedCount()} file{queuedCount() === 1 ? '' : 's'}
        </button>{' '}
        <button type="button" class="btn-secondary" onClick={retryAllFailed} disabled={running() || failedCount() === 0}>
          Retry {failedCount()} failed
        </button>{' '}
        <button type="button" class="btn-danger" onClick={cancel} disabled={!running()}>Cancel</button>
      </p>

      <Show when={active().length > 0}>
        <p aria-live="polite">
          {finishedCount()} of {active().length} done — {formatBytes(sentBytes())} of{' '}
          {formatBytes(totalBytes())}
        </p>
        <progress value={sentBytes()} max={Math.max(1, totalBytes())} />
      </Show>

      <StatusRegion message={notice()} tone="error" />

      <ul class="rows">
        <For each={rows}>{(row) => (
          <li class={`row ${row.status}`}>
            <span class="name">{row.name}</span>
            <span class="size">{formatBytes(row.size)}</span>
            <span class="duration">{row.duration}</span>
            <Show when={row.status === 'uploading'}>
              <progress value={row.loaded} max={Math.max(1, row.size)} />
            </Show>
            <span class="message">{row.message}</span>
            <Show when={row.status === 'failed' || row.status === 'cancelled'}>
              {' '}
              <button type="button" class="btn-secondary" disabled={running()} onClick={() => void retryRow(row.key)}>
                Retry
              </button>
            </Show>
          </li>
        )}</For>
      </ul>
    </section>
  )
}
