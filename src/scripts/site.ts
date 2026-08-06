// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'
import { formatDuration } from '../lib/format'
import { renderGlyph, type IconName } from '../lib/icons'
import {
  classifyGesture, exitDelayMs, nextFocusIndex, normalizeRows, shouldDismiss,
  velocityPxPerMs, type SheetRow, type SheetRowInput,
} from '../lib/sheet'
import {
  addToCrate, createCrate, DuplicateCrateItemError, SessionExpiredError, toggleLike,
} from '../lib/org-api'
import { createPlayMeter } from '../lib/play-meter'
import { artThumbUrl } from '../lib/track-format'
import { PLAYER_MEMORY_KEY, isStale, makeEntry, parseEntry, serializeEntry } from '../lib/player-memory'
import { fetchCandidates } from '../lib/queue-candidates'
import {
  confirmMessage, reduce, regenerate, requiresClearConfirm,
  type CandidatePort, type QueueEvent, type ReduceResult,
} from '../lib/queue-engine'
import {
  AUTO_METHODS, METHOD_LABELS, assembleQueue, isAutoMethod, slotsFor, type QueueEntry,
} from '../lib/queue-model'
import {
  QUEUE_MEMORY_KEY, getState, restoredState, serializeState, setState,
} from '../lib/queue-store'
import {
  appendReport, entryTitle, nextSourceLookahead, readListContext, renderQueueSections,
  resumedEntry, toQueueEntry, truncationFor, truncationLine, type QueueRowData,
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
const nextBtn = document.getElementById('player-next') as HTMLButtonElement | null
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

/** THE ONLY WRITER of `renderedQueue`, and therefore the one place the drawer
 *  is ever re-rendered from. */
function setRenderedQueue(next: readonly QueueEntry[]): void {
  renderedQueue = [...next]
  autoTail = renderedQueue.filter((e) => e.origin === 'auto')
  // The prefetched URL belongs to whatever WAS next. If that changed, drop it
  // rather than start the wrong track instantly.
  if ((renderedQueue[1]?.file_id ?? null) !== lookaheadId) clearLookahead()
  renderDrawer()
}

/**
 * THE ONE CALL TO `reduce` IN THE CLIENT. Every surface routes through here:
 * reduce, store, persist, re-assemble synchronously, then regenerate.
 *
 * `hydrate` is false for exactly one caller, the UX.9 resume (see
 * `restorePlayer`). §5 defers layer 2 to the first of (drawer opened |
 * playback started), and a restore is neither — regenerating here would put a
 * pool_list call on every returning member's first paint for a drawer they may
 * never open. The flag is a parameter rather than a second function because
 * "there is exactly one call to `reduce`" is the invariant queue-wiring.test.ts
 * exists to keep, and a second path would end that.
 */
function apply(event: QueueEvent, hydrate = true): ReduceResult {
  const result = reduce(getState(), event)
  setState(result.state)
  saveQueueMemory()
  setRenderedQueue(assembleQueue(result.state, autoTail))
  if (hydrate) void hydrateTail()
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
  updateMediaSession()
  // §5's other hydration trigger: playback started.
  hydrateIfDeferred()

  await audio.play().catch((err: unknown) => {
    // AbortError = a NEWER load superseded this play(). Playback of the newer
    // track is fine; surfacing it was the "sometimes it fails" noise (PR #29).
    if (err instanceof DOMException && err.name === 'AbortError') return
    if (label) label.textContent = 'That track would not play. Try downloading it.'
  })
}

/* ---------------------------------------------- Media Session (Task 8)
 *
 * The lock screen, the notification shade, the macOS Now Playing widget and a
 * headset's middle button all read the same API. FEATURE-DETECTED AND NEVER
 * THROWING: `navigator.mediaSession` is absent in some older WebKit contexts,
 * and `setActionHandler` throws on an action name a browser does not know, so
 * every call is guarded and every failure is silent. There is no fallback to
 * build — the page still works, it just does not decorate the lock screen.
 */
type MediaNavigator = Navigator & { mediaSession?: MediaSession }

function updateMediaSession(): void {
  const ms = (navigator as MediaNavigator).mediaSession
  if (ms === undefined) return
  const entry = getState().current
  try {
    if (entry === null) {
      ms.metadata = null
      ms.playbackState = 'none'
      return
    }
    ms.metadata = new MediaMetadata({
      title: entry.display_title,
      artist: entry.display_artist ?? '',
      // The PUBLIC art bucket — no signing, already cacheable, and unlike the
      // audio URL it does not expire. A QueueEntry carries no `has_thumb`, so
      // this is emitted unconditionally: a 404 costs one request and the OS
      // simply shows no art, which is exactly what it would show anyway.
      artwork: [{
        src: artThumbUrl(import.meta.env.PUBLIC_ART_BASE_URL, entry.file_id),
        sizes: '256x256',
        type: 'image/jpeg',
      }],
    })
    ms.playbackState = audio !== null && !audio.paused ? 'playing' : 'paused'
  } catch {
    // An unsupported MediaMetadata shape must never take the transport down.
  }
}

function initMediaSession(): void {
  const ms = (navigator as MediaNavigator).mediaSession
  if (ms === undefined || audio === null) return
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, handler)
    } catch {
      // Older WebKit throws on an action name it does not implement.
    }
  }
  set('play', () => { void audio.play().catch(() => {}) })
  set('pause', () => { audio.pause() })
  // THE SAME FUNCTION the ⏭ button calls. A lock screen and a button that
  // "skip" differently is two behaviours to keep in step; this is one.
  set('nexttrack', skipToNext)
  // EXPLICITLY UNSET in v1. There is no PREV event in the engine — `history`
  // is the field that makes one possible later, and it is already recorded on
  // every advance. Leaving the handler null is what makes the OS grey the
  // button out instead of showing a control that does nothing.
  set('previoustrack', null)
  audio.addEventListener('play', updateMediaSession)
  audio.addEventListener('pause', updateMediaSession)
}
initMediaSession()

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
    updateMediaSession()
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

