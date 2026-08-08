// src/lib/pool-api.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { parseCamelot } from './track-format'
import { isUuid } from './upload-api'

/**
 * The pool's query contract, in one place. The Astro page parses the
 * request URL with it, the island serialises back into the address bar with
 * it, and both hand the result to the same RPC. Nothing here touches the
 * DOM or the network, so it is unit-testable under the node environment.
 */

export const POOL_SORTS = [
  'added_desc', 'bpm_asc', 'key_asc', 'artist_asc', 'duration_asc', 'tier_desc',
  'downloads_desc', 'likes_desc', 'plays_desc',
  // POOL.1 / migration 37. A real keyset sort key, not a special case: the
  // score is folded into the same zero-padded text cursor every other sort
  // uses, so a ranked view pages like any other. With no free text the RPC
  // degrades it to added_desc, which is why `impliedSort` below never
  // offers it for an empty box.
  'relevance',
] as const
export type PoolSort = (typeof POOL_SORTS)[number]

export const DEFAULT_SORT: PoolSort = 'added_desc'
/** One page. 2k tracks is ~20 pages; see the no-virtualiser decision. */
export const PAGE_SIZE = 100
const MAX_Q_LENGTH = 120
const MAX_BPM = 1000

/**
 * THE SORT A PAGE MEANS WHEN NOBODY SAID. Browsing is newest-first;
 * searching is best-first. Making this a function rather than one constant
 * is what lets the URL stay clean in BOTH states — `?q=bicep` needs no
 * `&sort=relevance` glued to it, and clearing the box does not leave a
 * relevance sort behind ranking nothing.
 *
 * An explicit `?sort=` always wins, in either state, which is how a member
 * sorts search results by tempo.
 */
export function impliedSort(q: string): PoolSort {
  return q === '' ? DEFAULT_SORT : 'relevance'
}

/** The Astro partial /pool fetches for instant results. Named once so the
 *  route, the client and the guard test cannot drift apart. */
export const POOL_PARTIAL_PATH = '/partials/pool-rows'

export type PoolQuery = {
  q: string
  bpmMin: number | null
  bpmMax: number | null
  halfDouble: boolean
  key: string | null
  harmonic: boolean
  tierMin: number | null
  uploader: string | null
  sort: PoolSort
}

export const EMPTY_QUERY: PoolQuery = {
  q: '', bpmMin: null, bpmMax: null, halfDouble: false,
  key: null, harmonic: false, tierMin: null, uploader: null, sort: DEFAULT_SORT,
}

export type PoolTrack = {
  file_id: string
  track_id: string | null
  uploaded_by: string
  uploader_name: string
  original_filename: string
  display_artist: string | null
  display_title: string
  container: string | null
  byte_size: number
  duration_ms: number | null
  bpm: number | null
  ibi_std_ms: number | null
  key_camelot: string | null
  key_open: string | null
  key_musical: string | null
  camelot_sort: number
  quality_tier: number | null
  lossy_ancestor: string | null
  meas_cutoff_hz: number | null
  integrated_lufs: number | null
  has_preview: boolean
  has_peaks: boolean
  has_thumb: boolean
  created_at: string
  row_cursor: string
  /** Migration 15b, coalesced to 0 server-side — never null. */
  download_count: number
  /** Migration 16, coalesced to '{}' server-side — never null, may be empty. */
  tags: string[]
  /** Migration 26, coalesced server-side — never null. */
  like_count: number
  /** Migration 26, coalesced server-side — never null. */
  liked_by_me: boolean
  /** Migration 26, coalesced server-side — never null. */
  play_count: number
}

const numberIn = (raw: string | null, lo: number, hi: number): number | null => {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(n, lo), hi)
}

const flag = (raw: string | null): boolean => raw === '1' || raw === 'true'

/**
 * Total, never throws. A hand-edited or stale URL degrades to a weaker
 * filter rather than a 422 — pool_list() raises 22023 on an off-wheel key,
 * and that error has no business reaching a reader who clicked a bookmark.
 */
