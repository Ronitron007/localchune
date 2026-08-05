// src/components/UploadDropzone.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createSignal, createMemo, onMount, For, Show } from 'solid-js'
import {
  walkEntries, filterFlatFiles, MAX_FILES,
  type FileSystemEntryLike, type FileEntryLike,
} from '../lib/dir-walk'
import {
  batchStarted, cancel, configureEngine, enqueue, retryAllFailed, retryRow,
  startBatch, startFresh,
} from '../lib/upload-engine'
import {
  setUploadLabel, setUploadNotice, uploadLabel, uploadNotice, uploadRows, uploadRunning,
} from '../lib/upload-store'
import { aggregateUploads } from '../lib/upload-progress'
import { formatBytes } from '../lib/format'
import StatusRegion from './StatusRegion'

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

/**
 * UX.12 — /upload IS NOW A VIEWPORT, NOT AN OWNER.
 *
 * Every piece of state this component used to hold — the queue, the File
 * handles, the AbortController, the batch id, the pump — moved to
 * src/lib/upload-engine.ts, a module singleton. This file renders that
 * engine and drives it. Nothing here survives a navigation and nothing here
 * needs to: re-entering /upload mid-batch mounts a fresh component over the
 * SAME live queue, so the rows, the progress and the in-flight transfers are
 * exactly where they were left.
 *
 * The only state still local to this component is `over` — whether a drag is
 * hovering the dropzone. That is a property of this page's DOM and of
 * nothing else, and it is correct for it to reset when the page is left.
 *
 * The capture-phase document click guard that used to live in this file's
 * onMount is GONE, along with nav-guard.ts. upload-engine.ts's
 * `installUnloadGuard` explains the reasoning in full and carries the
 * popstate investigation this file used to hold: a soft navigation is no
 * longer a way to lose a batch, so warning about one is now a false alarm,
 * and the `beforeunload` guard that covers the genuinely fatal cases moved
 * next to the state it protects.
 */
export default function UploadDropzone(props: { userId: string }) {
  const [over, setOver] = createSignal(false)

  // Refs to the two hidden native inputs — the "Choose files"/"Choose
  // folder" buttons below are the only visible, keyboard-reachable pickers;
  // clicking one forwards to input.click() to open the OS dialog.
  let fileInputEl: HTMLInputElement | undefined
  let folderInputEl: HTMLInputElement | undefined

  onMount(() => {
    // onMount, not the component body: this island is server-rendered for its
    // initial HTML, and the body runs in the Worker where neither indexedDB
    // nor window exists. configureEngine is idempotent — /upload can be
    // entered many times per document, and the journal prunes once.
    configureEngine(props.userId)
  })

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
    if (notices.length > 0) setUploadNotice(notices.join(' '))
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
      if (notices.length > 0) setUploadNotice(notices.join(' '))
      await enqueue(result.files)
    }
    event.currentTarget.value = ''
  }

  // Reading the engine's store inside a memo is what subscribes this
  // component to it. It is the same arithmetic the chip runs, from the same
  // module, so the two viewports can never disagree about how far along the
  // batch is.
  const agg = createMemo(() => aggregateUploads(uploadRows))
  const selectedCount = createMemo(() => uploadRows.length)
  const queuedCount = createMemo(() => uploadRows.filter((r) => r.status === 'queued').length)
  const resumableCount = createMemo(() =>
    uploadRows.filter((r) => r.resumed && r.status === 'queued').length)

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
            type="text" placeholder="july promos" value={uploadLabel()}
            disabled={batchStarted()}
            onInput={(e) => setUploadLabel(e.currentTarget.value)}
          />
        </label>
      </p>

      <Show when={resumableCount() > 0}>
        <p class="resume-prompt" aria-live="polite">
          {resumableCount()} of these were uploaded before and can carry on from where they
          stopped.{' '}
          <button type="button" class="btn" onClick={() => void startBatch()} disabled={uploadRunning()}>Resume</button>{' '}
          <button type="button" class="btn-secondary" onClick={() => void startFresh()} disabled={uploadRunning()}>Start fresh</button>
        </p>
      </Show>

      <p>
        <button type="button" class="btn" onClick={() => void startBatch()} disabled={uploadRunning() || queuedCount() === 0}>
          Upload {queuedCount()} file{queuedCount() === 1 ? '' : 's'}
        </button>{' '}
        <button type="button" class="btn-secondary" onClick={() => void retryAllFailed()} disabled={uploadRunning() || agg().failed === 0}>
          Retry {agg().failed} failed
        </button>{' '}
        <button type="button" class="btn-danger" onClick={cancel} disabled={!uploadRunning()}>Cancel</button>
      </p>

      <Show when={agg().total > 0}>
        <p aria-live="polite">
          {agg().finished} of {agg().total} done — {formatBytes(agg().sentBytes)} of{' '}
          {formatBytes(agg().totalBytes)}
        </p>
        <progress value={agg().sentBytes} max={Math.max(1, agg().totalBytes)} />
      </Show>

      <StatusRegion message={uploadNotice()} tone="error" />

      <ul class="rows">
        <For each={uploadRows}>{(row) => (
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
              <button type="button" class="btn-secondary" disabled={uploadRunning()} onClick={() => void retryRow(row.key)}>
                Retry
              </button>
            </Show>
          </li>
        )}</For>
      </ul>
    </section>
  )
}
