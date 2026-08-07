// src/lib/pool-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  ARTIST_CANDIDATE_LIMIT, artistHref, EMPTY_QUERY, feedTrackToPoolTrack, impliedSort,
  isDefaultQuery, matchesArtist, parsePoolQuery, poolListArgs, poolPageArgs,
  poolPartialHref, POOL_PARTIAL_PATH,
  poolQueryToSearchParams, poolHref, type FeedTrack,
} from './pool-api'

const parse = (s: string) => parsePoolQuery(new URLSearchParams(s))

describe('parsePoolQuery', () => {
  it('returns the empty query for an empty URL', () => {
    expect(parse('')).toEqual(EMPTY_QUERY)
  })

  it('reads every filter', () => {
    expect(parse(
      'q=aphex&bpm_min=120&bpm_max=130&half_double=1&key=8a&harmonic=1' +
      '&tier_min=4&uploader=11111111-1111-1111-1111-111111111111&sort=bpm_asc',
    )).toEqual({
      q: 'aphex', bpmMin: 120, bpmMax: 130, halfDouble: true,
      key: '8A', harmonic: true, tierMin: 4,
      uploader: '11111111-1111-1111-1111-111111111111', sort: 'bpm_asc',
    })
  })

  it('drops an off-wheel key rather than sending it to the server', () => {
    // pool_list raises 22023 on a bad key. Filtering it here means a
    // hand-edited URL degrades to "no key filter" instead of a 422 page.
    expect(parse('key=13Q').key).toBeNull()
    expect(parse('key=').key).toBeNull()
  })

  it('clamps the bpm range and rejects nonsense', () => {
    expect(parse('bpm_min=-5').bpmMin).toBe(0)
    expect(parse('bpm_max=99999').bpmMax).toBe(1000)
    expect(parse('bpm_min=abc').bpmMin).toBeNull()
  })

  it('clamps the tier to the five that exist', () => {
    expect(parse('tier_min=0').tierMin).toBe(1)
    expect(parse('tier_min=9').tierMin).toBe(5)
    expect(parse('tier_min=x').tierMin).toBeNull()
  })

  it('falls back to the default sort for anything unknown', () => {
    expect(parse('sort=whatever').sort).toBe('added_desc')
    expect(parse('sort=tier_desc').sort).toBe('tier_desc')
  })

  it("accepts downloads_desc — migration 15b's new sort", () => {
    expect(parse('sort=downloads_desc').sort).toBe('downloads_desc')
  })

  it("accepts likes_desc and plays_desc — migration 26's new sorts", () => {
    expect(parse('sort=likes_desc').sort).toBe('likes_desc')
    expect(parse('sort=plays_desc').sort).toBe('plays_desc')
  })

  it('ignores an uploader that is not a uuid', () => {
    expect(parse('uploader=me').uploader).toBeNull()
  })

  it('trims and length-caps the text query', () => {
    expect(parse('q=%20%20xtal%20%20').q).toBe('xtal')
    expect(parse(`q=${'a'.repeat(300)}`).q.length).toBe(120)
  })
})

describe('poolQueryToSearchParams', () => {
  it('emits nothing at all for the default query', () => {
    // A clean URL for the unfiltered pool. Otherwise every visit rewrites
    // the address bar with eight empty parameters.
    expect(poolQueryToSearchParams(EMPTY_QUERY).toString()).toBe('')
  })

  it('round-trips every filter', () => {
    const q = parse(
      'q=aphex&bpm_min=120&bpm_max=130&half_double=1&key=8A&harmonic=1' +
      '&tier_min=4&uploader=11111111-1111-1111-1111-111111111111&sort=bpm_asc',
    )
    expect(parsePoolQuery(poolQueryToSearchParams(q))).toEqual(q)
  })

  it('omits half_double and harmonic when they are off', () => {
    const q = { ...EMPTY_QUERY, bpmMin: 120, bpmMax: 130 }
    expect(poolQueryToSearchParams(q).toString()).toBe('bpm_min=120&bpm_max=130')
  })
})