export function parsePoolQuery(sp: URLSearchParams): PoolQuery {
  const key = parseCamelot(sp.get('key'))
  const sortRaw = sp.get('sort')
  const uploader = sp.get('uploader')
  const tier = numberIn(sp.get('tier_min'), 1, 5)
  const q = (sp.get('q') ?? '').trim().slice(0, MAX_Q_LENGTH)
  return {
    q,
    bpmMin: numberIn(sp.get('bpm_min'), 0, MAX_BPM),
    bpmMax: numberIn(sp.get('bpm_max'), 0, MAX_BPM),
    halfDouble: flag(sp.get('half_double')),
    key: key === null ? null : `${key.num}${key.letter}`,
    harmonic: flag(sp.get('harmonic')),
    tierMin: tier === null ? null : Math.round(tier),
    uploader: isUuid(uploader) ? uploader : null,
    sort: (POOL_SORTS as readonly string[]).includes(sortRaw ?? '')
      ? (sortRaw as PoolSort)
      : impliedSort(q),
  }
}

/** Only non-default values are emitted, so the unfiltered pool has a clean URL. */
export function poolQueryToSearchParams(q: PoolQuery): URLSearchParams {
  const sp = new URLSearchParams()
  if (q.q !== '') sp.set('q', q.q)
  if (q.bpmMin !== null) sp.set('bpm_min', String(q.bpmMin))
  if (q.bpmMax !== null) sp.set('bpm_max', String(q.bpmMax))
  if (q.halfDouble) sp.set('half_double', '1')
  if (q.key !== null) sp.set('key', q.key)
  if (q.harmonic) sp.set('harmonic', '1')
  if (q.tierMin !== null) sp.set('tier_min', String(q.tierMin))
  if (q.uploader !== null) sp.set('uploader', q.uploader)
  // Against the IMPLIED default, not the constant one — otherwise every
  // search URL grows a `&sort=relevance` that says nothing, and every URL
  // that has one keeps it after the box is cleared.
  if (q.sort !== impliedSort(q.q)) sp.set('sort', q.sort)
  return sp
}

/**
 * Sort order is not a filter: re-sorting an empty pool still shows an empty
 * pool, so `EmptyState` must say "nothing here yet" and not "no matches".
 */
export function isDefaultQuery(q: PoolQuery): boolean {
  return q.q === '' && q.bpmMin === null && q.bpmMax === null &&
    q.key === null && q.tierMin === null && q.uploader === null
}

/**
 * Migration 37's two new arguments, and they are OPT-IN on purpose.
 *
 * `pool_list` defaults both to their pre-migration behaviour, so a caller
 * that says nothing keeps listing FILES with a substring `p_q`. Exactly ONE
 * caller says nothing now, and it must keep saying nothing:
 *
 *   - `/api/queue/candidates`, which does not use this builder at all —
 *     `candidateArgs` in queue-candidates.ts builds its own object, and
 *     three tests pin that it names neither key. A silent change to the
 *     queue's candidate source is the "wrong song plays" failure class.
 *     The queue picks a FILE to stream, so per-file is the correct shape
 *     there and always was.
 *
 * Every HUMAN-FACING list collapses, through one of the three named
 * builders below. `mode` is the /artist/[name] hazard, answered: that page
 * calls this with the artist's NAME as `p_q`, and in fuzzy mode `808 State`
 * would route its first word to a tempo window and `4B` to a Camelot key.
 * Substring is the default and the artist page never overrides it.
 */
export type PoolListOpts = {
  /** One row per recording (migration 34's face-file rule). */
  collapse?: boolean
  /** 'fuzzy' = ranked trigram search with token routing. */
  mode?: 'substring' | 'fuzzy'
}

export function poolListArgs(
  q: PoolQuery, cursor: string | null, limit: number, opts: PoolListOpts = {},
): Record<string, unknown> {
  return {
    p_q: q.q === '' ? null : q.q,
    p_bpm_min: q.bpmMin,
    p_bpm_max: q.bpmMax,
    p_half_double: q.halfDouble,
    p_key: q.key,
    p_harmonic: q.harmonic,
    p_tier_min: q.tierMin,
    p_uploader: q.uploader,
    p_sort: q.sort,
    p_cursor: cursor,
    p_limit: limit,
    p_collapse: opts.collapse ?? false,
    p_q_mode: opts.mode ?? 'substring',
  }
}

