// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'
import { formatDuration } from '../lib/format'
import {
  addToCrate, createCrate, DuplicateCrateItemError, SessionExpiredError, toggleLike,
} from '../lib/org-api'
import { createPlayMeter } from '../lib/play-meter'
import { PLAYER_MEMORY_KEY, isStale, makeEntry, parseEntry, serializeEntry } from '../lib/player-memory'

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

// The track currently loaded into `audio` — set the instant a track is
// REQUESTED (before its fetch resolves), by either a play-link click or a
// successful restore. Doubles as the restore path's "has anyone else
// already claimed the transport" guard: a click sets this synchronously,
// so if it is non-null by the time restore's own fetch comes back, restore
// backs off instead of stomping on whatever the user just chose to play.
// The play meter's `onQualify` below reads it too — the meter itself must
// stay DOM-free per play-meter.ts's testability contract.
let currentFileId: string | null = null
let currentTitle = ''

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
    if (currentFileId === null) return
    void fetch(`/api/track/${currentFileId}/play`, { method: 'POST' }).catch(() => {})
  },
})

/**
 * "Have a localStorage which stores the last track the user was listening
 * to and the timestamp" — the owner's ask. Only ever called while a track
 * is loaded (`currentFileId` set); localStorage can throw in Safari private
 * mode / a locked-down profile, so resume is best-effort, never load-bearing.
 */
function savePlayerMemory() {
  if (audio === null || currentFileId === null) return
  try {
    localStorage.setItem(
      PLAYER_MEMORY_KEY,
      serializeEntry(makeEntry(currentFileId, currentTitle, audio.currentTime)),
    )
  } catch {
    // storage disabled or full — nothing to resume next time, not fatal now.
  }
}

function clearPlayerMemory() {
  try {
    localStorage.removeItem(PLAYER_MEMORY_KEY)
  } catch {
    // ditto — nothing to clean up if storage was never writable.
  }
}

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
  // Player-resume: a pause is a deliberate "I might come back to this"
  // moment, worth a save even before the next ~1 Hz timeupdate tick would
  // have caught it. `ended` is the opposite signal — the track finished,
  // so there is nothing left to resume.
  audio.addEventListener('pause', savePlayerMemory)
  audio.addEventListener('ended', clearPlayerMemory)
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
    savePlayerMemory()
  })
}

