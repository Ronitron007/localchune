// src/components/FileStateTicker.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import AnalysisFailedRow from './AnalysisFailedRow'
import StatusRegion from './StatusRegion'
import { currentBatchId, type FileStatus } from '../lib/upload-batch'

const POLL_MS = 5_000
/** Stop after twenty minutes. A stuck row is M3's cron's problem, not a
 *  reason to poll this member's browser until they close the tab. */
const MAX_POLL_MS = 20 * 60 * 1000

const LABEL: Record<string, string> = {
  pending: 'waiting',
  uploading: 'uploading',
  received: 'uploaded — queued for analysis',
  analysing: 'being listened to…',
  stored: 'ready',
  needs_review: 'held for review',
}

const FAILED = new Set([
  'failed', 'abandoned', 'quarantined', 'rejected_duration', 'rejected_redundant',
])

/**
 * The moment an upload visibly completes its journey: received → analysing
 * → stored, per file, without a page refresh.
 *
 * A degraded analysis (bpm 0, no beat found) still reaches `stored` and
 * still says "ready" — it is data, not an error. The em dash and the "no
 * beat detected" tooltip live in the pool table, where the number would be.
 */
export default function FileStateTicker() {
  const [files, setFiles] = createSignal<FileStatus[]>([])
  const [status, setStatus] = createSignal('')

  createEffect(() => {
    const batch = currentBatchId()
    setFiles([])
    if (batch === null) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const startedAt = Date.now()
    const controller = new AbortController()

    const stop = () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      controller.abort()
    }
    onCleanup(stop)

    const tick = async () => {
      if (stopped) return
      // Paused, not stopped: a backgrounded tab polling every five seconds
      // is a battery bug. visibilitychange below wakes it straight back up.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => void tick(), POLL_MS)
        return
      }
      try {
        const res = await fetch(`/api/upload/status?batch_id=${batch}`, {
          headers: { accept: 'application/json' }, signal: controller.signal,
        })
        if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
          setStatus('Your session ended. Reload the page to sign in again.')
          stop()
          return
        }
        const body = (await res.json()) as {
          files?: FileStatus[]; allTerminal?: boolean; error?: string; message?: string
        }
        if (!res.ok) {
          setStatus(body.message ?? body.error ?? `failed (${res.status})`)
          stop()
          return
        }
        setFiles(body.files ?? [])
        setStatus('')
        // The stop condition is the server's `terminal` flag, not a list of
        // state names copied into the browser — one place decides.
        if (body.allTerminal) return
        if (Date.now() - startedAt > MAX_POLL_MS) {
          setStatus('Still working. Reload this page to check again.')
          return
        }
        timer = setTimeout(() => void tick(), POLL_MS)
      } catch (err) {
        if (controller.signal.aborted) return
        setStatus(err instanceof Error ? err.message : String(err))
        timer = setTimeout(() => void tick(), POLL_MS)
      }
    }

    const wake = () => { if (!document.hidden && !stopped) void tick() }
    document.addEventListener('visibilitychange', wake)
    onCleanup(() => document.removeEventListener('visibilitychange', wake))

    void tick()
  })

  return (
    <Show when={files().length > 0}>
      <section class="ticker">
        <h2>Processing</h2>
        <StatusRegion message={status()} />
        <ul>
          <For each={files()}>{(f) => (
            <Show
              when={!FAILED.has(f.state)}
              fallback={
                <AnalysisFailedRow
                  name={f.original_filename} state={f.state} reason={f.reason}
                />
              }
            >
              <li class={`filerow ${f.state}`}>
                <span class="name">{f.original_filename}</span>
                <span class="state">{LABEL[f.state] ?? f.state}</span>
                <Show when={f.state === 'stored'}>
                  {' '}<a href={`/track/${f.file_id}`}>open</a>
                </Show>
              </li>
            </Show>
          )}</For>
        </ul>
      </section>
    </Show>
  )
}
