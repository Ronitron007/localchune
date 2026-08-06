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
import { fetchCandidates } from '../lib/queue-candidates'
import {
  confirmMessage, reduce, regenerate, requiresClearConfirm,
  type CandidatePort, type QueueEvent, type ReduceResult,
} from '../lib/queue-engine'
import { assembleQueue, slotsFor, type QueueEntry } from '../lib/queue-model'
import { QUEUE_MEMORY_KEY, getState, serializeState, setState } from '../lib/queue-store'
import {
  appendReport, nextSourceLookahead, readListContext, toCrateTrack, toQueueEntry,
  truncationLine, type QueueRowData,
} from '../lib/queue-view'

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

/**
 * Presigned GETs live GET_TTL_SECONDS (1 h). A player parked across a
 * lunch break, a laptop sleep, or a long tab-hoard wakes up with a DEAD
 * src, and `play()` rejects — the "That track would not play" the owner
 * hit constantly. The fix is to treat a source failure as a refresh
 * trigger, not an error: fetch a fresh signed URL for currentFileId, seek
 * back to where the transport stood, resume if we were resuming. Only a
 * failure of the FRESH url earns the error message. One attempt per
 * failure — `refreshing` stops an expired-session loop.
 *
 * M6b: the result is a THREE-valued thing, not a boolean, and the third value
 * is load-bearing. §5 says a failed *refresh* is what fires `TRACK_FAILED` —
 * never a first `error` event, which still goes to this function alone. A
 * plain `false` could not tell "I tried a fresh URL and it was dead" (the
 * track really is unplayable; strike it and advance) apart from "another
 * refresh was already in flight, so I did nothing" (`busy` — the other call
 * owns the outcome). Reporting the second as a failure would skip a track for
 * the crime of having two `error` events, which is exactly the loop the
 * `refreshing` guard exists to prevent.
 */
type RefreshResult = 'ok' | 'failed' | 'busy'

let refreshing = false
async function refreshSource(resumeAt: number, thenPlay: boolean): Promise<RefreshResult> {
  if (audio === null || currentFileId === null || refreshing) return 'busy'
  refreshing = true
  try {
    const res = await fetch(`/api/track/${currentFileId}/source`, {
      headers: { accept: 'application/json' },
    })
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (label) label.textContent = 'Session ended — reload to sign in.'
      // A dead session is not a dead TRACK. Striking it would poison `failed`
      // for a file that plays perfectly once the member signs back in.
      return 'busy'
    }
    const body = (await res.json()) as { url?: string }
    if (!res.ok || !body.url) return 'failed'
    audio.addEventListener('loadedmetadata', () => {
      if (resumeAt > 0) audio.currentTime = resumeAt
      updateTime()
      updateSeekRange()
    }, { once: true })
    audio.src = body.url
    audio.load()
    if (thenPlay) await audio.play()
    return 'ok'
  } catch {
    return 'failed'
  } finally {
    refreshing = false
  }
}

/* ==================================================================
 * M6b — THE QUEUE, WIRED.
 *
 * Everything below is the DOM half of one engine. The decisions live in
 * src/lib/queue-*.ts (pure, node-tested); this file scrapes `dataset`, calls
 * `reduce`, and drives the one persisted <audio> element. Nothing here builds
 * a play order of its own — that is the owner's "one queue engine", enforced
 * by there being exactly one call to `reduce` in the whole client (`apply`).
 * ================================================================== */

/**
 * THE LAST ASSEMBLED QUEUE — the sharpest edge in this wiring.
 *
 * `reduce` resolves `SKIP`, `TRACK_ENDED`, `TRACK_FAILED`,
 * `SELECT_QUEUE_ENTRY` and `REMOVE_QUEUE_ENTRY` against an index into THE
 * ARRAY THE USER WAS LOOKING AT — which includes the auto tail, and the auto
 * tail is not in `QueueState`. Hand the reducer a stale array and it advances
 * to the wrong track, with no error anywhere: the wrong song simply plays.
 *
 * So this variable has ONE WRITER, `setRenderedQueue`, and every event source
 * reads it rather than re-deriving an array of its own. It is updated
 * SYNCHRONOUSLY on every state change (carrying the previous auto tail
 * forward through `assembleQueue`, which re-filters exclusions and re-applies
 * the cap, so consumed entries drop out by themselves) and then refined when
 * the async regeneration lands. There is deliberately no moment between an
 * event and its successor where this array describes a state that has already
 * been replaced.
 */
