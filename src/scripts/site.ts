// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'
import { formatDuration } from '../lib/format'
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
let currentFileId: string | null = null
let currentTitle = ''

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
