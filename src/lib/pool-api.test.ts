// src/lib/pool-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  EMPTY_QUERY, feedTrackToPoolTrack, isDefaultQuery, parsePoolQuery, poolListArgs,
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
    })
  })

  it('passes an empty text query as null, not as an empty string', () => {
    expect(poolListArgs({ ...EMPTY_QUERY, q: '' }, null, 100).p_q).toBeNull()
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