let renderedQueue: QueueEntry[] = []

/** Layer 2 as last computed, carried across a synchronous re-assembly so a
 *  SKIP that lands before the next regeneration still knows what is next. */
let autoTail: QueueEntry[] = []

/** Monotonic regeneration ticket. Two events in quick succession start two
 *  regenerations; the older one may resolve LAST and would otherwise install
 *  a tail computed from a state two events out of date. Same supersession
 *  semantics as PR #29's AbortError rule — a superseded result is not an
 *  error, it is simply discarded. */
let regenSeq = 0

/** Why the last regeneration produced no tail, or null. `regenerate` swallows
 *  a port failure ON PURPOSE (a dead network must never take the transport
 *  down with it) and returns a tail-less queue with no exception, so if this
 *  is not captured at the call site the signal does not exist anywhere. The
 *  drawer renders it. */
let candidateError: string | null = null

/** What the last replacing play or append actually took, for the drawer's
 *  `warehouse · 24 of 60` line. Cleared by anything that clears layer 1. */
let lastTruncation: { label: string | null; added: number; offered: number } | null = null

function saveQueueMemory() {
  try {
    localStorage.setItem(QUEUE_MEMORY_KEY, serializeState(getState()))
  } catch {
    // Storage disabled or full. A queue is a thirty-minute artefact; losing
    // one costs a member nothing they will notice.
  }
}

/**
 * The engine's candidate fetch, plus the error capture `regenerate` cannot do
 * for us. A dead session is reported immediately through the same status
 * region every other handler uses; anything else is left for the drawer,
 * because "the harmonic tail is missing" is not worth stepping on the track
 * name for.
 */
const candidatePort: CandidatePort = async (seed, need) => {
  try {
    const out = await fetchCandidates(seed, need)
    candidateError = null
    return out
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      candidateError = 'Session ended — reload to sign in.'
      if (label) label.textContent = candidateError
    } else {
      candidateError = 'Could not reach the pool — no auto tail.'
    }
    throw err
  }
}

/** THE ONLY WRITER of `renderedQueue`. Task 7 hangs the drawer render here. */
function setRenderedQueue(next: readonly QueueEntry[]): void {
  renderedQueue = [...next]
  autoTail = renderedQueue.filter((e) => e.origin === 'auto')
  // The prefetched URL belongs to whatever WAS next. If that changed, drop it
  // rather than start the wrong track instantly.
  if ((renderedQueue[1]?.file_id ?? null) !== lookaheadId) clearLookahead()
}

/**
 * THE ONE CALL TO `reduce` IN THE CLIENT. Every surface routes through here:
 * reduce, store, persist, re-assemble synchronously, then regenerate.
 */
function apply(event: QueueEvent): ReduceResult {
  const result = reduce(getState(), event)
  setState(result.state)
  saveQueueMemory()
  setRenderedQueue(assembleQueue(result.state, autoTail))
  void hydrateTail()
  return result
}

async function hydrateTail(): Promise<void> {
  const seq = ++regenSeq
  const next = await regenerate(getState(), candidatePort)
  if (seq !== regenSeq) return // superseded by a newer event — discard.
  setRenderedQueue(next)
}

// ---------------------------------------------------------- the transport

/** Matches TrackRow.astro's own `data-label` convention, so a queued track
 *  and a clicked one read identically in the status region. */
const entryLabel = (e: QueueEntry): string =>
  e.display_artist === null || e.display_artist === ''
    ? e.display_title
    : `${e.display_artist} — ${e.display_title}`