/**
 * SKIP, from wherever it is asked for. THE ONE DISPATCH SITE, shared by the ⏭
 * button in the player bar and by the lock screen's next control — two
 * surfaces, one behaviour, and queue-wiring.test.ts keeps it that way.
 *
 * The `current === null` guard is not defensive noise: `reduce` no-ops a SKIP
 * with nothing playing anyway, but returning early here also keeps
 * `handleAdvance` from reporting "Queue finished." at a member who never
 * started anything. What it must NOT be is the reason a resumed track cannot
 * be skipped — that was the bug, and it is fixed upstream by RESTORE_CURRENT
 * rather than by loosening this line.
 */
function skipToNext(): void {
  if (getState().current === null) return
  handleAdvance({ type: 'SKIP', queue: renderedQueue })
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
      return res.json() as Promise<{ tracks?: QueueRowData[] }>
    })
    // NO SECOND PROJECTION. The route already ran `toCrateTrack`, so the wire
    // shape IS QueueRowData — `{file_id, artist, title, ...}`. Running it
    // again here read `display_title` off an object that carries `title` and
    // queued six entries with blank names. Only the shape guard belongs on
    // this side; queue-wiring.test.ts keeps the projection out of this file.
    .then((body) => (body.tracks ?? []).filter(
      (t): t is QueueRowData => typeof t?.file_id === 'string' && t.file_id !== '',
    ))
  crateTracksCache.set(crateId, p)
  // A rejected promise must not be cached, or one dropped connection makes
  // the button dead for the life of the document.
  void p.catch(() => crateTracksCache.delete(crateId))
  return p
}

document.addEventListener('astro:after-swap', () => {
  crateTracksCache.clear()
})