describe('isDefaultQuery', () => {
  it('is true only when nothing is filtered', () => {
    expect(isDefaultQuery(EMPTY_QUERY)).toBe(true)
    expect(isDefaultQuery({ ...EMPTY_QUERY, sort: 'bpm_asc' })).toBe(true)
    expect(isDefaultQuery({ ...EMPTY_QUERY, q: 'x' })).toBe(false)
    expect(isDefaultQuery({ ...EMPTY_QUERY, tierMin: 3 })).toBe(false)
  })
})

describe('poolListArgs', () => {
  it('maps onto the RPC parameter names, nulls included', () => {
    expect(poolListArgs(EMPTY_QUERY, null, 100)).toEqual({
      p_q: null, p_bpm_min: null, p_bpm_max: null, p_half_double: false,
      p_key: null, p_harmonic: false, p_tier_min: null, p_uploader: null,
      p_sort: 'added_desc', p_cursor: null, p_limit: 100,
      // Migration 37, and BOTH are the pre-migration behaviour spelled out.
      // A caller that says nothing about collapse or mode keeps listing
      // FILES with a substring `p_q`.
      p_collapse: false, p_q_mode: 'substring',
    })
  })

  it('passes an empty text query as null, not as an empty string', () => {
    expect(poolListArgs({ ...EMPTY_QUERY, q: '' }, null, 100).p_q).toBeNull()
  })

  /**
   * THE OPT-IN IS THE PROTECTION. Migration 37 added two arguments to a
   * function five surfaces call, and the defaults are what stop those
   * surfaces from changing under them. Each of these pins a caller whose
   * behaviour must NOT move.
   */
  it('defaults to per-file, substring — what /member/[username] needs', () => {
    // A member page lists what a member UPLOADED. Two encodes of one
    // recording are two uploads; collapsing them would under-report a
    // member's own contribution on their own page.
    const args = poolListArgs({ ...EMPTY_QUERY, uploader: 'u' }, null, 100)
    expect(args.p_collapse).toBe(false)
    expect(args.p_q_mode).toBe('substring')
  })

  it('never sends fuzzy for an artist name — the /artist/808 State hazard', () => {
    // ui-final-batch-report.md measured this off search_tracks()' body: a
    // `^[0-9]{2,3}$` word routes to a tempo window and `4b` to a Camelot
    // key. /artist/[name] passes the artist's NAME as p_q, so fuzzy mode
    // there would search for a tempo and lose the act entirely.
    expect(poolListArgs({ ...EMPTY_QUERY, q: '808 State' }, null, 200).p_q_mode)
      .toBe('substring')
    expect(poolListArgs({ ...EMPTY_QUERY, q: '4B' }, null, 200).p_q_mode)
      .toBe('substring')
  })

  it('takes both only when a caller asks', () => {
    const args = poolListArgs(EMPTY_QUERY, null, 100, { collapse: true, mode: 'fuzzy' })
    expect(args.p_collapse).toBe(true)
    expect(args.p_q_mode).toBe('fuzzy')
  })
})

describe('poolPageArgs — what /pool and its partial both send', () => {
  it('collapses to one row per recording in both states', () => {
    expect(poolPageArgs(EMPTY_QUERY, null, 100).p_collapse).toBe(true)
    expect(poolPageArgs({ ...EMPTY_QUERY, q: 'bicep' }, null, 100).p_collapse).toBe(true)
  })

  it('is substring for an empty box and fuzzy for a typed one', () => {
    expect(poolPageArgs(EMPTY_QUERY, null, 100).p_q_mode).toBe('substring')
    expect(poolPageArgs({ ...EMPTY_QUERY, q: 'bicep' }, null, 100).p_q_mode).toBe('fuzzy')
  })

  it('carries the cursor, so the ranked view pages like the browsed one', () => {
    const q = { ...EMPTY_QUERY, q: 'bicep', sort: 'relevance' as const }
    expect(poolPageArgs(q, 'CURSOR', 100)).toMatchObject({
      p_cursor: 'CURSOR', p_sort: 'relevance', p_q_mode: 'fuzzy', p_collapse: true,
    })
  })
})