/**
 * THE POOL PAGE'S OWN CALL, in one place because two routes make it: the
 * page itself and the partial it fetches for instant results. If those two
 * ever disagreed, typing a character would change more than the rows.
 *
 * Collapse is ON — the owner's decision, and the other encodes stay
 * reachable from the track page. The mode follows the box: an empty query
 * has nothing to rank, and `p_q => null` makes the mode moot anyway, so
 * substring is the honest value to send rather than a fuzzy call with no
 * text in it.
 */
export function poolPageArgs(
  q: PoolQuery, cursor: string | null, limit: number,
): Record<string, unknown> {
  return poolListArgs(q, cursor, limit, {
    collapse: true,
    mode: q.q === '' ? 'substring' : 'fuzzy',
  })
}

/* ═══════════════════ THE COLLAPSE ROLLOUT, FINISHED ═══════════════════
 *
 * OWNER, 2026-08-08, verbatim: "I still see repeats".
 *
 * Migration 37 gave `pool_list` a `p_collapse`, and POOL.1 wired it into
 * /pool and its partial ONLY. `/artist/[name]` and `/member/[username]`
 * render the same `TrackRow` from the same RPC and were left per-file, so
 * a merged pair still showed twice on both — which is precisely what the
 * owner is looking at. `/artist/[name]`'s own frontmatter predicted this
 * fix and named the argument that would land it.
 *
 * Each surface gets a NAMED builder rather than an inline `{collapse:true}`
 * for the reason `poolPageArgs` exists: the page and its test then read the
 * same object, and "which surfaces collapse" is one greppable list instead
 * of a property spread across four files.
 *
 * ─── WHAT COLLAPSE COSTS ON A MEMBER PAGE, STATED RATHER THAN DISCOVERED
 *
 * `track_face_file()` elects ONE file per recording across the WHOLE pool,
 * not within the filtered set. `pool_list` applies that predicate and the
 * `p_uploader` filter in the same WHERE clause, so on a member page the
 * face file is still chosen globally. Consequence: if Ana uploaded the
 * FLAC (the face) and Ben the MP3 of one recording, Ben's page loses that
 * row entirely — it under-reports his contribution rather than merely
 * de-duplicating it.
 *
 * Accepted, for three reasons that were checked rather than assumed:
 *
 *   1. `/pool?uploader=<id>` ALREADY behaves exactly this way — POOL.1
 *      shipped it — and the member page links straight to it ("see all in
 *      pool"). Leaving the two disagreeing is a worse defect than the one
 *      being traded away: the same question, asked two ways, answered two
 *      ways.
 *   2. The row is not lost, it is MOVED. /track/[id]'s Formats section
 *      (this branch, part 2) lists every pool-visible encode of the
 *      recording with its uploader linkified, so Ben's MP3 is one click
 *      from the row that replaced it and still says his name.
 *   3. The heading above the list is `member_resolve`'s `track_count`,
 *      which counts CLAIMS (distinct stored files claimed via
 *      file_claims), and a co-claim on a merged pair already made that
 *      number differ from the row count. The list was never the heading's
 *      arithmetic.
 *
 * The proper fix is a collapse scoped to the filtered set — "the best row
 * among the rows this query would return". That is a different predicate
 * from migration 34's, so it is a migration and a doctrine change, not an
 * argument; it is not in scope for an owner bug report that says "repeats".
 */

/**
 * `/artist/[name]`. Collapse ON; mode stays SUBSTRING — never fuzzy.
 * The argument is the artist's name, and fuzzy tokenising would route
 * `/artist/808 State` to a tempo window and `/artist/4B` to a Camelot key.
 * See the PoolListOpts note above and this page's own frontmatter.
 */
export function artistPageArgs(name: string, limit: number): Record<string, unknown> {
  return poolListArgs(
    { ...EMPTY_QUERY, q: name, sort: 'added_desc' }, null, limit, { collapse: true },
  )
}

/**
 * `/member/[username]`'s track list. Collapse ON, uploader-filtered, and
 * substring mode because there is no free text at all — `p_q` is null, so
 * the mode is moot and `substring` is the honest value to send.
 */