// Player-resume, continued: a soft nav (ClientRouter swaps the page body
// around this persisted player) and a hard unload (tab close, typed URL)
// are the two moments a save could otherwise be missed between timeupdate
// ticks. `astro:before-swap` fires on `document` for every soft
// navigation (see node_modules/astro/dist/transitions/events.js — the same
// event UploadDropzone's nav guard investigated); `beforeunload` is
// best-effort, same as the upload journal's own unload handling.
if (audio) {
  document.addEventListener('astro:before-swap', savePlayerMemory)
  window.addEventListener('beforeunload', savePlayerMemory)
}

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a.play[data-track-id]')
  if (!(a instanceof HTMLAnchorElement) || audio === null) return
  e.preventDefault()
  const trackId = a.dataset.trackId
  if (trackId === undefined) return
  // Claimed synchronously, before the fetch below even starts — this is
  // what lets a click always win a race against an in-flight restore (see
  // restorePlayer()'s own re-check of currentFileId after its fetch).
  currentFileId = trackId
  currentTitle = a.dataset.label ?? ''
  void (async () => {
    const res = await fetch(`/api/track/${trackId}/source`, {
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
    playMeter.reset()
    if (label) label.textContent = currentTitle
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
/**
 * Delegated confirm() for any form carrying data-confirm. Lives here
 * instead of an inline handler attribute because Cloudflare's API WAF
 * challenges a Worker upload whose bundle contains inline handlers — the
 * deploy POST 403s with an HTML challenge page. Semantics are unchanged:
 * with JS off the form submits unguarded either way.
 */
document.addEventListener('submit', (e) => {
  const form = (e.target as Element).closest?.('form[data-confirm]')
  if (!(form instanceof HTMLFormElement)) return
  const msg = form.dataset.confirm
  if (msg && !window.confirm(msg)) e.preventDefault()
})

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
 * The server (`crate_reorder`, migration 27) is the only authority on
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
    // Content-type first, same convention as org-api.ts's toggleLike/
    // addToCrate/createCrate: middleware redirects a dead session to
    // /login, and fetch() follows that redirect itself, so a lost session
    // lands here as a 200 text/html rather than a 401/403 — res.ok alone
    // would read that as a successful save when the reorder was never
    // persisted. Any non-JSON response is therefore a failure, same reload
    // path as a rejected save below.
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('application/json') || !res.ok) throw new Error('reorder failed')
  } catch {
    // Server rejected it (not a valid permutation, not the owner any
    // more, a dropped connection, a lost session) — reload rather than
    // leave the DOM showing an order the database never committed.
    window.location.reload()
  }
}

/**
 * M6a Task 8 — the `+` add-to-crate picker. TrackRow.astro renders one
 * `<details class="cratepick" data-file-id="...">` per row, server-side
 * contents a single no-JS fallback link to the track page. With JS, the
 * first `toggle` any picker on the page ever fires (native `<details>`
 * open, captured below — `toggle` does not bubble, so this listens on the
 * CAPTURE phase, the one way to delegate a non-bubbling event from the
 * document) fetches the caller's own crates exactly once
 * (GET /api/crates?mine=1) and then rebuilds EVERY picker's menu on the
 * page — not just the one that was opened — so opening any other picker
 * afterwards needs no further round trip. `crateListPromise` itself is the
 * cache; a picker already carrying `data-populated` is left alone on a
 * later open, so mid-typed "new crate…" text or a disabled button from an
 * in-flight request never gets clobbered by a redundant re-render.
 */
type CrateOption = { id: string; name: string }
let crateListPromise: Promise<CrateOption[]> | null = null

function loadCrateList(): Promise<CrateOption[]> {
  if (crateListPromise === null) {
    crateListPromise = fetch('/api/crates?mine=1', { headers: { accept: 'application/json' } })
      .then((res) => {
        const type = res.headers.get('content-type') ?? ''
        if (!res.ok || !type.includes('application/json')) return { crates: [] as CrateOption[] }
        return res.json() as Promise<{ crates?: CrateOption[] }>
      })
      .then((body) => body.crates ?? [])
      .catch(() => [])
  }
  return crateListPromise
}

/** Replaces one picker's `.cratepick-menu` with real crate buttons plus an inline "new crate…" form. */
function renderCratePickMenu(details: HTMLElement, crates: CrateOption[]) {
  const menu = details.querySelector('.cratepick-menu')
  if (!menu) return
  menu.textContent = ''

  if (crates.length === 0) {
    const p = document.createElement('p')
    p.className = 'explain'
    p.textContent = 'No crates yet.'
    menu.appendChild(p)
  } else {
    const list = document.createElement('ul')
    list.className = 'cratepick-list'
    for (const crate of crates) {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cratepick-option'
      button.textContent = crate.name
      button.dataset.crateId = crate.id
      li.appendChild(button)
      list.appendChild(li)
    }
    menu.appendChild(list)
  }

  const form = document.createElement('form')
  form.className = 'cratepick-new'
  const input = document.createElement('input')
  input.type = 'text'
  input.name = 'name'
  input.placeholder = 'new crate…'
  input.maxLength = 80
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'btn-secondary'
  submit.textContent = 'Create'
  form.appendChild(input)
  form.appendChild(submit)
  menu.appendChild(form)
}

/**
 * True when `details` is open with unsent text in its "new crate…" input —
 * the one case `populateCratePickers` must leave alone rather than clobber
 * with a fresh `renderCratePickMenu` (which blows away the input's value by
 * rebuilding the form from scratch). Left un-populated, it picks back up
 * next time it is toggled shut and open again.
 */
function hasUnsentDraft(details: HTMLElement): boolean {
  if (!(details instanceof HTMLDetailsElement) || !details.open) return false
  const input = details.querySelector<HTMLInputElement>('form.cratepick-new input[name="name"]')
  return input !== null && input.value.trim() !== ''
}

function populateCratePickers(crates: CrateOption[]) {
  document.querySelectorAll<HTMLElement>('details.cratepick:not([data-populated])').forEach((details) => {
    if (hasUnsentDraft(details)) return
    renderCratePickMenu(details, crates)
    details.dataset.populated = 'true'
  })
}

/**
 * Nulls the cache and every picker's `data-populated` flag so the next
 * `toggle`/create refetches and rebuilds from scratch. Does NOT itself
 * re-render — callers that want an immediate rebuild chain
 * `loadCrateList().then(populateCratePickers)` after this; callers that
 * only need the next OPEN to see fresh data (e.g. a failed add after a
 * successful create) call this alone.
 */
function invalidateCratePickerCache() {
  crateListPromise = null
  document.querySelectorAll<HTMLElement>('details.cratepick').forEach((d) => {
    delete d.dataset.populated
  })
}

document.addEventListener('toggle', (e) => {
  const details = e.target
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('cratepick')) return
  if (!details.open) return
  void loadCrateList().then(populateCratePickers)
}, true)