/* ------------------------------------------------------ the queue drawer
 *
 * Shell.astro renders an EMPTY drawer inside the persisted player node; every
 * control below is built here. That is the UX.12 bundle rule applied again:
 * the shell mounts on every page, and an island would ship the engine, the
 * four strategies and the candidate client to /login for a drawer nobody
 * opened. Vanilla DOM, one render function, one delegation per control.
 *
 * NOT ONE OF THESE CONTROLS MUTATES AN ARRAY. Every one dispatches an engine
 * event against `renderedQueue` — the array the member is looking at — and the
 * re-render falls out of `setRenderedQueue`. "The queue is derived, not
 * mutated" has to be true in the UI layer too, or it is not true at all.
 */
const drawer = document.getElementById('queue-drawer')
const drawerToggle = document.getElementById('queue-toggle') as HTMLButtonElement | null
const drawerMethods = document.getElementById('queue-methods')
const drawerSections = document.getElementById('queue-sections')

/**
 * Lazy hydration (§5). The auto tail is not persisted and not recomputed at
 * page load: a 14-day-old harmonic tail is stale (the pool grew), and
 * recomputing it on first paint would put a pool_list call in front of every
 * returning member for a drawer they may never open.
 *
 * So a RESTORED queue with a method selected sets this, and the first of
 * (drawer opened | playback started) spends it. With the default `off`,
 * `restoredState` reports `needsHydration: false` and it is never set at all —
 * not one deferred request, zero.
 *
 * A fresh (non-restored) session needs no flag: every user action goes through
 * `apply`, which regenerates on its own.
 */
let queueNeedsHydration = false

function hydrateIfDeferred(): void {
  if (!queueNeedsHydration) return
  queueNeedsHydration = false
  void hydrateTail()
}

function button(cls: string, text: string, aria?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = text
  if (aria !== undefined) b.setAttribute('aria-label', aria)
  return b
}

/** The method selector — a segmented set of aria-pressed toggles in the
 *  `.likebtn` idiom, not action buttons, so they take no .btn class and no
 *  colour token. OFF is pressed on first load because OFF is the default. */
function renderMethods(): void {
  if (drawerMethods === null) return
  drawerMethods.textContent = ''
  const active = getState().method
  for (const method of AUTO_METHODS) {
    const b = button('queuemethod', METHOD_LABELS[method])
    b.dataset.method = method
    b.setAttribute('aria-pressed', String(method === active))
    drawerMethods.appendChild(b)
  }
}

function renderDrawer(): void {
  if (drawerSections === null) return
  renderMethods()
  drawerSections.textContent = ''

  const sections = renderQueueSections(renderedQueue, getState(), {
    truncation: lastTruncation,
    candidateError,
  })

  for (const section of sections) {
    const el = document.createElement('section')
    el.className = 'queuesection'
    el.dataset.section = section.id

    const h = document.createElement('h3')
    h.textContent = section.title
    el.appendChild(h)

    if (section.note !== null) {
      const p = document.createElement('p')
      p.className = 'explain'
      p.textContent = section.note
      el.appendChild(p)
    }

    if (section.rows.length > 0) {
      const list = document.createElement('ul')
      list.className = 'queuelist'
      for (const row of section.rows) {
        const li = document.createElement('li')
        li.className = section.id === 'now' ? 'queuerow queuerow-current' : 'queuerow'

        // The row itself is the play control. `data-index` is the drawer's
        // whole contract with the reducer: row 3 means renderedQueue[3].
        const play = button('queuerow-play', entryTitle(row.entry))
        play.dataset.index = String(row.index)
        play.disabled = section.id === 'now'
        li.appendChild(play)

        if (row.entry.source_label !== null) {
          const src = document.createElement('span')
          src.className = 'queuerow-src'
          src.textContent = row.entry.source_label
          li.appendChild(src)
        }

        if (row.removable) {
          const controls = document.createElement('span')
          controls.className = 'queuerow-controls'
          // ↑/↓ move a PIN. They are rendered for auto rows too and the engine
          // no-ops them there by design — layer 2 is re-ranked on every
          // regeneration, so it has no order anyone owns.
          for (const [dir, glyph] of [['up', '↑'], ['down', '↓']] as const) {
            const b = button('btn-secondary queuerow-move', glyph, `Move ${entryTitle(row.entry)} ${dir}`)
            b.dataset.index = String(row.index)
            b.dataset.dir = dir
            b.disabled = section.id === 'auto'
            controls.appendChild(b)
          }
          const rm = button('btn-secondary queuerow-remove', '✕', `Remove ${entryTitle(row.entry)} from the queue`)
          rm.dataset.index = String(row.index)
          controls.appendChild(rm)
          li.appendChild(controls)
        }

        list.appendChild(li)
      }
      el.appendChild(list)
    }
    drawerSections.appendChild(el)
  }

  syncDrawerHeight()
}

