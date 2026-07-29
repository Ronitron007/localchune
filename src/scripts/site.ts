// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'
import { formatDuration } from '../lib/format'
import { SessionExpiredError, toggleLike } from '../lib/org-api'
import { createPlayMeter } from '../lib/play-meter'

/**
 * The whole client: play-link delegation into the one persisted <audio>,
 * the custom transport row (Task 3 — a mobile scrubber, since native
 * `controls` renders inconsistently on phones), and the search box's
 * auto-submit. Document-level listeners on purpose — the ClientRouter
 * swaps page bodies, and delegation is what survives a swap without
 * re-binding. Without JS every play link degrades to its href (the track
 * page) and the Filter button submits the form.
 *
 * The elements below are looked up ONCE, at module load. Because this
 * script is a `<script src>` (not inline), Astro's ClientRouter runs it
 * exactly once per document load and never again on a SPA navigation —
 * and because .playerbar carries transition:persist="player", the same
 * DOM nodes (this audio element included) are moved into every new page
 * rather than recreated. That combination is what makes playback survive
 * navigation: these consts stay valid, and nothing needs re-binding.
 */
const audio = document.getElementById('player-audio') as HTMLAudioElement | null
const label = document.getElementById('player-label')
const toggle = document.getElementById('player-toggle') as HTMLButtonElement | null
const time = document.getElementById('player-time')
const seek = document.getElementById('player-seek') as HTMLInputElement | null

// True for the span between the range's first `input` of a drag and the
// `change` that fires when the user lets go — timeupdate's periodic
// updates to seek.value are suppressed for that span so they never fight
// the thumb the user is actively moving.
let seeking = false

// The play-link click handler below is the one place `audio.src` is ever
// assigned, so it is also the one place that knows which track is loaded.
// Kept as a module var (not local to that handler) because the play meter's
// `onQualify` — wired up next — needs it too, and the meter itself must stay
// DOM-free per play-meter.ts's testability contract, so it cannot look this
// up on its own.
let currentTrackId: string | null = null

/**
 * M6a Task 4 — anti-scrub play counting. One meter for the one persisted
 * `<audio>` element; `onQualify` fires at most once per track (play-meter.ts
 * guarantees that) and does a fire-and-forget POST to `/api/track/:id/play`.
 * Errors are swallowed on purpose: a lost play count must never surface in
 * the UI, unlike a lost like (org-api.ts's `toggleLike`) or a lost track
 * load, both of which report failure through `#player-label`.
 */
const playMeter = createPlayMeter({
  onQualify: () => {
    if (currentTrackId === null) return
    void fetch(`/api/track/${currentTrackId}/play`, { method: 'POST' }).catch(() => {})
  },
})

function updateToggle() {
  if (!toggle || !audio) return
  const playing = !audio.paused && !audio.ended
  toggle.textContent = playing ? '⏸' : '▶'
  toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play')
}

function updateTime() {
  if (!time || !audio) return
  // formatDuration takes milliseconds and already renders "--:--" for a
  // non-finite input, which covers `duration` being NaN before metadata
  // has loaded — no separate Number.isFinite check needed here.
  time.textContent = `${formatDuration(audio.currentTime * 1000)} / ${formatDuration(audio.duration * 1000)}`
}

function updateSeekRange() {
  if (!seek || !audio) return
  if (Number.isFinite(audio.duration) && audio.duration > 0) seek.max = String(Math.floor(audio.duration))
  if (!seeking) seek.value = String(Math.floor(audio.currentTime))
}

if (audio && toggle) {
  toggle.addEventListener('click', () => {
    if (audio.paused) {
      void audio.play().catch(() => {
        if (label) label.textContent = 'Nothing to play yet.'
      })
    } else {
      audio.pause()
    }
  })
  audio.addEventListener('play', updateToggle)
  audio.addEventListener('pause', updateToggle)
  audio.addEventListener('ended', updateToggle)
}

if (audio && seek) {
  audio.addEventListener('loadedmetadata', updateSeekRange)
  audio.addEventListener('durationchange', updateSeekRange)
  // `input` fires continuously while dragging (mouse or touch) — seeking
  // live as the thumb moves is the whole point of a touch-friendly range.
  seek.addEventListener('input', () => {
    seeking = true
    audio.currentTime = Number(seek.value)
    updateTime()
  })
  // `change` fires once, on release — the moment timeupdate's own
  // updates are safe to resume.
  seek.addEventListener('change', () => { seeking = false })
}