/**
 * Invariant: `crateListPromise` is fetched at most once per DOCUMENT, not
 * once per session — a ClientRouter soft navigation swaps in a new page
 * body (fresh, un-populated pickers) without a full reload, so a crate
 * created via another page's own form (e.g. /crates.astro) would otherwise
 * stay invisible in every picker until a hard reload. Null the cache on
 * every swap so the next picker open refetches.
 */
document.addEventListener('astro:after-swap', () => {
  crateListPromise = null
})

/**
 * A crate button inside an already-populated picker menu. Optimistic UX
 * would need a like-toggle-style rollback with nothing to roll back to (a
 * fresh add has no prior state) — disable-while-in-flight is enough here.
 * Feedback goes to the same `#player-label` status region the play/like
 * handlers already report through: "added to <name>" on success,
 * "already in <name>" on org-api.ts's DuplicateCrateItemError specifically,
 * so a stale menu (crate deleted mid-session, session expired) reads
 * distinctly from an ordinary failure.
 */
document.addEventListener('click', (e) => {
  const button = (e.target as Element).closest?.('button.cratepick-option')
  if (!(button instanceof HTMLButtonElement)) return
  const details = button.closest('details.cratepick')
  const fileId = details instanceof HTMLElement ? details.dataset.fileId : undefined
  const crateId = button.dataset.crateId
  const crateName = button.textContent ?? 'crate'
  if (!fileId || !crateId) return
  e.preventDefault()

  button.disabled = true
  void (async () => {
    try {
      await addToCrate(crateId, fileId)
      if (label) label.textContent = `added to ${crateName}`
      if (details instanceof HTMLDetailsElement) details.open = false
    } catch (err) {
      if (label) {
        label.textContent = err instanceof DuplicateCrateItemError
          ? `already in ${crateName}`
          : err instanceof SessionExpiredError
            ? 'Session ended — reload to sign in.'
            : err instanceof Error ? err.message : 'Could not add to crate.'
      }
    } finally {
      button.disabled = false
    }
  })()
})

/**
 * The picker's inline "new crate…" input — createCrate() then addToCrate()
 * chained, same two-step the brief describes. A fresh crate can never
 * already contain this file, so there is no duplicate branch to handle
 * here the way the button handler above needs one. On success every picker
 * on the page is invalidated and re-populated (not just this one) so the
 * new crate shows up as an option everywhere, not only in the row it was
 * created from — except one currently open with its own unsent "new
 * crate…" text, which `populateCratePickers`'s `hasUnsentDraft` check
 * leaves alone rather than clobbers; it re-populates on that picker's next
 * toggle instead.
 *
 * The two awaits are in separate try/catches on purpose: if createCrate
 * throws, nothing was created server-side, so the generic message below is
 * accurate. If it succeeds but addToCrate then throws, the crate DOES exist
 * server-side even though this file was never added to it — the cache is
 * already stale at that point, so it is invalidated here too (lazily; the
 * next open refetches), and the status message says so explicitly. A user
 * who only sees "could not add" and retries by re-typing the same name
 * would mint a second crate via createCrate's own auto-suffix ("name (2)")
 * instead of reusing the one that already exists — the message steers them
 * to the picker list instead.
 */