export function memberPageArgs(userId: string, limit: number): Record<string, unknown> {
  return poolListArgs({ ...EMPTY_QUERY, uploader: userId }, null, limit, { collapse: true })
}

/* ═══════════════════════════ ARTIST PAGES, STRING-KEYED ══════════════
 *
 * THERE IS NO ARTIST TABLE, AND THIS DELIBERATELY DOES NOT ADD ONE.
 *
 * `display_artist` is a DERIVED text column (migration 11): a tag lookup
 * over artist/ARTIST/TPE1/albumartist/ALBUMARTIST, falling back to the
 * "Artist - Title" split of the filename, else NULL. Two files by the same
 * act agree only as far as their tags agree, and nothing reconciles
 * "Bicep" with "BICEP" beyond case.
 *
 * So an artist here is A STRING, and the route is keyed by it. The whole
 * data path is `pool_list(p_q => name)` — the substring search it already
 * has, over the pool it already filters — plus an exact, case-insensitive
 * match applied to the rows that come back. No migration, no new RPC, no
 * new grant, and nothing to keep in sync with `pool_visible_states()`:
 * tombstones, unclaimed uploads and every other visibility rule are
 * enforced once, in the function that already enforces them.
 *
 * WHAT THIS COSTS, stated rather than discovered later. `p_q` is a
 * substring match across artist, title, filename AND tags, and the server
 * clamps `p_limit` to 200. A page therefore sees at most 200 CANDIDATES
 * before the exact filter runs, so an artist whose name is also a common
 * substring of other tracks' titles could be truncated. At the pool's
 * present scale (hundreds of tracks) that cannot bite; it is why
 * `ARTIST_CANDIDATE_LIMIT` is named here rather than inlined, so the
 * bound is one edit when it does.
 *
 * THE M7 UPGRADE PATH. When canonical artist ids arrive, this becomes a
 * join and the route key becomes an id. The two functions below are the
 * whole seam: `artistHref` stops encoding a name and starts naming an id,
 * `matchesArtist` disappears into the query. Nothing else in the app
 * knows how an artist page is addressed — every caller builds its href
 * through `artistHref`, which is the reason it exists as a function
 * instead of a template literal at five call sites.
 */

/** `pool_list` clamps `p_limit` to 200; asking for more is silently less. */
export const ARTIST_CANDIDATE_LIMIT = 200

/**
 * The route for an artist name.
 *
 * ENCODED, and the member-page precedent is why: `4b1424e` fixed exactly
 * this bug for member links, where an email-fallback username containing
 * a `.` or a `+` produced an href that resolved somewhere else. An artist
 * name is far more hostile than a username — it is whatever a tag says,
 * and `AC/DC` alone would silently become a two-segment path.
 */
export function artistHref(name: string): string {
  return `/artist/${encodeURIComponent(name)}`
}

/**
 * Does this row's `display_artist` name that artist?
 *
 * Case-insensitive and whitespace-trimmed, because the tags are written by
 * hand and "Bicep", "bicep" and "Bicep " are one act. Deliberately NOT
 * fuzzy beyond that: `pool_list` already returned these rows on a
 * SUBSTRING match, so "Bicep" would otherwise collect "Bicep Remix" and
 * every track whose title merely contains the word. The RPC widens; this
 * narrows back to exact.
 *
 * A NULL artist never matches. There is no page for the "Unknown artist"
 * bucket — it is not one artist, it is every file whose tags failed, and
 * listing them together would assert a relationship that does not exist.
 */
export function matchesArtist(displayArtist: string | null, name: string): boolean {
  if (displayArtist === null) return false
  return displayArtist.trim().toLowerCase() === name.trim().toLowerCase()
}

/**
 * The pool page's only link builder. Sort links restart paging on purpose —
 * a keyset cursor is only valid within the sort that minted it, so a sort
 * change never carries `cursor`. The next-page link carries both.
 *
 * M6c Task 2: the table moved off "/" (now the home feed) to "/pool" — every
 * href this function mints follows it, so FilterBar/TrackTable/EmptyState
 * never hand out a stale bare-"/" link.
 */
