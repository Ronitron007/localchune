// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'
import { formatDuration } from '../lib/format'
import { iconEl } from '../lib/icons'
import {
  classifyGesture, exitDelayMs, nextFocusIndex, normalizeRows, shouldDismiss,
  velocityPxPerMs, type SheetRow, type SheetRowInput,
} from '../lib/sheet'
import {
  addToCrate, createCrate, DuplicateCrateItemError, SessionExpiredError, toggleLike,
} from '../lib/org-api'
import { createPlayMeter } from '../lib/play-meter'
import { artFallback, artMediumUrl, artThumbUrl, LIKE_ICON, likeActionLabel, trackHref } from '../lib/track-format'
import { PLAYER_MEMORY_KEY, isStale, makeEntry, parseEntry, serializeEntry } from '../lib/player-memory'
import { artistHref } from '../lib/pool-api'
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
const link = document.getElementById('player-link') as HTMLAnchorElement | null
const artistEl = document.getElementById('player-artist')
const likeForm = document.getElementById('player-like') as HTMLFormElement | null
const toggle = document.getElementById('player-toggle') as HTMLButtonElement | null
const nextBtn = document.getElementById('player-next') as HTMLButtonElement | null
const time = document.getElementById('player-time')
const seek = document.getElementById('player-seek') as HTMLInputElement | null

/* ------------------------------------------- what the player bar says
 *
 * #player-label has always done two jobs, and adding a link forced them
 * apart. It is the ONE aria-live region every handler in this file reports
 * through — a transient message about a like, a crate, a dead session — and
 * it is also where the name of the current track lives. Only the second is
 * a link, and the two must not be able to produce a third state.
 *
 * So there are exactly two writers, and everything below calls one of them:
 *
 *   setStatus(text)          plain text, no link. What every `label
 *                            .textContent = …` in this file used to be, with
 *                            identical behaviour — a message has always
 *                            replaced the track name until the next track
 *                            starts.
 *   setNowPlaying(text, id)  the name, as an anchor to /track/<id>. A null
 *                            id means "no track" and falls back to plain
 *                            text, so an idle bar never renders a dead link.
 *
 * setStatus DETACHES the anchor (textContent removes every child) and
 * setNowPlaying re-appends it. That is why `link` is captured once above and
 * never re-queried: the node survives detachment, and re-querying after a
 * status message would find nothing.
 */
function setStatus(text: string): void {
  if (label === null) return
  label.textContent = text
}

/**
 * The name, as two lines: the title as the anchor, the artist under it.
 *
 * OWNER-CONFIRMED LAYOUT, 2026-08-06. It used to be one joined
 * "Artist — Title" in a `nowrap` span at `flex: 1 1 6rem`, which on a
 * phone truncated to the artist and three characters of the title — the
 * half a member does not need. Two lines ellipsize independently.
 *
 * The two arguments are the entry's own `display_title` and
 * `display_artist`, which is the same pair Media Session sends to the
 * lock screen. NOTHING SPLITS THE JOINED STRING BACK APART: a title with
 * an em dash in it would make that a guess, and the separate fields have
 * been on the entry all along.
 *
 * Both nodes are captured once at module load and re-appended here,
 * because setStatus() writes textContent and textContent removes every
 * child — the same reason `link` has always been captured rather than
 * re-queried.
 */
function setNowPlaying(title: string, artistName: string | null, fileId: string | null): void {
  if (label === null) return
  label.textContent = ''
  if (link === null || fileId === null) {
    label.textContent = title
    return
  }
  link.textContent = title
  link.href = trackHref(fileId)
  link.hidden = false
  label.appendChild(link)
  if (artistEl === null) return
  const named = artistName !== null && artistName !== ''
  artistEl.textContent = named ? artistName : ''
  // The artist line is a LINK now, so the bar can reach an act's page from
  // whatever is playing. Same "no dead link" rule the title above obeys:
  // an anchor with no href resolves to the current page, so the attribute
  // is REMOVED between tracks rather than set to an empty string.
  if (named) artistEl.setAttribute('href', artistHref(artistName))
  else artistEl.removeAttribute('href')
  artistEl.hidden = !named
  if (named) label.appendChild(artistEl)
}

/**
 * THE ♥ IN THE BAR, pointed at whatever is playing.
 *
 * Not one line of like LOGIC lives here. The button this writes into carries
 * `class="likebtn"` inside `form.likeform`, which is the exact contract the
 * document-level submit delegation further down already implements for
 * TrackRow.astro's pool cell and track/[id].astro's .signals block — so the
 * bar's heart toggles, rolls back on failure and reports through the same
 * status region as the other two, for free. This function only ever answers
 * "which track, and what did the server last say about it".
 *
 * A null `fileId` re-arms the markup's own inert state: hidden AND disabled,
 * with no action. That pair is what makes the form unsubmittable between
 * tracks — the delegation bails without preventDefault when `data-file-id`
 * is empty, and a bail means the browser would POST natively to whatever
 * `action` says.
 */
function setPlayerLike(fileId: string | null, liked: boolean, count: number, title: string): void {
  if (likeForm === null) return
  const btn = likeForm.querySelector('button.likebtn')
  const glyph = likeForm.querySelector('.likeglyph')
  const countEl = likeForm.querySelector('.likecount')
  if (!(btn instanceof HTMLButtonElement) || glyph === null || countEl === null) return

  if (fileId === null) {
    likeForm.removeAttribute('action')
    btn.dataset.fileId = ''
    btn.disabled = true
    likeForm.hidden = true
    return
  }
  likeForm.action = `/api/track/${fileId}/like`
  btn.dataset.fileId = fileId
  btn.setAttribute('aria-pressed', String(liked))
  btn.setAttribute('aria-label', likeActionLabel(liked, title))
  glyph.replaceChildren(iconEl(LIKE_ICON.name, { size: LIKE_ICON.size, filled: liked }))
  countEl.textContent = String(count)
  btn.disabled = false
  likeForm.hidden = false
}

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
/** The two lines the bar shows, kept apart. `currentTitle` above stays the
 *  JOINED string, because that is what player memory serialises and what
 *  the ♥'s aria-label reads — neither wants two fields. */
