// src/lib/org-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionExpiredError, toggleLike } from './org-api'

const FILE_ID = '11111111-1111-1111-1111-111111111111'

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
