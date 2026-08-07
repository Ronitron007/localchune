// src/lib/queue-view.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * M6b — THE PURE HALF OF THE QUEUE'S DOM LAYER.
 *
 * site.ts owns the DOM: listeners, `dataset` reads, `textContent` writes.
 * vitest here runs `environment: 'node'`, so none of that is testable in this
 * repo — the same split player-memory.ts and upload-journal.ts already record.
 * What IS testable is every decision site.ts makes on the way in and on the
 * way out, so those decisions live here and site.ts stays a thin caller:
 *
 *   IN   `readListContext` — a row set plus the clicked id become a list, an
 *        index and a source label. site.ts's job shrinks to scraping
 *        `dataset` into plain records.
 *   TIME `nextSourceLookahead` — the T-20 s band predicate for the signed-URL
 *        prefetch.
 *   OUT  `appendReport` — the exact status string for an append, including the
 *        partial one. §1.2: "Silent partial success is the one outcome this
 *        must not have", so the sentence that prevents it is a tested value,
 *        not an inline template literal in a click handler.
 *
 * Imports queue-model.ts and NOTHING ELSE, for the same reason queue-store.ts
 * does: whatever the drawer's render path imports is shipped to every page.
 */

import {
  METHOD_LABELS, QUEUE_MAX, type QueueEntry, type QueueOrigin, type QueueState,
} from './queue-model'

/** How early the next entry's signed URL is fetched. A URL held for twenty
 *  seconds cannot meaningfully expire (presigned GETs live an hour), and it is
 *  long enough that the advance is instant rather than a round trip between
 *  tracks. A second <audio> element for true gapless playback is out of
 *  scope. */
export const LOOKAHEAD_S = 20

/**
 * One row as site.ts scrapes it off `dataset` — every field a string, because
 * that is what the DOM stores — or as a JSON route sends it, where the numbers
 * are already numbers. Both shapes parse the same way, so the crate route and
 * the pool table share one code path.
 */
export interface QueueRowData {
  file_id: string
  artist?: string | null
  title?: string | null
  duration_ms?: string | number | null
  bpm?: string | number | null
  key_camelot?: string | null
}

/** `''`, `'  '`, `'n/a'`, `undefined` and `null` are all "no value", never
 *  NaN: the strategies price a null bpm through UNKNOWN_BPM_PENALTY and would
 *  silently rank a NaN as worse than anything. */
