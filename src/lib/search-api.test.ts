// src/lib/search-api.test.ts
// localchune — MIT licensed. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionExpiredError } from './org-api'
import {
  MIN_QUERY_LENGTH, SEARCH_RESULT_KEYS, fetchSearch, isAbortError,
  isSearchable, parseSearchQuery, toSearchResult,
} from './search-api'

const ROW = {
  file_id: '11111111-1111-1111-1111-111111111111',
  display_artist: 'Mochakk',
  display_title: 'Frevo',
  bpm: 126.5,
  key_camelot: '8A',
  quality_tier: 5,
  has_thumb: true,
  duration_ms: 300000,
}

afterEach(() => { vi.unstubAllGlobals() })

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('toSearchResult — the projection is the boundary', () => {
  it('keeps exactly the eight declared keys', () => {
    expect(Object.keys(toSearchResult(ROW)).sort()).toEqual([...SEARCH_RESULT_KEYS].sort())
  })

  it('DROPS raw_tags, r2_key and provenance even when handed them', () => {
    // The whole point of the map. search_tracks does not return these
    // today; migrations 20 and 28 exist because something once did, and a
    // route that forwarded `data` verbatim would re-widen the boundary the
    // day a migration added a column. This is the guard for that day.
    const poisoned = {
      ...ROW,
      raw_tags: { account_id: 'the-buyer-apple-id' },
      r2_key: 'audio/uid/file.flac',
      provenance: { purchased_by: 'someone' },
      score: 1.24,
      liked_by_me: true,
      uploader_name: 'rohan',
    }
    const out = toSearchResult(poisoned) as Record<string, unknown>
    expect(out.raw_tags).toBeUndefined()
    expect(out.r2_key).toBeUndefined()
    expect(out.provenance).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('the-buyer-apple-id')
  })

  it('is total: an unanalysed track projects with nulls rather than throwing', () => {
    const bare = { file_id: 'x', display_title: 'Only A Filename.mp3' }
    expect(toSearchResult(bare)).toEqual({
      file_id: 'x',
      display_artist: null,
      display_title: 'Only A Filename.mp3',
      bpm: null,
      key_camelot: null,
      quality_tier: null,
      has_thumb: false,
      duration_ms: null,
    })
  })

  it('never renders a nameless row', () => {
    // display_title is the one column migration 11 promises is never null.
    // If that promise is ever broken the row still has to draw something.
    expect(toSearchResult({ file_id: 'x' }).display_title).toBe('Untitled')
  })

  it('treats has_thumb as strictly boolean, not truthy', () => {
    // A string 'false' from a sloppy serialiser must not paint a broken img.
    expect(toSearchResult({ ...ROW, has_thumb: 'false' }).has_thumb).toBe(false)
    expect(toSearchResult({ ...ROW, has_thumb: 1 }).has_thumb).toBe(false)
  })

  it('rejects a NaN bpm rather than passing it to a formatter', () => {
    expect(toSearchResult({ ...ROW, bpm: Number.NaN }).bpm).toBeNull()
  })
})

describe('parseSearchQuery / isSearchable — zero requests below the floor', () => {
  it.each(['', ' ', 'a', ' a '])('refuses %o', (raw) => {
    expect(parseSearchQuery(raw)).toBeNull()
    expect(isSearchable(raw)).toBe(false)
  })

  it.each(['ab', ' ab ', 'mochakk'])('accepts %o', (raw) => {
    expect(parseSearchQuery(raw)).not.toBeNull()
    expect(isSearchable(raw)).toBe(true)
  })

  it('trims, so the wire never carries the padding', () => {
    expect(parseSearchQuery('  mochakk  ')).toBe('mochakk')
  })

  it('agrees with MIN_QUERY_LENGTH rather than hard-coding 2', () => {
    expect(parseSearchQuery('x'.repeat(MIN_QUERY_LENGTH))).not.toBeNull()
    expect(parseSearchQuery('x'.repeat(MIN_QUERY_LENGTH - 1))).toBeNull()
  })

  it('truncates a paste instead of 400-ing it', () => {
    expect(parseSearchQuery('x'.repeat(500))).toHaveLength(120)
  })

  it('handles a null/undefined param — the route reads a URLSearchParams', () => {
    expect(parseSearchQuery(null)).toBeNull()
    expect(parseSearchQuery(undefined)).toBeNull()
  })

  it('keeps a two-token DJ query whole', () => {
    expect(parseSearchQuery('mochakk 128')).toBe('mochakk 128')
  })
})

describe('fetchSearch', () => {
  it('encodes the query and asks for JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [ROW] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchSearch('mochakk & co')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search?q=mochakk%20%26%20co')
    expect(fetchMock.mock.calls[0][1].headers.accept).toBe('application/json')
  })

  it('projects every row on the way in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ ...ROW, r2_key: 'audio/leak.flac' }] }),
    ))
    const out = await fetchSearch('mochakk')
    expect(out).toHaveLength(1)
    expect(out[0]).not.toHaveProperty('r2_key')
  })

  it('passes the AbortSignal through — the whole reason it takes one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()
    await fetchSearch('mochakk', ac.signal)
    expect(fetchMock.mock.calls[0][1].signal).toBe(ac.signal)
  })

  it('throws SessionExpiredError when the response is not JSON — middleware redirected to /login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    ))
    await expect(fetchSearch('mochakk')).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('carries the server message on a JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: 'db_error', message: 'try again' }, 503),
    ))
    await expect(fetchSearch('mochakk')).rejects.toThrow('try again')
  })

  it('returns [] when the body has no results array, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await expect(fetchSearch('mochakk')).resolves.toEqual([])
  })
})

describe('isAbortError', () => {
  it('recognises a real AbortController abort', async () => {
    const ac = new AbortController()
    ac.abort()
    const err = await fetch('data:text/plain,x', { signal: ac.signal }).catch((e) => e)
    expect(isAbortError(err)).toBe(true)
  })

  it('does not swallow an ordinary failure', () => {
    // A search that genuinely broke must still reach the status line.
    expect(isAbortError(new Error('network'))).toBe(false)
    expect(isAbortError(new SessionExpiredError())).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
