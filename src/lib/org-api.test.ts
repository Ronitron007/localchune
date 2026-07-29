// src/lib/org-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  crateHref, crateItemToPoolTrack, formatCrateMeta, moveInList, sameOriginRedirectTarget,
  SessionExpiredError, toggleLike, type CrateCard, type CrateItem,
} from './org-api'

const FILE_ID = '11111111-1111-1111-1111-111111111111'
const CRATE_ID = '22222222-2222-2222-2222-222222222222'

// A full crate_list() row (migration 20) — only track_count/total_duration_ms
// vary between the formatCrateMeta cases below, so this is the shared base.
const CARD: CrateCard = {
  id: CRATE_ID,
  name: 'warehouse',
  owner_id: '33333333-3333-3333-3333-333333333333',
  owner_name: 'dj',
  is_mine: true,
  is_public: false,
  track_count: 0,
  total_duration_ms: 0,
  updated_at: '2026-07-29T00:00:00Z',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('toggleLike', () => {
  it('POSTs to /api/track/:id/like and parses the count/liked pair', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ like_count: 4, liked: true }))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await toggleLike(FILE_ID)

    expect(result).toEqual({ like_count: 4, liked: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/track/${FILE_ID}/like`)
    expect(init.method).toBe('POST')
  })

  it('throws SessionExpiredError when the response is not JSON — middleware redirected to /login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ))

    await expect(toggleLike(FILE_ID)).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('throws with the server message on an {error} body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: 'not_found', message: 'no such track' }, 404),
    ))

    await expect(toggleLike(FILE_ID)).rejects.toThrow('no such track')
  })

  it('falls back to the error code when no message is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: 'forbidden' }, 403),
    ))

    await expect(toggleLike(FILE_ID)).rejects.toThrow('forbidden')
  })
})

describe('sameOriginRedirectTarget', () => {
  const REQUEST_URL = 'https://localchune.example/api/crate/22222222-2222-2222-2222-222222222222/move'

  it('returns the fallback when there is no Referer', () => {
    expect(sameOriginRedirectTarget(null, REQUEST_URL, '/crate/x')).toBe('/crate/x')
  })

  it('returns the same-origin Referer path + search', () => {
    expect(sameOriginRedirectTarget('https://localchune.example/crate/x?foo=bar', REQUEST_URL, '/crate/y'))
      .toBe('/crate/x?foo=bar')
  })

  it('falls back on a cross-origin Referer — no open redirect', () => {
    expect(sameOriginRedirectTarget('https://evil.example/', REQUEST_URL, '/crate/x')).toBe('/crate/x')
  })

  it('falls back on a malformed Referer', () => {
    expect(sameOriginRedirectTarget('http://[', REQUEST_URL, '/crate/x')).toBe('/crate/x')
  })
})

describe('crateHref', () => {
  it('builds /crate/<id>', () => {
    expect(crateHref(CRATE_ID)).toBe(`/crate/${CRATE_ID}`)
  })
})

describe('formatCrateMeta', () => {
  it('renders "N tracks · duration" for the plural case', () => {
    // 48:31 == 48*60+31 seconds == 2911000 ms.
    expect(formatCrateMeta({ ...CARD, track_count: 12, total_duration_ms: 2_911_000 }))
      .toBe('12 tracks · 48:31')
  })

  it('uses the singular noun for exactly one track', () => {
    expect(formatCrateMeta({ ...CARD, track_count: 1, total_duration_ms: 225_000 }))
      .toBe('1 track · 3:45')
  })

  it('renders "empty" for zero tracks, regardless of total_duration_ms', () => {
    expect(formatCrateMeta({ ...CARD, track_count: 0, total_duration_ms: 0 })).toBe('empty')
  })
})

describe('moveInList', () => {
  it('swaps with the previous item on "up"', () => {
    expect(moveInList(['a', 'b', 'c'], 1, 'up')).toEqual(['b', 'a', 'c'])
  })

  it('swaps with the next item on "down"', () => {
    expect(moveInList(['a', 'b', 'c'], 1, 'down')).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op when the first item moves up', () => {
    expect(moveInList(['a', 'b', 'c'], 0, 'up')).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op when the last item moves down', () => {
    expect(moveInList(['a', 'b', 'c'], 2, 'down')).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op when index itself is out of range, in both directions', () => {
    expect(moveInList(['a', 'b', 'c'], -1, 'up')).toEqual(['a', 'b', 'c'])
    expect(moveInList(['a', 'b', 'c'], 3, 'down')).toEqual(['a', 'b', 'c'])
  })

  it('never mutates the input array', () => {
    const original = ['a', 'b', 'c']
    const copy = [...original]
    moveInList(original, 1, 'up')
    expect(original).toEqual(copy)
  })

  it('returns a new array, not the same reference, even on a no-op move', () => {
    const original = ['a', 'b', 'c']
    expect(moveInList(original, 0, 'up')).not.toBe(original)
  })
})

describe('crateItemToPoolTrack', () => {
  // A full crate_get() row (migration 20) -- position + pool_get's entire
  // column list. Only the fields TrackRow/PoolTrack reads are populated
  // here; every other pool_get column is irrelevant to the adapter.
  const ITEM: CrateItem = {
    position: 1,
    file_id: FILE_ID,
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
    const track = crateItemToPoolTrack(ITEM)
    expect(track.has_preview).toBe(true)
    expect(track.has_peaks).toBe(false)
    expect(track.has_thumb).toBe(true)
  })

  it('carries every other TrackRow-relevant field through unchanged', () => {
    const track = crateItemToPoolTrack(ITEM)
    expect(track.file_id).toBe(ITEM.file_id)
    expect(track.display_artist).toBe(ITEM.display_artist)
    expect(track.display_title).toBe(ITEM.display_title)
    expect(track.bpm).toBe(ITEM.bpm)
    expect(track.like_count).toBe(ITEM.like_count)
    expect(track.liked_by_me).toBe(ITEM.liked_by_me)
    expect(track.play_count).toBe(ITEM.play_count)
    expect(track.tags).toEqual(ITEM.tags)
  })
})