document.addEventListener('submit', (e) => {
  const form = (e.target as Element).closest?.('form.cratepick-new')
  if (!(form instanceof HTMLFormElement)) return
  const details = form.closest('details.cratepick')
  const fileId = details instanceof HTMLElement ? details.dataset.fileId : undefined
  const input = form.querySelector('input[name="name"]')
  if (!fileId || !(input instanceof HTMLInputElement)) return
  e.preventDefault()

  const name = input.value.trim()
  if (name === '') return
  const submit = form.querySelector('button[type="submit"]')
  if (submit instanceof HTMLButtonElement) submit.disabled = true

  void (async () => {
    let crateId: string
    try {
      crateId = await createCrate(name)
    } catch (err) {
      if (label) {
        label.textContent = err instanceof SessionExpiredError
          ? 'Session ended — reload to sign in.'
          : err instanceof Error ? err.message : 'Could not create crate.'
      }
      if (submit instanceof HTMLButtonElement) submit.disabled = false
      return
    }

    try {
      await addToCrate(crateId, fileId)
      if (label) label.textContent = `added to ${name}`
      input.value = ''
      if (details instanceof HTMLDetailsElement) details.open = false
      invalidateCratePickerCache()
      void loadCrateList().then(populateCratePickers)
    } catch (err) {
      invalidateCratePickerCache()
      if (label) {
        label.textContent = err instanceof SessionExpiredError
          ? 'Session ended — reload to sign in.'
          : `"${name}" was created, but adding the track failed — pick it from the list to retry`
      }
    } finally {
      if (submit instanceof HTMLButtonElement) submit.disabled = false
    }
  })()
})

/**
 * Player-resume, restore half. Runs once, at script init. Populates the
 * bar and seeks to the saved position but never calls `play()` — a page
 * load is not the user asking to hear audio, so autoplay would be a
 * surprise (and browsers block unmuted autoplay without a user gesture
 * anyway).
 *
 * `audio.preload` is "none" (Shell.astro), which — per spec — defers even
 * the metadata fetch until `load()` or `play()` is explicitly called;
 * setting `.src` alone is not enough. The explicit `audio.load()` below is
 * what still gets elapsed/total on screen without starting playback.
 */
async function restorePlayer() {
  if (audio === null) return
  let raw: string | null = null
  try {
    raw = localStorage.getItem(PLAYER_MEMORY_KEY)
  } catch {
    return
  }
  const entry = parseEntry(raw)
  if (entry === null) return
  if (isStale(entry)) {
    clearPlayerMemory()
    return
  }
  // Nothing else has claimed the transport yet (see currentFileId's own
  // doc comment) — the ordinary case, since this runs synchronously at
  // script init, before any click is even possible.
  if (currentFileId !== null) return

  const res = await fetch(`/api/track/${entry.file_id}/source`, {
    headers: { accept: 'application/json' },
  })
  // Re-check after the await: a click may have landed while this fetch was
  // in flight, and a deliberate click always outranks a silent restore.
  if (currentFileId !== null) return
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    // Signed out — the route redirected instead of answering JSON.
    clearPlayerMemory()
    return
  }
  const body = (await res.json()) as { url?: string }
  if (!res.ok || !body.url) {
    // Deleted / no longer visible / not yet available — nothing to resume.
    clearPlayerMemory()
    return
  }

  currentFileId = entry.file_id
  currentTitle = entry.title
  if (label) label.textContent = entry.title
  audio.addEventListener('loadedmetadata', () => {
    audio.currentTime = entry.position_s
    updateTime()
    updateSeekRange()
  }, { once: true })
  audio.src = body.url
  audio.load()
}
void restorePlayer()

const autosubmit = debounce((form: HTMLFormElement) => form.requestSubmit(), 300)
document.addEventListener('input', (e) => {
  const el = e.target
  if (el instanceof HTMLInputElement && el.name === 'q'
      && el.form?.hasAttribute('data-autosubmit')) autosubmit(el.form)
})