/**
 * The upload chip is fixed above the player bar and knows nothing about the
 * drawer, whose height is not a constant — it grows with the queue up to
 * 60vh. Measuring it here and writing --queue-height is what lets one CSS
 * rule (`body.queueopen .uploadchip-slot`) push the chip clear without a
 * third eyeballed number. No-op while the drawer is shut.
 */
/** `hidden` is no longer a plain boolean in lib.dom (it also takes
 *  `'until-found'`), so open-ness is read through one predicate rather than
 *  coerced at four call sites. */
const isDrawerOpen = (): boolean => drawer !== null && drawer.hidden === false

function syncDrawerHeight(): void {
  if (drawer === null) return
  document.body.style.setProperty(
    '--queue-height', isDrawerOpen() ? `${drawer.offsetHeight}px` : '0px')
}

function setDrawerOpen(open: boolean): void {
  if (drawer === null || drawerToggle === null) return
  drawer.hidden = !open
  drawerToggle.setAttribute('aria-expanded', String(open))
  document.body.classList.toggle('queueopen', open)
  syncDrawerHeight()
  // One of §5's two triggers for the deferred tail. The other is in
  // startCurrent — whichever happens first spends the flag.
  if (open) hydrateIfDeferred()
}

if (drawerToggle !== null) {
  drawerToggle.hidden = false
  drawerToggle.addEventListener('click', () => {
    setDrawerOpen(!isDrawerOpen())
  })
}

/** Unhidden here rather than in the markup, same rule as the drawer toggle
 *  above: with no JS there is no queue and nothing to skip to. */
if (nextBtn !== null) {
  nextBtn.hidden = false
  nextBtn.addEventListener('click', skipToNext)
}

/** Click a row: play it, and drop everything jumped over. §1.4 — "click the
 *  fourth track" must not mean "play the fourth track and then the two you
 *  just skipped", which is what holding them would produce. */
document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.queuerow-play')
  if (!(btn instanceof HTMLButtonElement) || btn.disabled) return
  const index = Number(btn.dataset.index)
  if (!Number.isInteger(index)) return
  handleAdvance({ type: 'SELECT_QUEUE_ENTRY', index, queue: renderedQueue })
})

document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.queuerow-remove')
  if (!(btn instanceof HTMLButtonElement)) return
  const index = Number(btn.dataset.index)
  if (!Number.isInteger(index)) return
  apply({ type: 'REMOVE_QUEUE_ENTRY', index, queue: renderedQueue })
})

document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.queuerow-move')
  if (!(btn instanceof HTMLButtonElement) || btn.disabled) return
  const index = Number(btn.dataset.index)
  const dir = btn.dataset.dir
  if (!Number.isInteger(index) || (dir !== 'up' && dir !== 'down')) return
  apply({ type: 'MOVE_QUEUE_ENTRY', index, dir, queue: renderedQueue })
})

