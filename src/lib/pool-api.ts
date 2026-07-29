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
  'downloads_desc',
] as const
export type PoolSort = (typeof POOL_SORTS)[number]

export const DEFAULT_SORT: PoolSort = 'added_desc'
/** One page. 2k tracks is ~20 pages; see the no-virtualiser decision. */
export const PAGE_SIZE = 100
const MAX_Q_LENGTH = 120
const MAX_BPM = 1000

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
  return {
    q: (sp.get('q') ?? '').trim().slice(0, MAX_Q_LENGTH),
    bpmMin: numberIn(sp.get('bpm_min'), 0, MAX_BPM),
    bpmMax: numberIn(sp.get('bpm_max'), 0, MAX_BPM),
    halfDouble: flag(sp.get('half_double')),
    key: key === null ? null : `${key.num}${key.letter}`,
    harmonic: flag(sp.get('harmonic')),
    tierMin: tier === null ? null : Math.round(tier),
    uploader: isUuid(uploader) ? uploader : null,
    sort: (POOL_SORTS as readonly string[]).includes(sortRaw ?? '')
      ? (sortRaw as PoolSort)
      : DEFAULT_SORT,
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
  if (q.sort !== DEFAULT_SORT) sp.set('sort', q.sort)
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

export function poolListArgs(
  q: PoolQuery, cursor: string | null, limit: number,
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
  }
}

/**
 * The pool page's only link builder. Sort links restart paging on purpose —
 * a keyset cursor is only valid within the sort that minted it, so a sort
 * change never carries `cursor`. The next-page link carries both.
 */
export function poolHref(
  q: PoolQuery, opts: { sort?: PoolSort; cursor?: string } = {},
): string {
  const sp = poolQueryToSearchParams(opts.sort === undefined ? q : { ...q, sort: opts.sort })
  if (opts.cursor !== undefined) sp.set('cursor', opts.cursor)
  const s = sp.toString()
  return s === '' ? '/' : `/?${s}`
}