describe('impliedSort — the sort a page means when nobody said', () => {
  it('is newest-first for browsing and best-first for searching', () => {
    expect(impliedSort('')).toBe('added_desc')
    expect(impliedSort('bicep')).toBe('relevance')
  })

  it('keeps both URLs clean', () => {
    // Neither state pays for a `&sort=` that says what the page would have
    // done anyway — and clearing the box does not leave a relevance sort
    // behind, ranking nothing.
    expect(poolHref({ ...EMPTY_QUERY, q: 'bicep', sort: 'relevance' })).toBe('/pool?q=bicep')
    expect(poolHref(EMPTY_QUERY)).toBe('/pool')
  })

  it('is overridden by an explicit sort, in either state', () => {
    expect(parsePoolQuery(new URLSearchParams('q=bicep&sort=bpm_asc')).sort).toBe('bpm_asc')
    expect(parsePoolQuery(new URLSearchParams('q=bicep')).sort).toBe('relevance')
    expect(parsePoolQuery(new URLSearchParams('')).sort).toBe('added_desc')
  })

  it('treats an empty sort param as a missing one', () => {
    // The Sort chip's implied option carries `value=""`, so a native submit
    // sends `sort=`. It must mean the same thing as sending nothing.
    expect(parsePoolQuery(new URLSearchParams('q=bicep&sort=')).sort).toBe('relevance')
    expect(parsePoolQuery(new URLSearchParams('sort=')).sort).toBe('added_desc')
  })
})

describe('poolPartialHref — the instant-results address', () => {
  it('is the partial path, never the page', () => {
    expect(poolPartialHref(new URLSearchParams())).toBe(POOL_PARTIAL_PATH)
    expect(poolPartialHref(new URLSearchParams('q=bicep&key=8A')))
      .toBe(`${POOL_PARTIAL_PATH}?q=bicep&key=8A`)
  })
})

describe('poolHref', () => {
  // M6c Task 2: the pool table moved off "/" (now the home feed) to
  // "/pool" — every sort/filter/cursor link this function builds must
  // follow it there.
  it('is a clean /pool for the default query', () => {
    expect(poolHref(EMPTY_QUERY)).toBe('/pool')
  })
  it('starts every href with /pool, never bare /', () => {
    expect(poolHref(EMPTY_QUERY, { sort: 'likes_desc' })).toBe('/pool?sort=likes_desc')
  })
  it('keeps the filters and swaps the sort, dropping any cursor', () => {
    const q = { ...EMPTY_QUERY, bpmMin: 120, sort: 'added_desc' as const }
    expect(poolHref(q, { sort: 'bpm_asc' })).toBe('/pool?bpm_min=120&sort=bpm_asc')
  })
  it('carries the cursor for the next page under the current sort', () => {
    const q = { ...EMPTY_QUERY, sort: 'bpm_asc' as const }
    expect(poolHref(q, { cursor: '00000123abc' }))
      .toBe('/pool?sort=bpm_asc&cursor=00000123abc')
  })
})

describe('feedTrackToPoolTrack', () => {
  // A full feed_tracks() row (migration 31) — pool_get()'s entire column
  // list, same shape org-api.ts's crateItemToPoolTrack adapts for
  // crate_get(). Only the fields FeedRow/PoolTrack reads are populated
  // here; every other pool_get column is irrelevant to the adapter.
  const ROW: FeedTrack = {
    file_id: '11111111-1111-1111-1111-111111111111',
    track_id: null,
    uploaded_by: '33333333-3333-3333-3333-333333333333',
    uploader_name: 'dj',
    original_filename: 'track.wav',
    display_artist: 'Artist',
    display_title: 'Title',
    container: 'wav',
    byte_size: 1000,
    duration_ms: 180_000,
    bpm: 128,
    ibi_std_ms: 2,
    key_camelot: '8A',
    key_open: null,
    key_musical: null,
    quality_tier: 5,
    lossy_ancestor: null,
    meas_cutoff_hz: null,
    integrated_lufs: -9,
    preview_key: 'preview/key',
    peaks_key: null,
    thumb_key: 'thumb/key',
    created_at: '2026-07-29T00:00:00Z',
    download_count: 3,
    tags: ['house'],
    like_count: 2,
    liked_by_me: true,
    play_count: 10,
  }

  it('derives has_preview/has_peaks/has_thumb from the *_key columns', () => {
    const track = feedTrackToPoolTrack(ROW)
    expect(track.has_preview).toBe(true)
    expect(track.has_peaks).toBe(false)
    expect(track.has_thumb).toBe(true)
  })

  it('carries every other FeedRow-relevant field through unchanged', () => {
    const track = feedTrackToPoolTrack(ROW)
    expect(track.file_id).toBe(ROW.file_id)
    expect(track.display_artist).toBe(ROW.display_artist)
    expect(track.display_title).toBe(ROW.display_title)
    expect(track.bpm).toBe(ROW.bpm)
    expect(track.key_camelot).toBe(ROW.key_camelot)
    expect(track.like_count).toBe(ROW.like_count)
    expect(track.liked_by_me).toBe(ROW.liked_by_me)
  })
})