/** A strategy switch writes ONE field. The pins survive in place and in
 *  order — structurally, because a strategy cannot reach layer 1 at all. */
document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.queuemethod')
  if (!(btn instanceof HTMLButtonElement)) return
  const method = btn.dataset.method
  if (!isAutoMethod(method)) return
  apply({ type: 'SET_METHOD', method })
})

/** CLEAR destroys layer 1, which is why it is the one .btn-danger in here.
 *  It is also the manual path §1.5 relies on: a browser that has suppressed
 *  further dialogs makes every replace prompt read as cancel, and clearing
 *  by hand then playing needs no prompt at all. `current` keeps playing. */
document.getElementById('queue-clear')?.addEventListener('click', () => {
  apply({ type: 'CLEAR_QUEUE' })
  lastTruncation = null
  renderDrawer()
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
  /**
   * §5's "playback started" trigger, on the EVENT rather than on one of the
   * paths that causes it. `startCurrent` spends the flag for a track the engine
   * started; this covers the case §5 actually describes and the other trigger
   * missed — a RESUMED track, where the member presses ▶ on something already
   * loaded and `startCurrent` never runs. Without it a returning member with an
   * autoplay method selected gets no layer 2 at all, and the track they pressed
   * play on is still the last one that plays. Idempotent: the flag is spent
   * once, so a pause/resume mid-track costs nothing.
   */
  audio.addEventListener('play', hydrateIfDeferred)
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
      // Genuinely nothing playing as far as the engine is concerned. A RESUME
      // no longer reaches this branch — restorePlayer dispatches
      // RESTORE_CURRENT, which is what makes autoplay work on a restored
      // session at all — so what is left is an <audio> element some other code
      // pointed at a file. Keep M6a's behaviour exactly: there is no queue to
      // advance through.
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

/**
 * The drawer's `warehouse · 24 of 60` line, remembered from whichever write
 * last hit the cap. Null when nothing was lost.
 *
 * `slotsFor(...).need === 0` is the gate, and it is not the same test as
 * `added < offered`: playing the third row of an eight-row table adds five of
 * eight and truncates NOTHING, because the two rows above the clicked one were
 * never candidates. That distinction is `truncationFor`'s whole job — it was a
 * live "pool · 5 of 8" in the drawer until driving it caught it.
 */
function noteTruncation(result: ReduceResult, sourceLabel: string | null): void {
  lastTruncation = truncationFor(result, sourceLabel, slotsFor(getState()).need === 0)
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
/**
 * UX.9 resume, queue half. Runs SYNCHRONOUSLY at init, before restorePlayer's
 * fetch — which is what keeps the "a click always beats a restore" rule
 * intact: this touches only the store and the drawer, never `currentFileId`,
 * so a click that lands a moment later still claims the transport unopposed
 * and its own PLAY_TRACK replaces whatever was restored here.
 *
 * LAYER 1 ONLY. The array is assembled with an EMPTY tail, deliberately: §5
 * defers the auto tail to the first of (drawer opened | playback started), and
 * with the default method there is no tail to defer. Nothing in this function
 * can issue a request.
 */
function restoreQueue(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(QUEUE_MEMORY_KEY)
  } catch {
    return // storage disabled — nothing to restore, not fatal.
  }
  const { state: restored, needsHydration, stale } = restoredState(raw)
  if (stale) {
    try {
      localStorage.removeItem(QUEUE_MEMORY_KEY)
    } catch {
      // Nothing to clean up if storage was never writable.
    }
    return
  }
  if (restored.current === null && restored.intent.length === 0) return
  queueNeedsHydration = needsHydration
  setState(restored)
  setRenderedQueue(assembleQueue(restored, []))
}
restoreQueue()
// Always render once at init, restore or not: an empty drawer still owes the
// member its method buttons and its three section headings, and rendering
// only on the first event would leave the first open blank.
renderDrawer()

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

  /**
   * TELL THE ENGINE WHAT THE TRANSPORT IS HOLDING. Without this line the queue
   * believes nothing is playing while a track audibly plays, and three things
   * break at once — all reported from a phone, all the same fact:
   *
   *   · the drawer renders "Nothing playing." over audible audio;
   *   · `ended` reduces to nothing, so autoplay never advances;
   *   · every SKIP path (lock screen, ⏭) is guarded on `current` and is inert.
   *
   * Player memory and queue memory can disagree honestly — player memory is
   * rewritten on every timeupdate, queue memory only on engine events, so a
   * `+ queue` with nothing playing, or a queue payload that aged out from
   * under a still-fresh player entry, both leave `current` null with a real
   * track in the transport. The reducer keeps the richer entry when both name
   * the same file and takes this one when they do not; either way the engine
   * ends up naming what <audio> is holding.
   *
   * AFTER the `currentFileId` re-check above, never before: a click that
   * landed during the fetch has already backed this restore off entirely, and
   * it must back the engine off too. `hydrate: false` because a restore is
   * neither of §5's two triggers.
   */
  apply({ type: 'RESTORE_CURRENT', entry: resumedEntry(entry.file_id, entry.title) }, false)
  // Unconditional, and it is the event above that earns it: the engine now
  // names this track, so the lock screen is describing what is really loaded.
  // This line used to be guarded on the two agreeing, which — before the
  // engine was ever told — was false exactly when the metadata was needed.
  updateMediaSession()
}
void restorePlayer()

const autosubmit = debounce((form: HTMLFormElement) => form.requestSubmit(), 300)
document.addEventListener('input', (e) => {
  const el = e.target
  if (el instanceof HTMLInputElement && el.name === 'q'
      && el.form?.hasAttribute('data-autosubmit')) autosubmit(el.form)
})

/* ============================================================
   THE BOTTOM ACTION SHEET
   ============================================================
   The owner's "modals and three dot menus", built once. The nav's ⋮,
   every row's ⋮, the filter panel and the crate picker are all this one
   component; building it per surface is how an app ends up with four
   dismissal behaviours and a member who has learned only one of them.

   Vanilla DOM, NOT an island. Shell.astro mounts on every page, so an
   island here would ship to /login — the same rule shell-bundle.test.ts
   already enforces for the queue drawer.

   The maths lives in src/lib/sheet.ts and is tested there with no DOM.
   Everything below is the part that has to touch `document`.

   TWO RULES THAT ARE NOT OBVIOUS AND ARE LOAD-BEARING:

   1. THE SHEET CLOSES ON `astro:before-swap`. It is portalled to <body>,
      so it sits OUTSIDE transition:persist and ClientRouter would destroy
      its node while this module still held a reference and <body> was
      still scroll-locked. Closing it explicitly is the difference between
      "the sheet is ephemeral by design" and "the page is frozen after you
      tap a link in a menu". It is also exactly why the now-playing sheet
      is deliberately NOT portalled — see the spec's §5.3.

   2. NO INLINE HANDLERS, EVER. An inline `onclick=` in this bundle trips
      Cloudflare's API WAF and 403s the deploy (survive-list #6). Every
      control below is wired with addEventListener on a node this module
      created.

   The sheet creates no second aria-live region either: #player-label is
   THE status region (survive-list #12) and two regions race. */

interface SheetOptions {
  title: string
  rows: readonly (SheetRowInput | null | undefined | false)[]
  /** Called with the row id when a non-link row is chosen. */
  onChoose?: (id: string, row: SheetRow) => void
  /** Focus returns here on close — the ⋮ that opened it. */
  returnFocusTo?: HTMLElement | null
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

let openSheet: { close: (immediate?: boolean) => void } | null = null

function svgIcon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  // aria-hidden always: the accessible name belongs to the ROW, not to
  // the glyph. The text controls this replaces are announced today, and
  // an <svg aria-hidden> is silent.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('icon')
  svg.innerHTML = renderGlyph(name, { small: size <= 14 })
  return svg
}

function sheetRowEl(row: SheetRow): HTMLElement {
  const el = document.createElement(row.href ? 'a' : 'button')
  el.className = 'sheet-row'
  if (el instanceof HTMLButtonElement) el.type = 'button'
  if (el instanceof HTMLAnchorElement && row.href) el.href = row.href
  if (row.danger) el.classList.add('is-danger')
  if (row.isLast) el.classList.add('is-last')
  if (row.disabled) {
    el.setAttribute('aria-disabled', 'true')
    if (el instanceof HTMLButtonElement) el.disabled = true
  }
  if (row.pressed !== undefined) el.setAttribute('aria-pressed', String(row.pressed))
  el.dataset.sheetRow = row.id

  if (row.icon) el.appendChild(svgIcon(row.icon))
  const label = document.createElement('span')
  label.className = 'sheet-row-label'
  label.textContent = row.label
  el.appendChild(label)
  if (row.meta) {
    const meta = document.createElement('span')
    meta.className = 'sheet-row-meta'
    meta.textContent = row.meta
    el.appendChild(meta)
  }
  return el
}

/**
 * Opens a sheet. Returns a function that closes it.
 *
 * Only one sheet exists at a time — opening a second closes the first
 * immediately rather than stacking. A stack of sheets on a phone is a
 * member who cannot tell what dismissing one will reveal.
 */
export function openActionSheet(opts: SheetOptions): () => void {
  openSheet?.close(true)

  const rows = normalizeRows(opts.rows)
  const returnFocusTo = opts.returnFocusTo ?? null

  const root = document.createElement('div')
  root.className = 'sheet'
  root.dataset.sheet = ''

  const scrim = document.createElement('div')
  scrim.className = 'sheet-scrim'

  const panel = document.createElement('div')
  panel.className = 'sheet-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', opts.title)

  const handle = document.createElement('button')
  handle.type = 'button'
  handle.className = 'sheet-handle'
  handle.setAttribute('aria-label', 'Close')

  const head = document.createElement('div')
  head.className = 'sheet-head'
  const heading = document.createElement('span')
  heading.className = 'sheet-title'
  heading.textContent = opts.title
  head.appendChild(heading)

  // The ROW LIST is the scroller, not the panel — a panel that scrolls
  // takes its own header and handle out of reach.
  const list = document.createElement('div')
  list.className = 'sheet-list'
  for (const row of rows) list.appendChild(sheetRowEl(row))

  // appendChild rather than the variadic append(): the Workers type
  // definitions in this project shadow Element.append with a streaming
  // signature, so the variadic form does not type-check here.
  panel.appendChild(handle)
  panel.appendChild(head)
  panel.appendChild(list)
  root.appendChild(scrim)
  root.appendChild(panel)

  const scrollY = window.scrollY
  const prevOverflow = document.body.style.overflow
  // Body scroll is LOCKED while open, and that differs from the reference
  // design deliberately: theirs is a comparison panel read against the
  // page behind it; ours is a menu, and a menu that lets the page scroll
  // under it loses the row it was opened on.
  document.body.style.overflow = 'hidden'
  document.body.classList.add('sheet-open')

  let closed = false
  function close(immediate = false): void {
    if (closed) return
    closed = true
    openSheet = null
    root.classList.remove('is-open')
    document.body.style.overflow = prevOverflow
    document.body.classList.remove('sheet-open')
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('astro:before-swap', onSwap)
    const finish = () => root.remove()
    if (immediate) finish()
    else window.setTimeout(finish, exitDelayMs(prefersReducedMotion()))
    // Focus goes back to the control that opened the sheet. A keyboard
    // user dumped at the top of the document has to find their place
    // again on every single menu.
    if (returnFocusTo?.isConnected) returnFocusTo.focus()
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY)
  }

  function focusables(): HTMLElement[] {
    return [...panel.querySelectorAll<HTMLElement>(
      '.sheet-row:not([aria-disabled="true"]), .sheet-handle',
    )]
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key !== 'Tab') return
    // The trap. A sheet that lets Tab reach the page behind it strands a
    // keyboard user on content they cannot see under the scrim.
    const items = focusables()
    if (items.length === 0) return
    e.preventDefault()
    const here = items.indexOf(document.activeElement as HTMLElement)
    items[nextFocusIndex(here, items.length, e.shiftKey ? -1 : 1)]?.focus()
  }

  scrim.addEventListener('click', () => close())
  handle.addEventListener('click', () => close())
  list.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>('.sheet-row')
    const id = el?.dataset.sheetRow
    if (!el || !id) return
    if (el.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return }
    const model = rows.find((r) => r.id === id)
    // A link row navigates on its own; a button row calls back. Either
    // way the sheet closes, because it is ephemeral by design.
    if (model && !model.href) { e.preventDefault(); opts.onChoose?.(id, model) }
    close(Boolean(model?.href))
  })
  document.addEventListener('keydown', onKeydown, true)

  const onSwap = () => close(true)
  document.addEventListener('astro:before-swap', onSwap)

  // --- the drag ----------------------------------------------------
  let startY = 0
  let startX = 0
  let startT = 0
  let lastY = 0
  let lastT = 0
  let dragging = false
  let axis: ReturnType<typeof classifyGesture> = 'none'

  panel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return // a mouse drags nothing here
    // A drag that starts inside the scrolling list must be allowed to
    // scroll it; only a list already at its top can pull the sheet down.
    if (list.contains(e.target as Node) && list.scrollTop > 0) return
    dragging = true
    axis = 'none'
    startY = lastY = e.clientY
    startX = e.clientX
    startT = lastT = e.timeStamp
    panel.dataset.dragging = 'true'
  })

  panel.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dy = e.clientY - startY
    const dx = e.clientX - startX
    if (axis === 'none') {
      axis = classifyGesture(dx, dy)
      // A sideways swipe belongs to somebody else — a carousel, or the
      // browser's back gesture. Let go of it rather than half-tracking it.
      if (axis === 'horizontal') { dragging = false; delete panel.dataset.dragging; return }
    }
    if (dy <= 0) return // dragging up: the sheet is already at its top
    lastY = e.clientY
    lastT = e.timeStamp
    // Write the OFFSET, not the whole transform. The desktop rule adds a
    // -50% X translation for centring, and an inline `transform` would
    // silently drop it — a bug that only shows on an iPad, where the
    // panel is centred and the input is touch.
    panel.style.setProperty('--drag-y', `${dy}px`)
  })

  function endDrag(e: PointerEvent): void {
    if (!dragging) return
    dragging = false
    delete panel.dataset.dragging
    panel.style.removeProperty('--drag-y')
    const dy = e.clientY - startY
    const velocity = velocityPxPerMs(lastY - startY, lastT - startT)
    if (shouldDismiss({ dy, panelHeight: panel.getBoundingClientRect().height, velocity })) close()
  }
  panel.addEventListener('pointerup', endDrag)
  panel.addEventListener('pointercancel', endDrag)

  document.body.appendChild(root)
  // TWO-FRAME rAF MOUNT. The panel mounts off-screen, and the browser
  // needs one frame in which that is its committed state before the class
  // that moves it has anywhere to animate FROM. One rAF is not reliably
  // enough; two is.
  if (prefersReducedMotion()) root.classList.add('is-open')
  else requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')))

  focusables()[0]?.focus()
  openSheet = { close }
  return () => close()
}

/** True while a sheet is on screen. */
export const isSheetOpen = (): boolean => openSheet !== null
