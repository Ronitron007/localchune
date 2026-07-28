// src/lib/pool-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  EMPTY_QUERY, isDefaultQuery, parsePoolQuery, poolListArgs,
  poolQueryToSearchParams, poolHref,
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
  it('is a clean / for the default query', () => {
    expect(poolHref(EMPTY_QUERY)).toBe('/')
  })
  it('keeps the filters and swaps the sort, dropping any cursor', () => {
    const q = { ...EMPTY_QUERY, bpmMin: 120, sort: 'added_desc' as const }
    expect(poolHref(q, { sort: 'bpm_asc' })).toBe('/?bpm_min=120&sort=bpm_asc')
  })
  it('carries the cursor for the next page under the current sort', () => {
    const q = { ...EMPTY_QUERY, sort: 'bpm_asc' as const }
    expect(poolHref(q, { cursor: '00000123abc' }))
      .toBe('/?sort=bpm_asc&cursor=00000123abc')
  })
})