export function poolHref(
  q: PoolQuery, opts: { sort?: PoolSort; cursor?: string } = {},
): string {
  const sp = poolQueryToSearchParams(opts.sort === undefined ? q : { ...q, sort: opts.sort })
  if (opts.cursor !== undefined) sp.set('cursor', opts.cursor)
  const s = sp.toString()
  return s === '' ? '/pool' : `/pool?${s}`
}

/**
 * The same query, addressed to the Astro partial instead of the page.
 *
 * ONE FUNCTION, TWO ADDRESSES, and that is the whole reason instant results
 * are not a second renderer. `/partials/pool-rows` runs the same
 * frontmatter and renders the same `<TrackTable>` as `/pool` — so a row
 * that appears while you type is byte-identical to the row the server would
 * have sent, `data-queue-list` and all. There is no client-side row
 * builder to drift (the retired search overlay had one, hand-maintained
 * against TrackRow.astro's markup contract).
 *
 * Takes raw params rather than a PoolQuery because its caller is the
 * browser reading its own form, and re-parsing what the form already says
 * would be a second interpretation of the same fields.
 */
export function poolPartialHref(sp: URLSearchParams): string {
  const s = sp.toString()
  return s === '' ? POOL_PARTIAL_PATH : `${POOL_PARTIAL_PATH}?${s}`
}

/**
 * feed_tracks()'s row shape (migration 31): pool_get()'s entire column
 * list, same convention as org-api.ts's CrateItem for crate_get() rows.
 * Only the subset FeedRow.astro (via PoolTrack) actually reads is typed
 * here — feed_tracks returns many more columns (analysis internals,
 * batch/claim provenance) the home feed has no use for.
 */
export type FeedTrack = {
  file_id: string
  track_id: string | null
  uploaded_by: string
  uploader_name: string
  original_filename: string
  display_artist: string | null
  display_title: string
  container: string | null
  byte_size: number
  duration_ms: number | null
  bpm: number | null
  ibi_std_ms: number | null
  key_camelot: string | null
  key_open: string | null
  key_musical: string | null
  quality_tier: number | null
  lossy_ancestor: string | null
  meas_cutoff_hz: number | null
  integrated_lufs: number | null
  /** Non-null means the object exists in R2 — same convention pool_get uses. */
  preview_key: string | null
  peaks_key: string | null
  thumb_key: string | null
  created_at: string
  download_count: number
  tags: string[]
  like_count: number
  liked_by_me: boolean
  play_count: number
}

/**
 * Adapts a feed_tracks() row onto PoolTrack so FeedRow.astro can render it
 * the same way TrackRow.astro renders a pool_list() row — same
 * has_preview/has_peaks/has_thumb derivation from the raw *_key columns as
 * org-api.ts's crateItemToPoolTrack, since feed_tracks and crate_get share
 * pool_get()'s exact column shape. camelot_sort/row_cursor get the same
 * harmless placeholders that adapter uses: the feed never sorts or paginates
 * by them.
 */
export function feedTrackToPoolTrack(t: FeedTrack): PoolTrack {
  return {
    file_id: t.file_id,
    track_id: t.track_id,
    uploaded_by: t.uploaded_by,
    uploader_name: t.uploader_name,
    original_filename: t.original_filename,
    display_artist: t.display_artist,
    display_title: t.display_title,
    container: t.container,
    byte_size: t.byte_size,
    duration_ms: t.duration_ms,
    bpm: t.bpm,
    ibi_std_ms: t.ibi_std_ms,
    key_camelot: t.key_camelot,
    key_open: t.key_open,
    key_musical: t.key_musical,
    camelot_sort: 0,
    quality_tier: t.quality_tier,
    lossy_ancestor: t.lossy_ancestor,
    meas_cutoff_hz: t.meas_cutoff_hz,
    integrated_lufs: t.integrated_lufs,
    has_preview: t.preview_key !== null,
    has_peaks: t.peaks_key !== null,
    has_thumb: t.thumb_key !== null,
    created_at: t.created_at,
    row_cursor: t.file_id,
    download_count: t.download_count,
    tags: t.tags,
    like_count: t.like_count,
    liked_by_me: t.liked_by_me,
    play_count: t.play_count,
  }
}
