// src/lib/queue-candidates.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CANDIDATE_LIMIT, candidateArgs, candidatesHref, fetchCandidates, parseCandidateQuery,
  toTrackFeatures, TRACK_FEATURE_KEYS,
} from './queue-candidates'
import { BPM_WINDOW, type TrackFeatures } from './queue-strategies'
import { SessionExpiredError } from './org-api'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const seedFeature = (over: Partial<TrackFeatures> = {}): TrackFeatures => ({
  file_id: 'seed',
  display_artist: null,
  display_title: 'seed',
  duration_ms: null,
  bpm: 128,
  key_camelot: '8A',
  like_count: 0,
  play_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

/** A full pool_list() row (migration 26's 29 columns) plus the provenance
 *  column migrations 20/28 keep narrow — none of which belongs on this wire. */
const poolRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  file_id: '11111111-1111-1111-1111-111111111111',
  track_id: null,
  uploaded_by: '22222222-2222-2222-2222-222222222222',
  uploader_name: 'dj',
  original_filename: 'x.flac',
  display_artist: 'Artist',
  display_title: 'Title',
  container: 'flac',
  byte_size: 40_000_000,
  duration_ms: 320_000,
  bpm: 128,
  ibi_std_ms: 1.2,
  key_camelot: '8A',
  key_open: '1m',
  key_musical: 'Am',
  camelot_sort: 80,
  quality_tier: 1,
  lossy_ancestor: 'none',
  meas_cutoff_hz: 21_000,
  integrated_lufs: -9.2,
  has_preview: true,
  has_peaks: true,
  has_thumb: true,
  created_at: '2026-07-01T00:00:00Z',
  row_cursor: 'cur',
  download_count: 3,
  tags: ['house'],
  like_count: 7,
  liked_by_me: true,
  play_count: 41,
  provenance: { raw: 'do not ship this' },
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('candidateArgs — the pool_list call, built in one place', () => {
  it('sets p_harmonic TRUE and p_key when the seed has a key', () => {
    const args = candidateArgs({ key: '8A', bpm: 128 }, CANDIDATE_LIMIT)
    expect(args.p_key).toBe('8A')
    expect(args.p_harmonic).toBe(true)
  })

  it('falls back to a BPM-WINDOW-ONLY query for a keyless seed', () => {
    const args = candidateArgs({ key: null, bpm: 128 }, CANDIDATE_LIMIT)
    expect(args.p_key).toBeNull()
    expect(args.p_harmonic).toBe(false)
    expect(args.p_bpm_min).toBeCloseTo(128 * (1 - BPM_WINDOW), 10)
  })

  it('opens the BPM window to exactly ±BPM_WINDOW', () => {
    const args = candidateArgs({ key: '8A', bpm: 128 }, CANDIDATE_LIMIT)
    expect(args.p_bpm_min).toBeCloseTo(120.32, 10)
    expect(args.p_bpm_max).toBeCloseTo(135.68, 10)
    expect(args.p_bpm_min).toBeCloseTo(128 * (1 - BPM_WINDOW), 10)
    expect(args.p_bpm_max).toBeCloseTo(128 * (1 + BPM_WINDOW), 10)
  })

  it('leaves the window open when the seed has no tempo', () => {
    const args = candidateArgs({ key: '8A', bpm: null }, CANDIDATE_LIMIT)
    expect(args.p_bpm_min).toBeNull()
    expect(args.p_bpm_max).toBeNull()
  })

  it('HALF/DOUBLE IS OFF — a 64 BPM track under a 128 is a deliberate DJ move, not autoplay', () => {
    expect(candidateArgs({ key: '8A', bpm: 128 }, CANDIDATE_LIMIT).p_half_double).toBe(false)
    expect(candidateArgs({ key: null, bpm: null }, CANDIDATE_LIMIT).p_half_double).toBe(false)
  })

  it('SORTS added_desc AND NEVER plays_desc — §2.2\'s feedback-loop argument, asserted', () => {
    // The strategy re-ranks everything anyway; the sort only decides which 200
    // rows we see. plays_desc would feed the auto tail back into a discovery
    // ranking, so a future "improvement" has to argue with this test.
    expect(candidateArgs({ key: '8A', bpm: 128 }, CANDIDATE_LIMIT).p_sort).toBe('added_desc')
    expect(candidateArgs({ key: null, bpm: null }, CANDIDATE_LIMIT).p_sort).not.toBe('plays_desc')
  })

  it('narrows nothing else — no text search, no tier floor, no uploader, no cursor', () => {
    const args = candidateArgs({ key: '8A', bpm: 128 }, CANDIDATE_LIMIT)
    expect(args.p_q).toBeNull()
    expect(args.p_tier_min).toBeNull()
    expect(args.p_uploader).toBeNull()
    expect(args.p_cursor).toBeNull()
  })

  it('clamps the limit to what pool_list itself allows', () => {
    expect(candidateArgs({ key: null, bpm: null }, 9_000).p_limit).toBe(CANDIDATE_LIMIT)
    expect(candidateArgs({ key: null, bpm: null }, 0).p_limit).toBe(1)
    expect(candidateArgs({ key: null, bpm: null }, -5).p_limit).toBe(1)
    expect(candidateArgs({ key: null, bpm: null }, Number.NaN).p_limit).toBe(CANDIDATE_LIMIT)
    expect(candidateArgs({ key: null, bpm: null }, 12.7).p_limit).toBe(12)
  })

  it('caps at 200 — the same ceiling pool_list clamps to server-side', () => {
    expect(CANDIDATE_LIMIT).toBe(200)
  })
})

describe('parseCandidateQuery — the route\'s validator, total and never throwing', () => {
  const q = (s: string) => parseCandidateQuery(new URLSearchParams(s))

  it('reads a valid key and tempo', () => {
    expect(q('key=8A&bpm=128')).toEqual({ key: '8A', bpm: 128, limit: CANDIDATE_LIMIT })
  })

  it('normalises the key through parseCamelot, exactly as the pool filter does', () => {
    expect(q('key=8a').key).toBe('8A')
    expect(q('key=%208A%20').key).toBe('8A')
  })

  it('DROPS an off-wheel key rather than letting pool_list raise 22023 at a listener', () => {
    expect(q('key=13A').key).toBeNull()
    expect(q('key=garbage').key).toBeNull()
    expect(q('').key).toBeNull()
  })

  it('drops a tempo that is not a finite positive number', () => {
    for (const raw of ['0', '-4', 'abc', 'Infinity', '']) {
      expect(q(`bpm=${raw}`).bpm).toBeNull()
    }
  })

  it('clamps the limit and defaults it', () => {
    expect(q('limit=50').limit).toBe(50)
    expect(q('limit=9999').limit).toBe(CANDIDATE_LIMIT)
    expect(q('limit=0').limit).toBe(1)
    expect(q('limit=nope').limit).toBe(CANDIDATE_LIMIT)
  })

  it('accepts a request with no parameters at all — an unanalysed seed is not an error', () => {
    expect(q('')).toEqual({ key: null, bpm: null, limit: CANDIDATE_LIMIT })
  })
})

describe('toTrackFeatures — the projection IS the point', () => {
  it('EMITS EXACTLY THE NINE TrackFeatures FIELDS AND NOTHING ELSE', () => {
    const out = toTrackFeatures(poolRow())
    expect(Object.keys(out).sort()).toEqual([...TRACK_FEATURE_KEYS].sort())
    expect(Object.keys(out)).toHaveLength(9)
  })

  it('DROPS provenance — the migration-20/28 narrowing, held on the wire side', () => {
    const out = toTrackFeatures(poolRow()) as unknown as Record<string, unknown>
    expect(out.provenance).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('do not ship this')
  })

  it('drops every other pool_list column a queue tail has no use for', () => {
    const out = toTrackFeatures(poolRow()) as unknown as Record<string, unknown>
    for (const gone of [
      'track_id', 'uploaded_by', 'uploader_name', 'original_filename', 'container',
      'byte_size', 'ibi_std_ms', 'key_open', 'key_musical', 'camelot_sort',
      'quality_tier', 'lossy_ancestor', 'meas_cutoff_hz', 'integrated_lufs',
      'has_preview', 'has_peaks', 'has_thumb', 'row_cursor', 'download_count',
      'tags', 'liked_by_me',
    ]) {
      expect(out[gone]).toBeUndefined()
    }
  })

  it('carries the nine through with their values intact', () => {
    expect(toTrackFeatures(poolRow())).toEqual({
      file_id: '11111111-1111-1111-1111-111111111111',
      display_artist: 'Artist',
      display_title: 'Title',
      duration_ms: 320_000,
      bpm: 128,
      key_camelot: '8A',
      like_count: 7,
      play_count: 41,
      created_at: '2026-07-01T00:00:00Z',
    })
  })

  it('coalesces the counts and tolerates the nulls the schema allows', () => {
    const out = toTrackFeatures(poolRow({
      display_artist: null, duration_ms: null, bpm: null, key_camelot: null,
      like_count: null, play_count: null,
    }))
    expect(out.like_count).toBe(0)
    expect(out.play_count).toBe(0)
    expect(out.bpm).toBeNull()
    expect(out.key_camelot).toBeNull()
  })
})

describe('candidatesHref', () => {
  it('emits only the parameters it has', () => {
    expect(candidatesHref(seedFeature())).toBe('/api/queue/candidates?key=8A&bpm=128&limit=200')
    expect(candidatesHref(seedFeature({ key_camelot: null }))).toBe('/api/queue/candidates?bpm=128&limit=200')
    expect(candidatesHref(null)).toBe('/api/queue/candidates?limit=200')
  })

  it('never puts anything but the seed\'s features in the URL', () => {
    expect(candidatesHref(seedFeature({ display_title: 'private thing' })))
      .not.toContain('private')
  })
})

describe('fetchCandidates — the CandidatePort implementation', () => {
  it('GETs the route with the seed\'s key and tempo and returns the projection', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [toTrackFeatures(poolRow())],
    }))
    vi.stubGlobal('fetch', spy)

    const out = await fetchCandidates(seedFeature(), 12)

    expect(out).toHaveLength(1)
    expect(out[0].file_id).toBe('11111111-1111-1111-1111-111111111111')
    const [url] = spy.mock.calls[0] as [string]
    expect(url).toContain('key=8A')
    expect(url).toContain('bpm=128')
  })

  it('asks for the FULL window regardless of need — the strategy needs room to rank', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }))
    vi.stubGlobal('fetch', spy)
    await fetchCandidates(seedFeature(), 3)
    expect((spy.mock.calls[0] as [string])[0]).toContain(`limit=${CANDIDATE_LIMIT}`)
  })

  it('handles a null seed without inventing filters', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }))
    vi.stubGlobal('fetch', spy)
    await fetchCandidates(null, 5)
    const [url] = spy.mock.calls[0] as [string]
    expect(url).not.toContain('key=')
    expect(url).not.toContain('bpm=')
  })

  it('THROWS SessionExpiredError on a non-JSON response — middleware redirected to /login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ))
    await expect(fetchCandidates(seedFeature(), 5)).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('throws the server\'s message for an {error} body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: 'forbidden', message: 'not a member' }, 403),
    ))
    await expect(fetchCandidates(seedFeature(), 5)).rejects.toThrow('not a member')
  })

  it('falls back to the error code when there is no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid' }, 422)))
    await expect(fetchCandidates(seedFeature(), 5)).rejects.toThrow('invalid')
  })

  it('returns an empty tail for a well-formed but empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ candidates: [] })))
    await expect(fetchCandidates(seedFeature(), 5)).resolves.toEqual([])
  })

  it('returns an empty tail rather than junk when the body has no candidates array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await expect(fetchCandidates(seedFeature(), 5)).resolves.toEqual([])
  })
})