if (audio) {
  // timeupdate can fire several times a second; there is no reason to
  // touch the DOM faster than the ~1 Hz clock actually needs.
  let lastTick = -1
  audio.addEventListener('timeupdate', () => {
    const tick = Math.floor(audio.currentTime)
    if (tick === lastTick) return
    lastTick = tick
    updateTime()
    updateSeekRange()
    playMeter.tick(audio.currentTime)
  })
}

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a.play[data-track-id]')
  if (!(a instanceof HTMLAnchorElement) || audio === null) return
  e.preventDefault()
  void (async () => {
    const res = await fetch(`/api/track/${a.dataset.trackId}/source`, {
      headers: { accept: 'application/json' },
    })
    // Non-JSON means middleware redirected to /login — say so, do not parse.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (label) label.textContent = 'Session ended — reload to sign in.'
      return
    }
    const body = (await res.json()) as { url?: string; message?: string; error?: string }
    if (!res.ok || !body.url) {
      if (label) label.textContent = body.message ?? body.error ?? 'could not load that track'
      return
    }
    audio.src = body.url
    currentTrackId = a.dataset.trackId ?? null
    playMeter.reset()
    if (label) label.textContent = a.dataset.label ?? ''
    // Clear the previous track's elapsed/total and seek position rather
    // than leaving them on screen until the new track's first timeupdate —
    // loadedmetadata still fires normally afterwards and fills in the new
    // duration.
    if (time) time.textContent = `${formatDuration(0)} / --:--`
    if (seek) { seek.value = '0'; seek.max = '0' }
    void audio.play().catch(() => {
      if (label) label.textContent = 'That track would not play. Try downloading it.'
    })
  })()
})

/**
 * M6a Task 3 — the ♥ toggle. `form.likeform` renders in two places
 * (TrackRow.astro's pool-table cell, the track page's signals block) with
 * the same shape: a <button class="likebtn"> carrying `data-file-id`,
 * `aria-pressed`, and a `.likeglyph`/`.likecount` pair to update in place.
 * One document-level delegation covers both, same idiom as the play-link
 * handler above — no per-row listener to (re)bind on a ClientRouter swap.
 *
 * Optimistic: the glyph/count/aria-pressed flip the instant the form is
 * submitted, before the network round trip, and org-api.ts's toggleLike()
 * either confirms them with the server's authoritative count (covers a
 * concurrent like/unlike elsewhere landing first) or the catch below rolls
 * every one of them back to exactly what they were before this click and
 * reports why in the shared player status region — the same aria-live
 * element the play handler already uses for "session ended"/"could not
 * load" messages, so a like failure is announced the same way a play
 * failure already is.
 */
document.addEventListener('submit', (e) => {
  const form = (e.target as Element).closest?.('form.likeform')
  if (!(form instanceof HTMLFormElement)) return
  const button = form.querySelector('button.likebtn')
  if (!(button instanceof HTMLButtonElement)) return
  const fileId = button.dataset.fileId
  const glyph = button.querySelector('.likeglyph')
  const countEl = button.querySelector('.likecount')
  if (!fileId || !glyph || !countEl) return
  e.preventDefault()

  const wasLiked = button.getAttribute('aria-pressed') === 'true'
  const prevCount = Number(countEl.textContent ?? '0')
  const setState = (liked: boolean, count: number) => {
    button.setAttribute('aria-pressed', String(liked))
    glyph.textContent = liked ? '♥' : '♡'
    countEl.textContent = String(count)
  }

  setState(!wasLiked, prevCount + (wasLiked ? -1 : 1))
  button.disabled = true
  void (async () => {
    try {
      const result = await toggleLike(fileId)
      setState(result.liked, result.like_count)
    } catch (err) {
      setState(wasLiked, prevCount)
      if (label) {
        label.textContent = err instanceof SessionExpiredError
          ? 'Session ended — reload to sign in.'
          : err instanceof Error ? err.message : 'Could not update like.'
      }
    } finally {
      button.disabled = false
    }
  })()
})