/* ═══ artist pages, string-keyed ═══
 *
 * There is no artist table: `display_artist` is a derived text column, so
 * an artist IS a string and the route is keyed by one. These two functions
 * are the whole seam — when canonical ids land in M7, `artistHref` starts
 * naming an id and `matchesArtist` disappears into the query, and no call
 * site in the app changes because every link is built through the first. */

describe('artistHref', () => {
  it('points at the artist route', () => {
    expect(artistHref('Bicep')).toBe('/artist/Bicep')
  })

  it('encodes a name that would otherwise become two path segments', () => {
    // The member-page precedent (4b1424e) fixed exactly this for usernames.
    // An artist name is far more hostile — it is whatever a tag says — and
    // a slash is the case that silently resolves somewhere else entirely.
    expect(artistHref('AC/DC')).toBe('/artist/AC%2FDC')
  })

  it('encodes the rest of what a tag can contain', () => {
    expect(artistHref('Simon & Garfunkel')).toBe('/artist/Simon%20%26%20Garfunkel')
    expect(artistHref('?#')).toBe('/artist/%3F%23')
  })
})

describe('matchesArtist', () => {
  it('matches regardless of case — tags are written by hand', () => {
    expect(matchesArtist('Bicep', 'bicep')).toBe(true)
    expect(matchesArtist('BICEP', 'Bicep')).toBe(true)
  })

  it('ignores surrounding whitespace on either side', () => {
    expect(matchesArtist('Bicep ', 'Bicep')).toBe(true)
    expect(matchesArtist('Bicep', ' Bicep')).toBe(true)
  })

  it('narrows the RPC back to EXACT — this is its whole job', () => {
    // pool_list returned these rows on a SUBSTRING match across artist,
    // title, filename and tags. Without this, /artist/Bicep would list
    // every track whose title merely contains the word.
    expect(matchesArtist('Bicep Remix', 'Bicep')).toBe(false)
    expect(matchesArtist('Bicep', 'Bicep Remix')).toBe(false)
    expect(matchesArtist('Two Bicep', 'Bicep')).toBe(false)
  })

  it('never matches a null artist — "Unknown artist" is not an artist', () => {
    // It is not one act, it is every file whose tags failed and whose
    // filename would not split. Listing them together would assert a
    // relationship that does not exist, so there is no page for it.
    expect(matchesArtist(null, 'Bicep')).toBe(false)
    expect(matchesArtist(null, 'Unknown artist')).toBe(false)
  })
})

describe('the artist page asks pool_list for the widest page it will give', () => {
  it('names the RPC clamp rather than inlining a number', () => {
    // pool_list clamps p_limit to 200; asking for more is silently less.
    // Named here because it is the bound on how many CANDIDATES the exact
    // filter gets to see, which is the one real limitation of the
    // string-keyed approach.
    expect(ARTIST_CANDIDATE_LIMIT).toBe(200)
  })

  it('passes the artist name through as the substring query', () => {
    const args = poolListArgs({ ...EMPTY_QUERY, q: 'Bicep' }, null, ARTIST_CANDIDATE_LIMIT)
    expect(args.p_q).toBe('Bicep')
    expect(args.p_limit).toBe(200)
    // No uploader filter: an artist page spans every uploader, which is
    // exactly what makes it different from a member page.
    expect(args.p_uploader).toBeNull()
  })
})