let currentName = ''
let currentArtist: string | null = null

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

/**
 * OWNER, 2026-08-07: no text-glyph control anywhere. `⏸` (U+23F8) and `⏭`
 * (U+23ED) carry EMOJI PRESENTATION by default, so iOS paints them as full
 * colour emoji — a blue-and-white pill in the middle of a monochrome
 * brutalist bar, which is what the owner screenshotted. A font choice cannot
 * override it reliably and `text-rendering` does not touch it. The icon set
 * exists precisely so a control's shape is ours rather than the platform's.
 *
 * `replaceChildren`, not `textContent`: the button holds an element now, and
 * a stray `textContent =` would delete the glyph and leave an empty 44px box.
 * The accessible name stays on the BUTTON — the <svg> is aria-hidden, so
 * without this attribute the control would be silent to a screen reader.
 */
function updateToggle() {
  if (!toggle || !audio) return
  const playing = !audio.paused && !audio.ended
  toggle.replaceChildren(iconEl(playing ? 'pause' : 'play', { size: 20 }))
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
      setStatus('Session ended — reload to sign in.')
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
      setStatus(candidateError)
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
  // The same two fields Media Session sends to the lock screen, kept for
  // the bar's two-line stack. Read from the entry, never split back out
  // of `currentTitle`.
  currentName = entry.display_title
  currentArtist = entry.display_artist
  return entry
}

/**
 * ONE FETCH, TWO ANSWERS. `/api/track/:id/source` presigns from a `pool_get`
 * row that already carries the like columns, so it now returns them too —
 * which is the whole reason the bar's ♥ costs no request of its own. See
 * that route's header: no new RPC, no migration, four free fields.
 *
 * `report` is false for the lookahead prefetch — a failed prefetch is
 * invisible by design; the real fetch on advance reports for it. The
 * try/catch is new relative to M6a's inline version: a dropped connection
 * used to reject inside a floating promise with nothing to catch it.
 */
type TrackSource = {
  url: string
  liked: boolean
  like_count: number
  title: string
  artist: string | null
}

async function fetchTrackSource(fileId: string, report: boolean): Promise<TrackSource | null> {
  try {
    const res = await fetch(`/api/track/${fileId}/source`, {
      headers: { accept: 'application/json' },
    })
    // Non-JSON means middleware redirected to /login — say so, do not parse.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (report) setStatus('Session ended — reload to sign in.')
      return null
    }
    const body = (await res.json()) as Partial<TrackSource> & { message?: string; error?: string }
    if (!res.ok || !body.url) {
      if (report) setStatus(body.message ?? body.error ?? 'could not load that track')
      return null
    }
    return {
      url: body.url,
      liked: body.liked === true,
      like_count: typeof body.like_count === 'number' ? body.like_count : 0,
      title: typeof body.title === 'string' ? body.title : '',
      artist: typeof body.artist === 'string' ? body.artist : null,
    }
  } catch {
    if (report) setStatus('could not load that track')
    return null
  }
}

/** One lookahead source, at most, for exactly one file id. It carries the
 *  like state with it now — the prefetch is at most twenty seconds old, and
 *  a second request just to re-ask "is this liked" would undo the point of
 *  prefetching at all. */
let lookaheadId: string | null = null
let lookaheadSource: TrackSource | null = null

function clearLookahead(): void {
  lookaheadId = null
  lookaheadSource = null
}

