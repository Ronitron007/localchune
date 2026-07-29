// src/lib/org-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { crateHref, formatCrateMeta, SessionExpiredError, toggleLike, type CrateCard } from './org-api'

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