/**
 * Claim the transport for whatever `current` now is. SYNCHRONOUS, and it has
 * to stay that way: `currentFileId` claimed before any fetch is what lets a
 * click beat an in-flight restore (see that variable's own comment, and
 * restorePlayer()'s re-check).
 */
function claimCurrent(): QueueEntry | null {
  const entry = getState().current
  if (entry === null) return null
  currentFileId = entry.file_id
  currentTitle = entryLabel(entry)
  return entry
}

/**
 * One signed URL. `report` is false for the lookahead prefetch — a failed
 * prefetch is invisible by design; the real fetch on advance reports for it.
 * The try/catch is new relative to M6a's inline version: a dropped connection
 * used to reject inside a floating promise with nothing to catch it.
 */
async function fetchSourceUrl(fileId: string, report: boolean): Promise<string | null> {
  try {
    const res = await fetch(`/api/track/${fileId}/source`, {
      headers: { accept: 'application/json' },
    })
    // Non-JSON means middleware redirected to /login — say so, do not parse.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (report && label) label.textContent = 'Session ended — reload to sign in.'
      return null
    }
    const body = (await res.json()) as { url?: string; message?: string; error?: string }
    if (!res.ok || !body.url) {
      if (report && label) label.textContent = body.message ?? body.error ?? 'could not load that track'
      return null
    }
    return body.url
  } catch {
    if (report && label) label.textContent = 'could not load that track'
    return null
  }
}

/** One lookahead URL, at most, for exactly one file id. */
let lookaheadId: string | null = null
let lookaheadUrl: string | null = null

function clearLookahead(): void {
  lookaheadId = null
  lookaheadUrl = null
}

function takeLookahead(fileId: string): string | null {
  if (lookaheadId !== fileId || lookaheadUrl === null) return null
  const url = lookaheadUrl
  clearLookahead()
  return url
}

/**
 * §5's small, deliberate lookahead. At T-20 s the NEXT entry's signed URL is
 * fetched into a module variable so the advance is instant instead of a round
 * trip between tracks. A URL held for twenty seconds cannot meaningfully
 * expire. `lookaheadId` is what makes the pure band predicate fire once
 * instead of on every tick, and `setRenderedQueue` drops it the moment a
 * regeneration changes what is next.
 */
function maybePrefetchNext(): void {
  if (audio === null) return
  const next = renderedQueue[1]
  if (next === undefined || lookaheadId === next.file_id) return
  if (!nextSourceLookahead(audio.currentTime, audio.duration)) return
  lookaheadId = next.file_id
  lookaheadUrl = null
  void (async () => {
    const url = await fetchSourceUrl(next.file_id, false)
    if (lookaheadId === next.file_id) lookaheadUrl = url
  })()
}

/**
 * Load and play whatever the transport is currently claimed for. Every path
 * that starts audio goes through here, which is what makes "a play is a play"
 * (§2.2) true structurally: `playMeter.reset()` lives on this line, so an
 * autoplayed track arms the 30 s meter exactly as a clicked one does. Before
 * M6b the reset sat in the play-link handler alone and a queued track could
 * never have counted.
 */
async function startCurrent(startAt: number): Promise<void> {
  if (audio === null || currentFileId === null) return
  const fileId = currentFileId
  const url = takeLookahead(fileId) ?? (await fetchSourceUrl(fileId, true))
  if (url === null) return
  // A newer claim landed while the URL was in flight — that click outranks
  // this load, exactly as it outranks a restore.
  if (currentFileId !== fileId) return

  audio.src = url
  playMeter.reset()
  // §1.2: a play truncated by the cap "says so once". The track name is the
  // ordinary content of this region; the count rides along after it rather
  // than replacing it, so nobody has to choose between knowing what is
  // playing and knowing that 36 tracks did not fit.
  if (label) {
    label.textContent = lastTruncation === null
      ? currentTitle
      : `${currentTitle} · ${truncationLine(lastTruncation)}`
  }
  // M4 Task 7 — /review's A/B audition opens at the point of maximum
  // divergence. Only that page renders data-start; `once` matters, or a later
  // seek would be yanked back here on the next metadata event.
  if (Number.isFinite(startAt) && startAt > 0) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt }, { once: true })
  }
  // Clear the previous track's clock and scrubber rather than leaving them on
  // screen until the new track's first timeupdate.
  if (time) time.textContent = `${formatDuration(0)} / --:--`
  if (seek) { seek.value = '0'; seek.max = '0' }
  // §5: "clearPlayerMemory() on ended must become save the new current".
  // audio.currentTime is 0 here — assigning .src resets it — so this records
  // the new track at position zero rather than the old track's offset.
  savePlayerMemory()

  await audio.play().catch((err: unknown) => {
    // AbortError = a NEWER load superseded this play(). Playback of the newer
    // track is fine; surfacing it was the "sometimes it fails" noise (PR #29).
    if (err instanceof DOMException && err.name === 'AbortError') return
    if (label) label.textContent = 'That track would not play. Try downloading it.'
  })
}