function takeLookahead(fileId: string): TrackSource | null {
  if (lookaheadId !== fileId || lookaheadSource === null) return null
  const src = lookaheadSource
  clearLookahead()
  return src
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
  lookaheadSource = null
  void (async () => {
    const src = await fetchTrackSource(next.file_id, false)
    if (lookaheadId === next.file_id) lookaheadSource = src
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
  const src = takeLookahead(fileId) ?? (await fetchTrackSource(fileId, true))
  if (src === null) return
  // A newer claim landed while the URL was in flight — that click outranks
  // this load, exactly as it outranks a restore.
  if (currentFileId !== fileId) return

  audio.src = src.url
  playMeter.reset()
  // §1.2: a play truncated by the cap "says so once". The track name is the
  // ordinary content of this region; the count rides along after it rather
  // than replacing it, so nobody has to choose between knowing what is
  // playing and knowing that 36 tracks did not fit.
  //
  // The NAME is the link, and the truncation note is not — appending it to
  // the anchor's text would make "pool · 24 of 60" part of what a screen
  // reader announces as the link, and part of what a member clicks. So a
  // truncated play falls back to plain text for the one track it decorates,
  // and the link returns on the next one.
  if (lastTruncation === null) {
    setNowPlaying(currentName, currentArtist, fileId)
  } else {
    setStatus(`${currentTitle} · ${truncationLine(lastTruncation)}`)
  }
  // The one place a track START writes the ♥ — the server's answer, arriving
  // on the same response as the URL. The other writer is the like delegation
  // itself, which owns the state from the moment a member touches it.
  setPlayerLike(fileId, src.liked, src.like_count, currentTitle)
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
    setStatus('That track would not play. Try downloading it.')
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
      //
      // Both sizes, smallest first, with HONEST `sizes` — this used to offer
      // the 64 px thumb alone and declare it 256x256, so every lock screen
      // scaled it up 4x. The OS picks per its own display, and if the medium
      // is missing (a file analysed since the last derivatives sweep) it
      // falls back to the thumb by itself, which is the whole point of
      // listing two. 512 is the medium's BOX, not a promise of squareness:
      // the long edge is capped there and the short edge follows the source.
      artwork: [
        {
          src: artThumbUrl(import.meta.env.PUBLIC_ART_BASE_URL, entry.file_id),
          sizes: '64x64',
          type: 'image/jpeg',
        },
        {
          src: artMediumUrl(import.meta.env.PUBLIC_ART_BASE_URL, entry.file_id),
          sizes: '512x512',
          type: 'image/jpeg',
        },
      ],
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
    currentName = ''
    currentArtist = null
    clearLookahead()
    clearPlayerMemory()
    updateMediaSession()
    setStatus('Queue finished.')
    // Nothing is playing, so there is nothing to like and nothing to link
    // to. Both controls go back to the inert state the markup ships with —
    // a ♥ pointed at the track that just finished would be a lie, and the
    // link would be a dead one.
    setPlayerLike(null, false, 0, '')
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

/**
 * The `a.play` that carries a given track's queue metadata.
 *
 * PERF TASK 2.2 — this is the whole reason `button.queueadd` may now say
 * `data-file-id` and nothing else. The audit measured artist and title
 * serialised up to eight times per row; five of those were the `+Q`
 * button's private copy of what the play link beside it already states, on
 * every one of a hundred rows.
 *
 * Document-wide rather than row-scoped, and deliberately: the attributes
 * describe the TRACK, not the row, so a track that appears in two feed
 * sections at once gives the same six values from either link. Both
 * surfaces that render the pair (TrackRow's `td.controls`, FeedRow's
 * `li.feedrow`) put them side by side, so this is a nearby lookup in
 * practice, not a page scan.
 */
function playLinkFor(fileId: string): HTMLElement | null {
  const a = document.querySelector(`a.play[data-track-id="${fileId.replace(/["\\]/g, '\\$&')}"]`)
  return a instanceof HTMLElement ? a : null
}

/** One control's own metadata — a play link, or the play link a `+Q` button
 *  was pointed at by `playLinkFor`. */
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
        // The drag needs both on the ROW, not on a control inside it: the
        // library sorts `li` elements and reports positions within the list,
        // and turning one of those back into an engine index needs the row's
        // own rendered index and its file id.
        li.dataset.index = String(row.index)
        li.dataset.fileId = row.entry.file_id

        // A drag handle, not a pair of arrows. OWNER: drag-and-drop replaces
        // the ↑/↓ buttons. It is a real <button> so it is tabbable and keeps
        // a keyboard path — the arrow keys on a focused handle move one step,
        // through the same MOVE_QUEUE_ENTRY the drag dispatches. A drag with
        // no keyboard equivalent is not an enhancement, it is a regression,
        // and the library has no keyboard sorting of its own.
        if (row.reorderable) {
          const grip = button('queuerow-drag', '', `Reorder ${entryTitle(row.entry)}`)
          grip.appendChild(iconEl('drag', { size: 16 }))
          grip.dataset.index = String(row.index)
          li.appendChild(grip)
        }

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
          const rm = button('btn-secondary queuerow-remove', '', `Remove ${entryTitle(row.entry)} from the queue`)
          rm.appendChild(iconEl('close', { size: 16 }))
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

  wireQueueDrag()
  syncDrawerHeight()
}

/* --------------------------------------------------- drag-to-reorder
 *
 * LOADED ON DEMAND, AND THE TRIGGER IS THE POINT. `#queue-sections` is in
 * Shell.astro, so it exists on every signed-in page — keying the import off
 * its presence would download the library everywhere and defeat the split.
 * The honest triggers are the two moments a reorder becomes possible: the
 * drawer being OPENED with more than one pin in it, and a page that actually
 * carries `[data-reorder]` (the owner's own crate page, and nothing else).
 *
 * A failed import is not an error anyone needs to hear about. Reorder falls
 * back to the arrow keys on the drag handle, and on the crate page to the
 * ↑/↓ POST forms that are always there.
 */
type DragModule = typeof import('./drag-reorder')
let dragModule: DragModule | null = null
let dragLoading: Promise<void> | null = null

function loadDragModule(): void {
  if (dragLoading !== null) return
  dragLoading = import('./drag-reorder')
    .then((m) => {
      dragModule = m
      // The lists that were already on screen when the import landed.
      wireQueueDrag()
      wireCrateDrag()
    })
    .catch(() => {
      // Keyboard and the no-JS forms remain. Nothing to say.
    })
}

/**
 * Make the YOUR QUEUE section sortable. Called at the end of every drawer
 * render (the `<ul>` is rebuilt each time) and again when the import lands.
 *
 * ONE ENGINE EVENT PER DRAG. The library reports positions WITHIN the pin
 * list; `MOVE_QUEUE_ENTRY` addresses the RENDERED array. The offset between
 * them is the first row's own `data-index`, read off the DOM that was just
 * rendered rather than recomputed from state — so the number the engine gets
 * refers to the array the member was looking at, which is this whole
 * milestone's one hard rule.
 *
 * A drag that ends where it started re-renders instead of dispatching. That
 * is not an optimisation: the library has already moved the real DOM nodes,
 * so something must put them back, and re-rendering from the engine's state
 * is the only restore that cannot disagree with the engine. It also spends no
 * regeneration and issues no request for a gesture that changed nothing.
 */
function wireQueueDrag(): void {
  if (dragModule === null || drawerSections === null) return
  const list = drawerSections.querySelector<HTMLElement>('[data-section="yours"] .queuelist')
  if (list === null) return
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > li[data-index]')]
  if (rows.length < 2) return
  const base = Number(rows[0].dataset.index)
  if (!Number.isInteger(base)) return

  dragModule.wireDragList({
    parent: list,
    ids: rows.map((r) => r.dataset.fileId ?? ''),
    handle: '.queuerow-drag',
    onDrop: (from, to) => {
      if (from === to) {
        renderDrawer()
        return
      }
      apply({ type: 'MOVE_QUEUE_ENTRY', index: base + from, to: base + to, queue: renderedQueue })
    },
  })
}

/** The handle's keyboard equivalent: one step per press, through the same
 *  verb the drag uses. The library sorts by pointer only, so without this the
 *  drawer would have no reorder path for a keyboard at all. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const grip = (e.target as Element).closest?.('button.queuerow-drag')
  if (!(grip instanceof HTMLButtonElement)) return
  const index = Number(grip.dataset.index)
  if (!Number.isInteger(index)) return
  e.preventDefault()
  const to = e.key === 'ArrowUp' ? index - 1 : index + 1
  apply({ type: 'MOVE_QUEUE_ENTRY', index, to, queue: renderedQueue })
  // The drawer re-rendered under the press, so the button that had focus is
  // gone. Follow the row: it is at `to` if the move happened and still at
  // `index` if it was a boundary the engine clamped away. Without this, one
  // press costs the keyboard user their place in the list.
  const grip$ = (at: number) => drawerSections?.querySelector<HTMLButtonElement>(
    `button.queuerow-drag[data-index="${at}"]`) ?? null;
  (grip$(to) ?? grip$(index))?.focus()
})

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
  // OWNER-APPROVED OPEN STATE, from a mock: the button inverts to solid
  // ink and its glyph becomes a close mark, so the control that opened the
  // drawer is visibly the one that closes it. The FILL is CSS off
  // aria-expanded — these two lines own the glyph and the accessible name,
  // because a button reading "QUEUE" while it means "close" is a lie a
  // screen reader would repeat.
  //
  // The glyphs are the ICON SET, not `☰` and `✕`. Shell.astro server-renders
  // the closed state with the same two components, so the first paint and
  // every state after it are one vocabulary. A text node beside an element
  // means `textContent =` would delete the glyph, so this replaces children
  // and re-adds the label as its own node.
  drawerToggle.replaceChildren(
    iconEl(open ? 'close' : 'queue', { size: 16 }),
    document.createTextNode(' QUEUE'),
  )
  drawerToggle.setAttribute('aria-label', open ? 'Close the queue' : 'Open the queue')
  document.body.classList.toggle('queueopen', open)
  syncDrawerHeight()
  // One of §5's two triggers for the deferred tail. The other is in
  // startCurrent — whichever happens first spends the flag.
  if (open) hydrateIfDeferred()
  // …and the moment a reorder becomes possible. Opening the drawer is a
  // deliberate act, and a member who never opens it never downloads the drag
  // library. Two pins is the smallest queue that HAS an order to change.
  if (open && getState().intent.length > 1) loadDragModule()
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

/** The art derivatives degrade instead of breaking — `artFallback` states
 *  the rule and is tested; this is only the DOM write. Capture phase,
 *  because `error` on an <img> does not bubble. One listener for the whole
 *  document rather than an inline handler per row: a pool page renders 100
 *  rows and the attribute would be pure page weight on all of them. */
document.addEventListener('error', (e) => {
  const img = e.target
  if (!(img instanceof HTMLImageElement)) return
  const trackId = img.dataset.artFile
  switch (artFallback(img.hasAttribute('srcset'), img.classList.contains('art'))) {
    case 'drop-srcset':
      img.removeAttribute('srcset')
      break
    case 'signed-full':
      // Guarded so a second failure cannot loop: the signed path is the end
      // of the chain, and it is only reachable when we know the file id.
      if (trackId !== undefined && img.dataset.artFallen !== '1') {
        img.dataset.artFallen = '1'
        img.src = `/api/track/${encodeURIComponent(trackId)}/art?full=1`
      }
      break
  }
}, true)

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
        if (!recovered && currentFileId === null) {
          setStatus('Nothing to play yet.')
        } else if (!recovered) {
          setStatus('That track would not play. Try downloading it.')
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
/**
 * Everything inside a row that owns its own tap: the ♥ form's button, the
 * queue-add, the three-dot, the title and artist links to /track/[id],
 * the download link, the crate picker's disclosure. Written as one list
 * so a control added to a row tomorrow is exempt by being a control,
 * rather than by someone remembering to add it here.
 */
const ROW_TAP_EXEMPT = 'a, button, input, select, textarea, label, summary'

/**
 * WHICH PLAY LINK A TAP MEANS — owner directive, 2026-08-06: "list rows
 * lose the play button; whole-row tap plays, matching the queue drawer's
 * grammar." The drawer has read that way since M6b, where
 * `.queuerow-play` spans the row; every other list shipped a 14x18px
 * glyph, which the audit ranked as offender #2.
 *
 * THE SELECTOR CONTRACT DOES NOT MOVE. `a.play[data-track-id]` is still
 * the element carrying data-artist/-title/-duration/-bpm/-key, still the
 * thing `scrapeRows` collects in rendered order, still the no-JS path to
 * the track page. It has become the artwork rather than a glyph, and the
 * row has gained a way to reach it — that is the entire change. Moving
 * those attributes onto the row would have meant rewriting scrapeRows,
 * playLinkFor and scrapeOne at once, and their shared failure mode is a
 * queue of nameless entries, which the crate route has already paid for.
 *
 * Returns null when the tap belongs to something else, which is most
 * taps: a row is mostly other controls.
 */
function playLinkFromTap(target: Element): HTMLAnchorElement | null {
  const direct = target.closest?.('a.play[data-track-id]')
  if (direct instanceof HTMLAnchorElement) return direct
  const row = target.closest?.('[data-play-row]')
  if (!(row instanceof HTMLElement)) return null
  // An inner control BELONGING TO THIS ROW wins. The containment test is
  // load-bearing: closest() climbs past the row, so a row nested inside
  // some future <a> would otherwise never play.
  const own = target.closest?.(ROW_TAP_EXEMPT)
  if (own instanceof Element && row.contains(own)) return null
  const a = row.querySelector('a.play[data-track-id]')
  return a instanceof HTMLAnchorElement ? a : null
}

document.addEventListener('click', (e) => {
  const a = playLinkFromTap(e.target as Element)
  if (a === null || audio === null) return
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
        const link = playLinkFor(fileId as string)
        // NO SILENT NAMELESS ENTRY. A missing link means the row's markup
        // changed under us, and queueing `{title: ''}` is exactly the bug
        // the crate route already paid for once — six entries with blank
        // names. Throwing lands in the catch below, which says so.
        if (link === null) throw new Error('no play link for this row')
        entries = [toQueueEntry(scrapeOne(link, fileId as string), 'add', sourceLabel)]
      }

      const result = apply({ type: 'ADD_TO_QUEUE', entries })
      // WHY THE APPEND FELL SHORT, and it matters: an `added: 0` because the
      // track was already queued is not an `added: 0` because the queue is
      // full, and telling a member the queue is full when it has room is a
      // lie they cannot act on. `need === 0` afterwards means layer 1 now
      // fills every slot — the cap really is what stopped it.
      noteTruncation(result, sourceLabel)
      setStatus(appendReport({
        added: result.added ?? 0,
        offered: result.offered ?? entries.length,
        label: sourceLabel,
        full: slotsFor(getState()).need === 0,
      }))
    } catch (err) {
      setStatus(err instanceof SessionExpiredError
        ? 'Session ended — reload to sign in.'
        : 'Could not add to the queue.')
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
  document.querySelectorAll<HTMLElement>(
    'button.queueadd[hidden], button.crateplay[hidden], button.rowmenu[hidden]',
  ).forEach((el) => { el.hidden = false })
  // The row menu is the whole control set below 640px, so the cells it
  // replaces are hidden only once it is real. Without JS this class is
  // never added and every row keeps every control it always had.
  document.documentElement.classList.add('has-rowmenu')
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
  /**
   * EVERY BUTTON FOR THIS FILE, not just the one that was submitted.
   *
   * Until the player bar grew a ♥ there was only ever one like button per
   * track on screen, so "the button in this form" and "this track's button"
   * were the same set. They are not any more: liking the playing track from
   * the pool row left the bar showing ♡ over the very track it had just
   * liked, and liking it from the bar left the row stale — one fact, two
   * contradictory glyphs, on one screen.
   *
   * The selector is the fix, and it keeps the handler singular: one
   * delegation, one optimistic flip, one rollback, one server confirmation.
   * The two server-rendered buttons are painted from the same pool_get row
   * and the bar's is painted from the same like columns on /source, so they
   * agree before the click and this is what keeps them agreeing after it.
   */
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(
    `button.likebtn[data-file-id="${CSS.escape(fileId)}"]`)]
  const paint = (liked: boolean, count: number) => {
    for (const b of buttons) {
      const g = b.querySelector('.likeglyph')
      const c = b.querySelector('.likecount')
      b.setAttribute('aria-pressed', String(liked))
      // The bar's button names the track in its aria-label and the two
      // server-rendered ones do too, so the verb has to flip everywhere the
      // glyph does — the glyph is aria-hidden and cannot carry it.
      const name = (b.getAttribute('aria-label') ?? '').replace(/^(Un)?[Ll]ike\s*/, '')
      b.setAttribute('aria-label', likeActionLabel(liked, name))
      // replaceChildren, not textContent: the heart is an <svg> now, and
      // the state is the SAME path filled rather than a second character.
      if (g) g.replaceChildren(iconEl(LIKE_ICON.name, { size: LIKE_ICON.size, filled: liked }))
      if (c) c.textContent = String(count)
    }
  }

  paint(!wasLiked, prevCount + (wasLiked ? -1 : 1))
  for (const b of buttons) b.disabled = true
  void (async () => {
    try {
      const result = await toggleLike(fileId)
      paint(result.liked, result.like_count)
    } catch (err) {
      paint(wasLiked, prevCount)
      setStatus(err instanceof SessionExpiredError
        ? 'Session ended — reload to sign in.'
        : err instanceof Error ? err.message : 'Could not update like.')
    } finally {
      for (const b of buttons) b.disabled = false
    }
  })()
}, true)

/**
 * Crate drag-to-reorder. TrackRow.astro's rows render `draggable`/
 * `data-file-id` only when the page passes `reorderable` (crate/[id].astro's
 * owner view), inside a `[data-reorder]` container that carries the crate id
 * itself. No such container exists on the pool table or the track page, so
 * this is a silent no-op there — the same "degrade to nothing" contract every
 * other document-level delegation in this file has.
 *
 * IT WAS NATIVE HTML5 DRAG, AND NATIVE HTML5 DRAG DOES NOT FIRE ON TOUCH.
 * `dragstart`/`dragover`/`drop` exist on a desktop and simply never happen on
 * a phone, so this feature — a hundred lines of it — was invisible on the
 * device most of this app is used on. That is the audit's offender #3 and the
 * reason a library is here at all. The pointer path is drag-reorder.ts's; the
 * rest of the contract below is unchanged.
 *
 * THE DOM ORDER IS STILL THE PENDING ORDER. The library moves the real row
 * rather than painting a ghost, so `submitCrateOrder` reads the result out of
 * `data-file-id` exactly as it always did, and there is no second copy of the
 * order to keep in sync. The server (`crate_reorder`, migration 27) is the
 * only authority on whether the result is legal — on any failure the page
 * reloads, so the visible order snaps back to what the database actually has
 * rather than leaving an order the server never accepted.
 *
 * THE ↑/↓ POST FORMS STAY, FOREVER. They are the only reorder path with no
 * JavaScript at all, and they are the keyboard path too: real
 * `<button type="submit">`s, tabbable and Enter/Space-activatable, POSTing to
 * `/api/crate/[id]/move`, which reorders through the same `moveItem` the drag
 * ends up in. The library has no keyboard sorting of its own, so removing
 * them would have traded a touch gap for a keyboard one.
 */
function wireCrateDrag(): void {
  if (dragModule === null) return
  for (const container of document.querySelectorAll<HTMLElement>('[data-reorder]')) {
    const rows = [...container.querySelectorAll<HTMLElement>('tr[data-file-id]')]
    if (rows.length < 2) continue
    dragModule.wireDragList({
      parent: container,
      ids: rows.map((r) => r.dataset.fileId ?? ''),
      handle: '.cratedrag',
      onDrop: (from, to) => {
        // A cancelled drag reports from === to and the library has already put
        // the row back, so there is nothing to persist and nothing to undo —
        // which is the old dragend/reload branch, obsolete rather than
        // dropped. Only a real move POSTs, one POST per drop.
        if (from !== to) void submitCrateOrder(container)
      },
    })
  }
}

/** The owner's crate page is the one surface that exists to be reordered, so
 *  the library loads with it rather than on first touch — a drag that has to
 *  wait for a network round trip is a drag that misses its first gesture. */
if (document.querySelector('[data-reorder]') !== null) loadDragModule()

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
      setStatus(`added to ${crateName}`)
      if (details instanceof HTMLDetailsElement) details.open = false
    } catch (err) {
      setStatus(err instanceof DuplicateCrateItemError
        ? `already in ${crateName}`
        : err instanceof SessionExpiredError
          ? 'Session ended — reload to sign in.'
          : err instanceof Error ? err.message : 'Could not add to crate.')
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
      setStatus(err instanceof SessionExpiredError
        ? 'Session ended — reload to sign in.'
        : err instanceof Error ? err.message : 'Could not create crate.')
      if (submit instanceof HTMLButtonElement) submit.disabled = false
      return
    }

    try {
      await addToCrate(crateId, fileId)
      setStatus(`added to ${name}`)
      input.value = ''
      if (details instanceof HTMLDetailsElement) details.open = false
      invalidateCratePickerCache()
      void loadCrateList().then(populateCratePickers)
    } catch (err) {
      invalidateCratePickerCache()
      setStatus(err instanceof SessionExpiredError
        ? 'Session ended — reload to sign in.'
        : `"${name}" was created, but adding the track failed — pick it from the list to retry`)
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
  const body = (await res.json()) as
    { url?: string; liked?: boolean; like_count?: number; title?: string; artist?: string | null }
  if (!res.ok || !body.url) {
    // Deleted / no longer visible / not yet available — nothing to resume.
    clearPlayerMemory()
    return
  }

  currentFileId = entry.file_id
  /**
   * THE SERVER'S NAME FOR IT, falling back to the remembered one.
   *
   * `entry.title` came out of localStorage and can be up to fourteen days
   * old (player-memory.ts's staleness window) — long enough for a retag or
   * a re-analysis to have changed what the pool calls this file. The route
   * answers from the same `pool_get` row it presigned from, so the fresh
   * title costs nothing and is simply more correct. The fallback matters
   * for a file whose display_title is genuinely empty.
   */
  currentTitle = typeof body.title === 'string' && body.title !== '' ? body.title : entry.title
  // The route already returns display_title and display_artist as separate
  // fields (see its own header — four free columns off the pool_get row it
  // presigned from), so the resumed bar gets the same two-line stack a
  // click does, from the same source, without a second request.
  currentName = typeof body.title === 'string' && body.title !== '' ? body.title : entry.title
  currentArtist = typeof body.artist === 'string' && body.artist !== '' ? body.artist : null
  setNowPlaying(currentName, currentArtist, entry.file_id)
  /**
   * THE RESUMED TRACK'S ♥, AT ZERO EXTRA REQUESTS — the whole reason the
   * like state rides on this response rather than a fetch of its own.
   *
   * This path already fetched /source at page load, before this change and
   * unrelated to it: `audio.preload` is "none", so the elapsed/total clock
   * and the scrubber need a real `src` and an explicit `load()` to show
   * anything without the member pressing ▶. The ♥ hydrates on the SAME
   * response. A returning member therefore sees the correct filled-or-hollow
   * heart on first paint, with no request that did not already happen, and
   * the zero-requests-at-load invariant is untouched.
   */
  setPlayerLike(
    entry.file_id,
    body.liked === true,
    typeof body.like_count === 'number' ? body.like_count : 0,
    currentTitle,
  )
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
  apply({ type: 'RESTORE_CURRENT', entry: resumedEntry(entry.file_id, currentTitle) }, false)
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

  if (row.icon) el.appendChild(iconEl(row.icon, { size: 20 }))
  // `labelEl`, not `label`: #player-label is the app's one aria-live
  // region and queue-wiring.test.ts guards it with a blunt text match on
  // `label.textContent =`. A local named `label` here would defeat that
  // guard by coincidence, and the guard is protecting the title anchor
  // from being detached — worth more than the shorter name.
  const labelEl = document.createElement('span')
  labelEl.className = 'sheet-row-label'
  labelEl.textContent = row.label
  el.appendChild(labelEl)
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
    // ROWS FIRST, HANDLE LAST — deliberately not one selector list.
    // querySelectorAll returns DOCUMENT order, and the handle precedes
    // the rows in the panel, so a combined query would open every sheet
    // with focus on "Close". The first thing a keyboard or screen-reader
    // user meets should be the first choice, not the exit.
    return [
      ...panel.querySelectorAll<HTMLElement>('.sheet-row:not([aria-disabled="true"])'),
      handle,
    ]
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

/* ============================================================
   THE NAV'S ⋮ — TASK 3.2
   ============================================================
   Every destination, as a 44px row, built BY READING THE NAV rather than
   from a list in this file. That is the whole design: AppNav omits
   /review and /admin for a member (a disabled link is a promise with no
   delivery date), and reading the rendered anchors means the omission
   needs no counterpart here. Nothing in this bundle knows what an owner
   is, and src/components/app-nav.test.ts asserts it stays that way.

   THE TRIGGER IS A <summary>, AND CANCELLING IT IS THE POINT. The sheet
   is JS-only; below 640px these links are the only navigation there is.
   So the markup ships a <details> whose open state reveals the same links
   as a stacked column, and this handler preventDefault()s the click —
   with JS the disclosure never opens, without JS it is the whole menu.
   No `hidden` attribute, so no flash of the wrong nav on first paint. */
document.addEventListener('click', (e) => {
  const summary = (e.target as Element).closest?.('.navmenu-btn')
  if (!(summary instanceof HTMLElement)) return
  e.preventDefault()

  const nav = summary.closest('.appnav')
  if (nav === null) return
  const who = nav.querySelector('.who')?.textContent?.trim() ?? 'Menu'
  const credits = nav.querySelector('.credits')?.textContent?.trim() ?? null
  const signout = nav.querySelector<HTMLFormElement>('#signout')

  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[data-navlink]')]
  const rows: SheetRowInput[] = [
    // The wordmark is Home on the bar. On a phone it is a weak
    // affordance, so the sheet names it — a 44px row costs nothing.
    { id: 'home', label: 'Home', href: '/' },
    ...links.map((a): SheetRowInput => ({
      id: a.pathname,
      // firstChild, not textContent: the Review link carries a badge
      // <span> and `textContent` would render the row as "Review3".
      label: (a.firstChild?.textContent ?? a.textContent ?? '').trim(),
      href: a.getAttribute('href') ?? undefined,
      meta: a.dataset.navmeta,
    })),
  ]
  if (credits !== null) rows.push({ id: 'credits', label: credits, disabled: true })
  if (signout !== null) rows.push({ id: 'signout', label: 'Sign out', danger: true })

  openActionSheet({
    title: who,
    rows,
    returnFocusTo: summary,
    onChoose: (id) => {
      // ONE sign-out code path. requestSubmit() fires a real submit
      // event, so ClientRouter reads the form's own data-astro-reload
      // opt-out and stands aside — a fetch here would clear the cookies
      // without the full document load that tears down every persisted
      // island with them (survive-list #11). form.submit() would skip the
      // event entirely and skip the opt-out with it.
      if (id === 'signout') signout?.requestSubmit()
    },
  })
}, true)

/* ============================================================
   THE ROW'S ⋮ — TASK 3.3
   ============================================================
   Six controls that are 8-30px in a dense row become six 44px rows in a
   sheet, plus the eight metadata columns the mobile card drops. That is
   the owner's "three dot menus" in one component, and it is what lets the
   card be two lines of text instead of two lines and a strip of buttons.

   NO SECOND CODE PATH FOR ANYTHING. Every action row reaches the control
   the ROW ALREADY CARRIES — `button.queueadd` gets clicked, `form.likeform`
   gets requestSubmit()ed, a crate choice clicks that row's own
   `button.cratepick-option`. So the one delegation that has always served
   each action still serves it, with its own status message, its own
   optimistic repaint and its own error branch. A sheet that called the
   like API itself would be a second implementation of a feature that
   already has one, and two implementations of one feature drift.

   The METADATA is read from the row's own cells. They are `display: none`
   below 640px, not absent — one DOM, one template — and textContent reads
   through `display: none` perfectly well. So the sheet carries no copy of
   any value and the row carries no bytes for the sheet. */

/** Cell class → the label the sheet gives it. Order is the sheet's order. */
const ROW_META: ReadonlyArray<readonly [string, string]> = [
  ['bpm', 'BPM'], ['key', 'Key'], ['duration', 'Length'], ['quality', 'Quality'],
  ['uploader', 'Uploader'], ['added', 'Added'], ['plays', 'Plays'],
  ['downloads', 'Downloads'],
]

const cellText = (row: Element, cls: string): string | undefined => {
  const t = row.querySelector(`.${cls}`)?.textContent?.trim()
  return t === undefined || t === '' ? undefined : t
}

/**
 * The second sheet: which crate. Reached only from the first one, and it
 * closes the first by opening — one sheet at a time, because a stack of
 * sheets on a phone is a member who cannot tell what dismissing one will
 * reveal.
 */
function openCrateSheet(row: HTMLElement, from: HTMLElement): void {
  void loadCrateList().then((crates) => {
    populateCratePickers(crates)
    openActionSheet({
      title: 'Add to a crate',
      returnFocusTo: from,
      rows: crates.length === 0
        ? [{ id: 'none', label: 'No crates yet — make one on the track page', disabled: true }]
        : crates.map((c) => ({ id: c.id, label: c.name, icon: 'crate' as const })),
      onChoose: (id) => {
        // The row's OWN option button, clicked. addToCrate() is called in
        // exactly one place in this file and this is not it.
        const opt = row.querySelector<HTMLButtonElement>(
          `details.cratepick button.cratepick-option[data-crate-id="${CSS.escape(id)}"]`,
        )
        opt?.click()
      },
    })
  })
}

function openRowSheet(btn: HTMLElement): void {
  const row = btn.closest<HTMLElement>('[data-play-row]')
  if (row === null) return
  const play = row.querySelector<HTMLAnchorElement>('a.play[data-track-id]')
  const fileId = play?.dataset.trackId
  if (play === null || fileId === undefined) return

  const like = row.querySelector<HTMLFormElement>('form.likeform')
  const likeBtn = like?.querySelector<HTMLButtonElement>('button.likebtn')
  const liked = likeBtn?.getAttribute('aria-pressed') === 'true'
  const queueadd = row.querySelector<HTMLButtonElement>('button.queueadd')
  const hasCrates = row.querySelector('details.cratepick') !== null
  /**
   * THE ONE CONTEXTUAL ENTRY, and it is contextual by DATA rather than by
   * a page check. `form.removeform` is rendered only by /crate/[id], and
   * only for the crate's owner — so asking the row whether it has one is
   * the same question as "may this member remove this from this crate",
   * already answered by the server. The sheet never learns what a crate
   * is, and there is no `if (page === 'crate')` anywhere.
   */
  const removeForm = row.querySelector<HTMLFormElement>('form.removeform')

  openActionSheet({
    title: play.dataset.title ?? 'Track',
    returnFocusTo: btn,
    rows: [
      { id: 'play', label: 'Play', icon: 'play' },
      queueadd !== null && { id: 'queue', label: 'Add to queue', icon: 'queue-add' },
      like !== null && {
        id: 'like', label: liked ? 'Unlike' : 'Like', icon: 'heart', pressed: liked,
        meta: likeBtn?.querySelector('.likecount')?.textContent?.trim(),
      },
      hasCrates && { id: 'crate', label: 'Add to a crate…', icon: 'crate' },
      { id: 'download', label: 'Download', icon: 'download', href: `/api/track/${fileId}/download` },
      { id: 'open', label: 'Open track page', href: `/track/${fileId}` },
      // `danger` only — `isLast` is derived by normalizeRows(), not given.
      removeForm !== null && {
        id: 'remove', label: 'Remove from crate', icon: 'close' as const, danger: true,
      },
      ...ROW_META.map(([cls, label]) => {
        const value = cellText(row, cls)
        return value === undefined ? null : { id: cls, label, meta: value, disabled: true }
      }),
    ],
    onChoose: (id) => {
      if (id === 'play') play.click()
      if (id === 'queue') queueadd?.click()
      // requestSubmit, never submit(): submit() fires no submit event, so
      // the delegation that owns the ♥ would never see it and the form
      // would POST as a full navigation instead.
      if (id === 'like') like?.requestSubmit()
      if (id === 'crate') openCrateSheet(row, btn)
      // requestSubmit for the same reason the ♥ uses it: submit() fires no
      // submit event, so the delegated confirm() that guards this form
      // would never run and the POST would go unguarded.
      if (id === 'remove') removeForm?.requestSubmit()
    },
  })
}

document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest?.('button.rowmenu')
  if (!(btn instanceof HTMLButtonElement)) return
  e.preventDefault()
  openRowSheet(btn)
}, true)