/**
 * M6a Task 7 — crate drag-to-reorder. TrackRow.astro's rows render
 * `draggable`/`data-file-id` only when the page passes `reorderable`
 * (crate/[id].astro's owner view), inside a `[data-reorder]` container
 * that carries the crate id itself. No such container exists on the pool
 * table or the track page, so every listener below is a silent no-op
 * there — the same "degrade to nothing" contract every other document-
 * level delegation in this file already has.
 *
 * Native HTML5 drag-and-drop, not a pointer-capture reimplementation:
 * `dragover` moves the dragged row's actual DOM node — before or after
 * the row under the cursor, chosen by which half of it the pointer is
 * over — so the visible order IS the pending order, with no separate
 * "ghost" state to keep in sync. `drop` reads that same DOM order straight
 * back out via each row's `data-file-id` and POSTs it to `.../reorder`.
 * The server (`crate_reorder`, migration 20) is the only authority on
 * whether the result is legal — on any failure the page reloads, so the
 * visible order snaps back to whatever the database actually has rather
 * than leaving a client-side order the server never accepted.
 *
 * Keyboard users are covered by a separate mechanism, not an afterthought:
 * the always-present ↑/↓ button forms next to each row (real
 * `<button type="submit">`s, tabbable and Enter/Space-activatable with
 * zero JS) POST to `/api/crate/[id]/move`, which reorders with the same
 * `moveInList()` `org-api.ts` exports. Native drag-and-drop has no
 * keyboard path of its own — that pair of buttons is it.
 */
let draggingRow: HTMLTableRowElement | null = null
let dragContainer: HTMLElement | null = null
let dragOrderSnapshot: string[] | null = null
let dropHandled = false

document.addEventListener('dragstart', (e) => {
  const row = (e.target as Element).closest?.('tr[draggable="true"][data-file-id]')
  if (!(row instanceof HTMLTableRowElement) || !row.closest('[data-reorder]')) return
  draggingRow = row
  const container = row.closest('[data-reorder]')
  dragContainer = container instanceof HTMLElement ? container : null
  dragOrderSnapshot = dragContainer === null ? null : Array.from(
    dragContainer.querySelectorAll<HTMLElement>('tr[data-file-id]'),
  ).map((r) => r.dataset.fileId ?? '')
  dropHandled = false
  e.dataTransfer?.setData('text/plain', row.dataset.fileId ?? '')
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
})

document.addEventListener('dragover', (e) => {
  if (draggingRow === null) return
  const container = (e.target as Element).closest?.('[data-reorder]')
  if (!container || !container.contains(draggingRow)) return
  e.preventDefault() // allow drop
  const overRow = (e.target as Element).closest?.('tr[data-file-id]')
  if (!(overRow instanceof HTMLTableRowElement) || overRow === draggingRow) return
  const rect = overRow.getBoundingClientRect()
  const before = e.clientY < rect.top + rect.height / 2
  overRow.parentElement?.insertBefore(draggingRow, before ? overRow : overRow.nextSibling)
})

document.addEventListener('drop', (e) => {
  if (draggingRow === null) return
  e.preventDefault()
  const container = draggingRow.closest('[data-reorder]')
  draggingRow = null
  if (container instanceof HTMLElement) {
    dropHandled = true
    void submitCrateOrder(container)
  }
})

document.addEventListener('dragend', () => {
  // A drop released outside [data-reorder] (past the table, over thead,
  // off-page, or cancelled via Escape) fires dragend with no drop — dragover
  // already live-mutated the DOM with nothing left to persist that order.
  // Restore this file's stated invariant (server order wins on any failure)
  // by reloading whenever the DOM order no longer matches the drag's start.
  if (!dropHandled && dragContainer) {
    const currentOrder = Array.from(
      dragContainer.querySelectorAll<HTMLElement>('tr[data-file-id]'),
    ).map((r) => r.dataset.fileId ?? '')
    const unchanged = dragOrderSnapshot !== null
      && dragOrderSnapshot.length === currentOrder.length
      && dragOrderSnapshot.every((id, i) => id === currentOrder[i])
    if (!unchanged) window.location.reload()
  }
  draggingRow = null
  dragContainer = null
  dragOrderSnapshot = null
  dropHandled = false
})

async function submitCrateOrder(container: HTMLElement) {
  const crateId = container.dataset.reorder
  if (!crateId) return
  const fileIds = Array.from(container.querySelectorAll<HTMLElement>('tr[data-file-id]'))
    .map((row) => row.dataset.fileId)
    .filter((v): v is string => typeof v === 'string')
  try {
    const res = await fetch(`/api/crate/${crateId}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ file_ids: fileIds }),
    })
    if (!res.ok) throw new Error('reorder failed')
  } catch {
    // Server rejected it (not a valid permutation, not the owner any
    // more, a dropped connection) — reload rather than leave the DOM
    // showing an order the database never committed.
    window.location.reload()
  }
}

const autosubmit = debounce((form: HTMLFormElement) => form.requestSubmit(), 300)
document.addEventListener('input', (e) => {
  const el = e.target
  if (el instanceof HTMLInputElement && el.name === 'q'
      && el.form?.hasAttribute('data-autosubmit')) autosubmit(el.form)
})