/**
 * The advance path — `SKIP`, `TRACK_ENDED`, `TRACK_FAILED`,
 * `SELECT_QUEUE_ENTRY`. One place, because every one of them ends the same
 * way: a new `current`, or none at all.
 *
 * BEHAVIOURAL CHANGE, CALLED OUT BECAUSE IT IS ONE (§5). `ended` used to fire
 * `clearPlayerMemory()` unconditionally. With a queue that would forget the
 * queue the moment a track finished, so memory is now SAVED for the new
 * current track and cleared only when the queue is genuinely exhausted —
 * which, with the default `method: 'off'`, is the ordinary end of a session.
 */
function handleAdvance(event: QueueEvent): void {
  const before = getState().current
  apply(event)
  const after = getState().current

  if (after === null) {
    // Exhausted. Playback stops — the documented consequence of opt-in
    // autoplay, not a failure.
    currentFileId = null
    currentTitle = ''
    clearLookahead()
    clearPlayerMemory()
    if (label) label.textContent = 'Queue finished.'
    updateToggle()
    return
  }
  // A no-op event (an out-of-range index) leaves `current` where it was. Do
  // not reload the track the member is already listening to.
  if (before !== null && before.file_id === after.file_id) return
  claimCurrent()
  void startCurrent(0)
}

// ------------------------------------------------------------- DOM reads

/** The `[data-queue-list]` container a control sits in — the pool table's
 *  tbody, or a crate's. A play link outside any container (the track page,
 *  /review) has no list, plays alone, and queues nothing. */
function listContainerOf(el: Element): HTMLElement | null {
  const c = el.closest('[data-queue-list]')
  return c instanceof HTMLElement ? c : null
}

/** Every queueable row in a container, in rendered order — which IS play
 *  order, so a sort click or a filter changes the queue a play would build,
 *  exactly as a member would expect. */
function scrapeRows(container: HTMLElement): QueueRowData[] {
  return Array.from(container.querySelectorAll<HTMLElement>('a.play[data-track-id]')).map((a) => ({
    file_id: a.dataset.trackId ?? '',
    artist: a.dataset.artist ?? null,
    title: a.dataset.title ?? '',
    duration_ms: a.dataset.duration ?? null,
    bpm: a.dataset.bpm ?? null,
    key_camelot: a.dataset.key ?? null,
  }))
}

/** One control's own metadata — a `+Q` button, or a play link with no list. */
function scrapeOne(el: HTMLElement, fileId: string): QueueRowData {
  return {
    file_id: fileId,
    artist: el.dataset.artist ?? null,
    title: el.dataset.title ?? '',
    duration_ms: el.dataset.duration ?? null,
    bpm: el.dataset.bpm ?? null,
    key_camelot: el.dataset.key ?? null,
  }
}

/**
 * A crate's tracks, for the `+ QUEUE` button on a card — the one surface with
 * no rows of its own to read. Cached per crate for the life of the document,
 * the same idiom (and the same `astro:after-swap` invalidation) as
 * `loadCrateList()`: a soft navigation can bring a crate whose contents
 * changed on another page.
 */