/* ============================================================
   THE NAV'S SEARCH ICON — THE ONE LAZY CHUNK
   ============================================================
   `await import()`, and the await is the entire point. Shell.astro mounts
   on every page, so a STATIC import of search-overlay here would ship the
   overlay, its renderer and its fetch client to /login and to every page a
   member never searches from — the same regression shell-bundle.test.ts
   already guards for the queue engine, arriving by a different door.
   Rollup emits a dynamic import as its own chunk, so the cost is paid on
   the first tap of the icon and never again.
   src/lib/search-bundle.test.ts fails the build if this becomes static.

   THE TRIGGER IS AN <a href="/pool">, AND CANCELLING IT IS THE POINT —
   the same shape as the nav's ⋮. With JS this opens the overlay; without
   it, the anchor navigates to /pool's server-rendered filter, which is
   still a working search. Nothing here is a control that does nothing.

   A modified click is left alone: cmd/ctrl/shift/middle-click on a link
   means "open /pool in a new tab", and hijacking that is the rudest thing
   a single-page script can do to a link. */
document.addEventListener('click', (e) => {
  const icon = (e.target as Element).closest?.('a.navsearch')
  if (!(icon instanceof HTMLAnchorElement)) return
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  e.preventDefault()
  void import('../lib/search-overlay')
    .then((m) => { if (!m.isSearchOpen()) m.openSearchOverlay(icon) })
    // The chunk failing to load is a network fault, not a bug to swallow:
    // fall back to the destination the anchor already names, which is the
    // no-JS path and a real search page.
    .catch(() => { window.location.href = icon.href })
}, true)