const numOrNull = (v: string | number | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const strOrNull = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** The six keys `/api/crate/[id]/tracks` puts on the wire, in one place so the
 *  route, the projection and the test cannot drift apart — the same discipline
 *  TRACK_FEATURE_KEYS holds for the candidate route. */
export const CRATE_TRACK_KEYS = [
  'file_id', 'artist', 'title', 'duration_ms', 'bpm', 'key_camelot',
] as const

/**
 * A `crate_get` row down to what a queue entry needs. Written as an explicit
 * object rather than a pick-list loop so that adding a field is a deliberate
 * edit somebody has to justify — `crate_get` returns pool_get's whole column
 * list, including the original filename and every artifact key, and none of it
 * belongs in a browser that only wants to queue the track.
 */
export function toCrateTrack(row: Record<string, unknown>): QueueRowData {
  return {
    file_id: String(row.file_id),
    artist: typeof row.display_artist === 'string' ? row.display_artist : null,
    title: typeof row.display_title === 'string' ? row.display_title : '',
    duration_ms: numOrNull(row.duration_ms as string | number | null),
    bpm: numOrNull(row.bpm as string | number | null),
    key_camelot: typeof row.key_camelot === 'string' ? row.key_camelot : null,
  }
}

export function toQueueEntry(
  row: QueueRowData, origin: QueueOrigin, label: string | null,
): QueueEntry {
  return {
    file_id: row.file_id,
    display_artist: strOrNull(row.artist),
    display_title: typeof row.title === 'string' ? row.title : '',
    duration_ms: numOrNull(row.duration_ms),
    bpm: numOrNull(row.bpm),
    key_camelot: strOrNull(row.key_camelot),
    origin,
    source_label: label,
  }
}

/**
 * A QueueEntry for a track the RESUME path put into the transport, built from
 * the only two things player memory holds: the file id and the label.
 *
 * WHY THE ARTIST IS NULL. player-memory.ts stores `title` as the player bar
 * renders it — already "Artist — Title" — so splitting it back apart would
 * mean guessing at an em dash that can legitimately appear inside either half.
 * `entryTitle` joins on exactly the same rule, so a null artist here renders
 * the stored label verbatim in the drawer and in the status region: identical
 * text, no guess.
 *
 * WHY bpm/key ARE NULL, AND WHY THAT IS SURVIVABLE. Player memory never had
 * them. A seed without them scores every candidate identically, so only the
 * FIRST auto pick is arbitrary — `greedyWalk` re-seeds from each pick, so the
 * chain is harmonic again from the second entry on. The alternative was a
 * metadata request on every returning member's first paint, which is the one
 * thing §5's deferral exists to prevent. Full metadata arrives by itself the
 * moment anything goes through the engine: queue memory carries it, and
 * RESTORE_CURRENT never overwrites a current that is already there.
 */
export function resumedEntry(fileId: string, title: string): QueueEntry {
  return {
    file_id: fileId,
    display_artist: null,
    display_title: title,
    duration_ms: null,
    bpm: null,
    key_camelot: null,
    origin: 'current',
    source_label: null,
  }
}

/**
 * The list a play click means. `index` is where the clicked track sits in it;
 * `reduce`'s PLAY_TRACK takes everything AFTER that index as the new layer 1.
 *
 * Deduped by file_id here rather than left to `reduce`, because the reducer
 * dedupes the intent layer AFTER resolving the index — a list with the same
 * file twice would give the right entry the wrong position. A row with no
 * file_id is dropped for the same reason: it would shift every index after it.
 *
 * `index === -1` means the clicked row was not in the container (a stale DOM,
 * or a play link outside any `[data-queue-list]`). The caller plays the track
 * alone rather than guessing — `reduce` itself no-ops on a negative index.
 */
export function readListContext(
  rows: readonly QueueRowData[], fileId: string, sourceLabel: string | null,
): { list: QueueEntry[]; index: number; source_label: string | null } {
  const seen = new Set<string>()
  const list: QueueEntry[] = []
  for (const row of rows) {
    if (typeof row.file_id !== 'string' || row.file_id === '') continue
    if (seen.has(row.file_id)) continue
    seen.add(row.file_id)
    list.push(toQueueEntry(row, 'list', sourceLabel))
  }
  return { list, index: list.findIndex((e) => e.file_id === fileId), source_label: sourceLabel }
}

/**
 * True inside the last `LOOKAHEAD_S` of a track. PURE, so it is true on EVERY
 * tick in the band, not once — site.ts holds the "have I already prefetched
 * this entry" flag, keyed on the next entry's file_id, so that a regeneration
 * which changes `queue[1]` re-arms the prefetch instead of holding a URL for a
 * track that is no longer next.
 *
 * False at and past the end: `ended` owns that moment. False for a NaN
 * duration (before loadedmetadata) and for an infinite one (a live stream).
 */
export function nextSourceLookahead(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false
  if (!Number.isFinite(currentTime) || currentTime < 0) return false
  const remaining = duration - currentTime
  return remaining > 0 && remaining <= LOOKAHEAD_S
}

/**
 * `warehouse · 24 of 60` — the plan's string, character for character.
 *
 * DO NOT "FIX" THE OFF-BY-ONE. Playing a 60-track crate leaves the queue
 * holding 25 of them: 24 pinned in layer 1 plus the one that is playing. This
 * line counts the INTENT LAYER, which is what `reduce` reports as
 * `added`/`offered`, and 24 is the honest number for "how many of that crate
 * are waiting". Rewriting it as 25 would make it disagree with the reducer.
 */
export function truncationLine(t: { label: string | null; added: number; offered: number }): string {
  const count = `${t.added} of ${t.offered}`
  return t.label === null || t.label === '' ? count : `${t.label} · ${count}`
}

/**
 * Whether a write is worth a truncation line at all — and it is NOT simply
 * `added < offered`.
 *
 * Playing the third row of an eight-row table adds five entries out of eight
 * offered, and nothing was truncated: the two rows ABOVE the clicked one were
 * never candidates. Reporting `pool · 5 of 8` there tells a member that three
 * tracks were dropped when none were, which is worse than saying nothing.
 *
 * `capReached` is the caller's answer to "does layer 1 now fill every slot" —
 * `slotsFor(state).need === 0`. That is the only condition under which the 25
 * cap is what stopped the write, and therefore the only one worth a line.
 */
export function truncationFor(
  outcome: { added?: number; offered?: number }, label: string | null, capReached: boolean,
): { label: string | null; added: number; offered: number } | null {
  const { added, offered } = outcome
  if (!capReached) return null
  if (added === undefined || offered === undefined || added >= offered) return null
  return { label, added, offered }
}

export interface AppendOutcome {
  /** How many entries entered the intent layer — `reduce`'s `added`. */
  added: number
  /** How many the caller offered — `reduce`'s `offered`. */
  offered: number
  /** The crate name, "pool", or null. */
  label: string | null
  /**
   * Whether the cap is what stopped the append. Defaults to true because the
   * cap is the ordinary reason, but a deduped entry is an `added: 0` with
   * plenty of room left, and blaming a full queue for it would be a lie the
   * user cannot act on.
   */
  full?: boolean
}

/**
 * The status line for an append, rendered into `#player-label` — the same
 * aria-live region the play, like and crate handlers already report through.
 *
 * §1.2 spells the partial case out: `added 4 of 17 from warehouse — queue is
 * full (25)`. It is quoted in the plan and asserted character for character in
 * this module's tests, because a partial append that reports nothing is the
 * exact failure the 25 cap would otherwise introduce.
 */
export function appendReport({ added, offered, label, full = true }: AppendOutcome): string {
  const from = label === null || label === '' ? '' : ` from ${label}`

  if (offered === 0) return `nothing to add${from}`
  if (added === 0) {
    if (!full) return offered === 1 ? 'already in the queue' : `nothing added${from}`
    return `queue is full (${QUEUE_MAX}) — nothing added${from}`
  }
  if (added < offered) {
    return full
      ? `added ${added} of ${offered}${from} — queue is full (${QUEUE_MAX})`
      : `added ${added} of ${offered}${from}`
  }
  return `added ${added} track${added === 1 ? '' : 's'}${from}`
}

// ------------------------------------------------------------- the drawer

/** Artist and title on one line, exactly as the player bar joins them, so a
 *  row in the drawer and the name in the status region read identically. */
export function entryTitle(e: QueueEntry): string {
  return e.display_artist === null || e.display_artist === ''
    ? e.display_title
    : `${e.display_artist} — ${e.display_title}`
}

export interface QueueRow {
  /**
   * THE INDEX INTO THE RENDERED ARRAY, and the drawer's entire contract with
   * the reducer: `SELECT_QUEUE_ENTRY {index}` and `REMOVE_QUEUE_ENTRY {index}`
   * are resolved against the same array these rows were built from. Row 3 must
   * mean queue[3] or a click plays the wrong track.
   */
  index: number
  entry: QueueEntry
  /** `current` is not removable — there is no REMOVE for what is playing;
   *  SKIP is that gesture. Everything behind it is. */
  removable: boolean
  /**
   * LAYER 1 ONLY. True for exactly the rows `MOVE_QUEUE_ENTRY` can act on, so
   * the drawer renders a drag handle on those rows and on no others.
   *
   * It is not the same question as `removable`, and rendering one control off
   * the other answer is how the drawer ended up shipping ↑/↓ buttons on auto
   * rows that the engine then refused — a control that is drawn, enabled-
   * looking and inert. `current` is neither removable nor reorderable; an
   * auto row is removable but NOT reorderable, because layer 2 is rebuilt from
   * scratch on every regeneration and has no order anyone owns; a pin is both.
   *
   * The three-line answer lives here rather than in site.ts for the reason
   * every other decision does: site.ts cannot be imported under node, so a
   * rule expressed there is a rule nothing can test.
   */
  reorderable: boolean
}

export interface QueueSection {
  id: 'now' | 'yours' | 'auto'
  title: string
  rows: QueueRow[]
  /** The one line under the heading: a truncation count, an explanation for an
   *  empty section, or nothing. */
  note: string | null
}

export interface RenderOptions {
  /** From the last write that did not fit — `warehouse · 24 of 60`. */
  truncation?: { label: string | null; added: number; offered: number } | null
  /** Why the last regeneration produced no tail. `regenerate` swallows a port
   *  failure by design and returns a tail-less queue with no exception, so
   *  without this an unreachable pool and an exhausted one look identical. */
  candidateError?: string | null
}

/**
 * THE SEAM, MADE VISIBLE. Three labelled sections — NOW PLAYING, YOUR QUEUE,
 * UP NEXT · AUTO — because they are three real fields of `QueueState`, not
 * three CSS classes over one array. A member has to be able to see at a glance
 * which part of what they are looking at survives a strategy switch, and the
 * answer (all of layer 1, none of layer 2) is only obvious if the boundary is
 * drawn.
 *
 * MEMBERSHIP COMES FROM `state.intent`, NOT FROM `entry.origin`. The origin is
 * a provenance label a persisted entry could carry from an older build; the
 * intent layer is the authority on what is pinned, and it is what `reduce`
 * itself consults. The two agree today, and this function keeps working the
 * day they do not.
 *
 * Pure: takes the rendered array and the state, returns a description. It does
 * not touch the DOM, and it imports queue-model alone — whatever the drawer's
 * render path imports is shipped to every page in the app.
 */
export function renderQueueSections(
  queue: readonly QueueEntry[], state: QueueState, opts: RenderOptions,
): QueueSection[] {
  const pinned = new Set(state.intent.map((e) => e.file_id))
  const now: QueueRow[] = []
  const yours: QueueRow[] = []
  const auto: QueueRow[] = []

  queue.forEach((entry, index) => {
    if (index === 0 && state.current !== null) {
      now.push({ index, entry, removable: false, reorderable: false })
    } else if (pinned.has(entry.file_id)) {
      yours.push({ index, entry, removable: true, reorderable: true })
    } else {
      auto.push({ index, entry, removable: true, reorderable: false })
    }
  })

  const methodLabel = METHOD_LABELS[state.method]
  const failed = opts.candidateError ?? null

  return [
    {
      id: 'now',
      title: 'NOW PLAYING',
      rows: now,
      note: now.length === 0 ? 'Nothing playing.' : null,
    },
    {
      id: 'yours',
      title: 'YOUR QUEUE',
      rows: yours,
      // The truncation line belongs to layer 1: it counts what a play or an
      // append put there, and it is the only place the 36 tracks that did not
      // fit are ever mentioned.
      note: opts.truncation != null
        ? truncationLine(opts.truncation)
        : yours.length === 0 ? 'Nothing queued by hand.' : null,
    },
    {
      id: 'auto',
      title: `UP NEXT · AUTO — ${methodLabel}`,
      rows: auto,
      note: autoNote(state, auto.length, failed),
    },
  ]
}

/**
 * Why the auto section looks the way it does. Four distinct answers, and
 * collapsing them into one blank space is how "autoplay is off" gets mistaken
 * for "the mix is broken".
 *
 * A FAILED FETCH OUTRANKS EVERYTHING. An empty MIX section after a dropped
 * connection is not a musical dead end, and saying "nothing harmonically
 * close" there would be a diagnosis of the pool for a fault in the network.
 */
function autoNote(state: QueueState, tailLength: number, failed: string | null): string | null {
  if (failed !== null) return failed
  if (state.method === 'off') {
    return 'Autoplay is off. Playback stops when the queue runs out.'
  }
  if (tailLength > 0) return null
  if (state.current === null && state.intent.length === 0) {
    return 'Play something to seed the mix.'
  }
  // §1.3 cases 2-5: a small pool, a narrow band already exhausted this
  // session, or an unanalysed seed. All of them are "correct behaviour, not a
  // defect", and all of them look the same from here.
  return 'Nothing harmonically close is left in the pool.'
}