const crateTracksCache = new Map<string, Promise<QueueRowData[]>>()

function loadCrateTracks(crateId: string): Promise<QueueRowData[]> {
  const hit = crateTracksCache.get(crateId)
  if (hit !== undefined) return hit
  const p = fetch(`/api/crate/${crateId}/tracks`, { headers: { accept: 'application/json' } })
    .then((res) => {
      const type = res.headers.get('content-type') ?? ''
      // Content-type first: middleware redirects a dead session to /login and
      // fetch() follows it, so a lost session arrives as 200 text/html.
      if (!res.ok || !type.includes('application/json')) throw new SessionExpiredError()
      return res.json() as Promise<{ tracks?: Record<string, unknown>[] }>
    })
    .then((body) => (body.tracks ?? []).map(toCrateTrack))
  crateTracksCache.set(crateId, p)
  // A rejected promise must not be cached, or one dropped connection makes
  // the button dead for the life of the document.
  void p.catch(() => crateTracksCache.delete(crateId))
  return p
}

document.addEventListener('astro:after-swap', () => {
  crateTracksCache.clear()
})

if (audio && toggle) {
  toggle.addEventListener('click', () => {
    if (audio.paused) {
      void audio.play().catch(async (err: unknown) => {
        // Same AbortError rule as the play-link handler: superseded, not broken.
        if (err instanceof DOMException && err.name === 'AbortError') return
        // Deliberately NOT a TRACK_FAILED path. The member just pressed play
        // on this track; skipping to another one under their finger is the
        // wrong answer to "that would not play". §5 puts TRACK_FAILED on the
        // mid-play `error` route alone.
        const recovered = (await refreshSource(audio.currentTime, true)) === 'ok'
        if (!recovered && label && currentFileId === null) {
          label.textContent = 'Nothing to play yet.'
        } else if (!recovered && label) {
          label.textContent = 'That track would not play. Try downloading it.'
        }
      })
    } else {
      audio.pause()
    }
  })
  audio.addEventListener('play', updateToggle)
  audio.addEventListener('pause', updateToggle)
  audio.addEventListener('ended', updateToggle)
  // Mid-play source death (URL expired during a long listen, network cut
  // on sleep/wake): recover in place at the last transport position. The
  // seek range is the survivor — audio.currentTime can already be reset to
  // 0 by the time 'error' fires.
  audio.addEventListener('error', () => {
    const wasPlaying = !audio.paused && !audio.ended
    const at = seek ? Number(seek.value) : 0
    void (async () => {
      const result = await refreshSource(Number.isFinite(at) ? at : 0, wasPlaying)
      // §5, exactly: a failed REFRESH fires TRACK_FAILED, never a first
      // `error`. 'busy' means another refresh owns the outcome (or the
      // session died) — no strike, no skip, no second path around the
      // `refreshing` guard.
      if (result !== 'failed' || currentFileId === null) return
      handleAdvance({ type: 'TRACK_FAILED', file_id: currentFileId, queue: renderedQueue })
    })()
  })
  // Player-resume: a pause is a deliberate "I might come back to this"
  // moment, worth a save even before the next ~1 Hz timeupdate tick would
  // have caught it.
  audio.addEventListener('pause', savePlayerMemory)
  /**
   * M6b — THE ADVANCE. `ended` used to clear player memory outright; it now
   * runs the engine, and `handleAdvance` saves the NEW current instead (§5).
   * With the default `method: 'off'` and an empty layer 1 there is no
   * `queue[1]`, `current` becomes null and playback stops — the ordinary case
   * for opt-in autoplay, not an edge.
   */
  audio.addEventListener('ended', () => {
    if (getState().current === null) {
      // Nothing ever went through the engine (a restore that only loaded a
      // src, say) — keep M6a's behaviour exactly.
      clearPlayerMemory()
      return
    }
    handleAdvance({ type: 'TRACK_ENDED', queue: renderedQueue })
  })
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
    maybePrefetchNext()
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

/*
 * CAPTURE PHASE, here and on every delegation below that preventDefaults:
 * ClientRouter's module loads before this one, so its document-level
 * bubble listeners registered first and would run first — intercepting
 * the same clicks/submits (double POST, then a swap to the form's action
 * URL: the production "♥ → 404" bug, 2026-07-31). ClientRouter skips
 * events whose defaultPrevented is already set, and capture listeners run
 * before all bubble listeners — so capture + preventDefault is the whole
 * fix. Plain management forms opt out declaratively with
 * data-astro-reload instead (see crate/[id].astro).
 */
/**
 * M6b — the play link now dispatches PLAY_TRACK instead of claiming the
 * transport itself. Three things happen in a strict order, and the order is
 * the whole design:
 *
 *  1. `preventDefault` (capture phase — see the block comment above).
 *  2. THE PROMPT, if layer 1 is non-empty. `confirm()` BLOCKS, so it must run
 *     before the claim and before any fetch: a cancel has to leave the state
 *     byte-for-byte unchanged — no claim, no history push, no request (§1.5).
 *     Native confirm() called from this bundle, never an inline handler
 *     attribute: Cloudflare's API WAF challenges a Worker upload whose bundle
 *     contains one, and the deploy POST 403s with an HTML challenge page.
 *     The `data-confirm` ATTRIBUTE form cannot serve here — it is
 *     unconditional and form-only, and this prompt fires only when there is
 *     something to lose.
 *  3. `apply` + claim + start, all synchronous up to the fetch.
 *
 * A SUPPRESSED DIALOG READS AS CANCEL. After several rapid prompts a browser
 * offers "prevent this page from creating additional dialogs", and a
 * suppressed confirm() returns false — the play then does nothing, which is
 * safe but could look broken. The drawer's CLEAR button is the always-
 * available manual path (clear, then play, no prompt).
 */
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a.play[data-track-id]')
  if (!(a instanceof HTMLAnchorElement) || audio === null) return
  e.preventDefault()
  const trackId = a.dataset.trackId
  if (trackId === undefined) return

  // The list this play means: the rest of THIS container, in rendered order.
  // Outside a [data-queue-list] (the track page, /review) it is the clicked
  // track alone — play it, queue nothing.
  const container = listContainerOf(a)
  const ctx = container === null
    ? readListContext([scrapeOne(a, trackId)], trackId, null)
    : readListContext(scrapeRows(container), trackId, container.dataset.queueList ?? null)
  const event: QueueEvent = ctx.index < 0
    // A row that is not in its own container (a stale DOM after a swap) still
    // has to play. One-entry list, index 0, no intent.
    ? { type: 'PLAY_TRACK', file_id: trackId, list: [toQueueEntry(scrapeOne(a, trackId), 'list', ctx.source_label)], index: 0, source_label: ctx.source_label }
    : { type: 'PLAY_TRACK', file_id: trackId, list: ctx.list, index: ctx.index, source_label: ctx.source_label }

  if (requiresClearConfirm(getState(), event)
      && !window.confirm(confirmMessage(getState(), event))) return

  const result = apply(event)
  // Claimed synchronously, before the fetch even starts — this is what lets a
  // click always win a race against an in-flight restore (see currentFileId's
  // own comment and restorePlayer()'s re-check).
  claimCurrent()
  noteTruncation(result, ctx.source_label)
  // Only /review renders data-start (the A/B audition opens at the point of
  // maximum divergence, PRD §6); every other play link omits it.
  void startCurrent(Number(a.dataset.start ?? 0))
}, true)

/** The drawer's `warehouse · 24 of 60` line, remembered from whichever write
 *  last truncated. Null when the whole list fit — there is nothing to say. */
function noteTruncation(result: ReduceResult, sourceLabel: string | null): void {
  const { added, offered } = result
  lastTruncation = added !== undefined && offered !== undefined && added < offered
    ? { label: sourceLabel, added, offered }
    : null
}

/**
 * M6b — `▶ PLAY` in a crate page header. PLAY_CRATE rather than PLAY_TRACK,
 * so every entry is stamped `origin: 'crate'` and the drawer can say where
 * the queue came from. The items are the rendered rows: the crate page has
 * them all in the DOM already, so this surface needs no fetch at all.
 */
document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.crateplay')
  if (!(btn instanceof HTMLButtonElement) || audio === null) return
  e.preventDefault()
  const container = document.querySelector('[data-queue-list]')
  if (!(container instanceof HTMLElement)) return
  const sourceLabel = btn.dataset.crateName ?? container.dataset.queueList ?? null
  const items = scrapeRows(container).map((r) => toQueueEntry(r, 'crate', sourceLabel))
  if (items.length === 0) return

  const event: QueueEvent = {
    type: 'PLAY_CRATE', crate_id: btn.dataset.crateId ?? '', items, start: 0, source_label: sourceLabel,
  }
  if (requiresClearConfirm(getState(), event)
      && !window.confirm(confirmMessage(getState(), event))) return

  const result = apply(event)
  claimCurrent()
  noteTruncation(result, sourceLabel)
  void startCurrent(0)
}, true)

/**
 * M6b — `+ queue`, three surfaces, ONE delegation. A track row's `+Q` carries
 * its own metadata; a crate card's `+ QUEUE` carries a crate id and fetches
 * the tracks once. Both end in the same ADD_TO_QUEUE.
 *
 * EVERY APPEND REPORTS, and a truncated one reports what it dropped: §1.2's
 * `added 4 of 17 from warehouse — queue is full (25)`. Silent partial success
 * is the failure mode the 25 cap would otherwise introduce, so the count goes
 * into `#player-label` — the same status region the play, like and crate
 * handlers already use.
 */
document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.queueadd')
  if (!(btn instanceof HTMLButtonElement)) return
  e.preventDefault()

  const crateId = btn.dataset.crateId
  const fileId = btn.dataset.fileId
  if (crateId === undefined && fileId === undefined) return

  btn.disabled = true
  void (async () => {
    try {
      let entries: QueueEntry[]
      let sourceLabel: string | null
      if (crateId !== undefined) {
        sourceLabel = btn.dataset.crateName ?? 'crate'
        entries = (await loadCrateTracks(crateId)).map((r) => toQueueEntry(r, 'crate', sourceLabel))
      } else {
        const container = listContainerOf(btn)
        sourceLabel = container?.dataset.queueList ?? null
        entries = [toQueueEntry(scrapeOne(btn, fileId as string), 'add', sourceLabel)]
      }

      const result = apply({ type: 'ADD_TO_QUEUE', entries })
      // WHY THE APPEND FELL SHORT, and it matters: an `added: 0` because the
      // track was already queued is not an `added: 0` because the queue is
      // full, and telling a member the queue is full when it has room is a
      // lie they cannot act on. `need === 0` afterwards means layer 1 now
      // fills every slot — the cap really is what stopped it.
      noteTruncation(result, sourceLabel)
      if (label) {
        label.textContent = appendReport({
          added: result.added ?? 0,
          offered: result.offered ?? entries.length,
          label: sourceLabel,
          full: slotsFor(getState()).need === 0,
        })
      }
    } catch (err) {
      if (label) {
        label.textContent = err instanceof SessionExpiredError
          ? 'Session ended — reload to sign in.'
          : 'Could not add to the queue.'
      }
    } finally {
      btn.disabled = false
    }
  })()
})

/**
 * The queue's controls are `hidden` in the markup and unhidden here, because
 * a button that would do nothing without JS must not be visible without JS —
 * the queue is client state with no server endpoint to fall back to. Re-run
 * on every ClientRouter swap: a swapped-in page body brings its own hidden
 * buttons, and `<script src>` modules are evaluated once per document, never
 * again on a soft navigation.
 */
function revealQueueControls(): void {
  document.querySelectorAll<HTMLElement>('button.queueadd[hidden], button.crateplay[hidden]')
    .forEach((el) => { el.hidden = false })
}
revealQueueControls()
document.addEventListener('astro:after-swap', revealQueueControls)

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
}, true)

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
}, true)

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
}, true)

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
