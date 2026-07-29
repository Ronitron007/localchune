// src/lib/org-api.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Client-side fetch wrappers for the pool's per-track signal actions —
 * like toggle first (M6a Task 3); play-count bump follows in Task 4. No
 * DOM here: site.ts calls these from its document-level delegation and
 * does the optimistic DOM swap + rollback itself.
 *
 * Same content-type-first parsing discipline as the play-link handler in
 * src/scripts/site.ts and src/lib/uploader.ts's readJson(): src/middleware.ts
 * redirects any request without a live member to /login, and fetch()
 * follows that redirect itself, so a dead session lands here as a 200
 * text/html — never a 401. Content-type is the only way to tell that apart
 * from a real JSON response, so it is checked BEFORE the body is parsed.
 *
 * M6a Task 6 adds crateHref/formatCrateMeta/CrateCard — pure formatting
 * helpers for /crates.astro, which calls crate_list() (migration 20)
 * server-side and needs no fetch wrapper of its own.
 *
 * M6a Task 7 adds moveInList (pure array helper shared by the /move route
 * and the drag code's keyboard-equivalent ↑/↓ button forms) and
 * crateItemToPoolTrack (the CrateItem -> PoolTrack adapter that lets
 * /crate/[id].astro render crate_get() rows through the pool's existing
 * TrackRow.astro unchanged).
 */
import { formatDuration } from './format'
import type { PoolTrack } from './pool-api'

/**
 * Same-origin-validated Referer, or `fallback` when there is none, it
 * fails to parse, or it points somewhere else — the open-redirect guard
 * `/api/track/[id]/like.ts` established inline for its one caller. Five
 * `/api/crate/[id]/*` routes (Task 7) need the exact same check on their
 * plain-form branch, so it is factored here instead of retyped five times.
 */
export function sameOriginRedirectTarget(
  refererHeader: string | null, requestUrl: string, fallback: string,
): string {
  if (!refererHeader) return fallback
  try {
    const referer = new URL(refererHeader, requestUrl)
    if (referer.origin === new URL(requestUrl).origin) {
      return referer.pathname + referer.search
    }
  } catch {
    // Malformed Referer URL, use fallback.
  }
  return fallback
}

/** Middleware redirected the request to /login — the session is gone. */
export class SessionExpiredError extends Error {
  constructor() {
    super('session ended — reload to sign in')
    this.name = 'SessionExpiredError'
  }
}

export type ToggleLikeResult = { like_count: number; liked: boolean }

/**
 * POST /api/track/:id/like. Throws SessionExpiredError on a non-JSON
 * response (middleware redirect to /login) and a plain Error carrying the
 * server's message on a JSON `{error}` body — same `message ?? error`
 * fallback the play-link handler in site.ts already uses.
 */
export async function toggleLike(fileId: string): Promise<ToggleLikeResult> {
  const res = await fetch(`/api/track/${fileId}/like`, {
    method: 'POST',
    // content-type is mandatory: Astro's built-in CSRF origin check 403s an
    // unsafe-method request with no recognised content type, before
    // middleware even runs — see src/lib/uploader.ts's postJson.
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new SessionExpiredError()

  const body = (await res.json()) as Partial<ToggleLikeResult> & { error?: string; message?: string }
  if (!res.ok) throw new Error(body.message ?? body.error ?? `request failed (${res.status})`)
  return { like_count: body.like_count ?? 0, liked: body.liked ?? false }
}

/** Mirrors crate_list()'s (migration 20) row shape, column for column. */
export type CrateCard = {
  id: string
  name: string
  owner_id: string
  owner_name: string
  is_mine: boolean
  is_public: boolean
  /** Pool-visible items only — see crate_list()'s comment. Never null. */
  track_count: number
  /** Pool-visible items only, ms. Never null. */
  total_duration_ms: number
  updated_at: string
}

/** /crates.astro's and /crate/[id]'s only link builder for a crate. */
export function crateHref(id: string): string {
  return `/crate/${id}`
}

/**
 * "12 tracks · 48:31" — 0 tracks reads as "empty" rather than "0 tracks ·
 * --:--", and 1 track gets the singular noun. Reuses formatDuration so a
 * crate's total reads exactly like a track row's own duration cell.
 */
export function formatCrateMeta(card: Pick<CrateCard, 'track_count' | 'total_duration_ms'>): string {
  if (card.track_count === 0) return 'empty'
  const noun = card.track_count === 1 ? 'track' : 'tracks'
  return `${card.track_count} ${noun} · ${formatDuration(card.total_duration_ms)}`
}

/**
 * Pure, total, never mutates `items`. Swaps `items[index]` with its
 * neighbour in the given direction; a boundary move (first item "up", last
 * item "down") or an out-of-range `index` returns an unchanged COPY rather
 * than throwing — the caller decides whether "nothing moved" is worth
 * reporting. Shared by two callers that must never disagree on what
 * "moved" means: `/api/crate/[id]/move.ts` (server-side, backing the
 * always-present ↑/↓ button forms — the reorder path that needs no JS and
 * no mouse) and, client-side, the same array-swap the drag-to-reorder
 * enhancement in site.ts could use for a keyboard-driven equivalent move.
 */
export function moveInList<T>(items: T[], index: number, dir: 'up' | 'down'): T[] {
  const next = items.slice()
  const swapWith = dir === 'up' ? index - 1 : index + 1
  if (index < 0 || index >= next.length || swapWith < 0 || swapWith >= next.length) {
    return next
  }
  const tmp = next[index]
  next[index] = next[swapWith]
  next[swapWith] = tmp
  return next
}

/**
 * A crate_get() row (migration 20): `position` followed by pool_get's
 * entire column list. Only the subset TrackRow.astro (via PoolTrack)
 * actually reads is typed here — crate_get returns many more columns
 * (analysis internals, batch/claim provenance) this page has no use for.
 */
export type CrateItem = {
  position: number
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
 * Adapts a crate_get() row onto PoolTrack's shape so /crate/[id].astro can
 * render it through TrackRow.astro unchanged — the same component the pool
 * table uses. pool_list's derived has_preview/has_peaks/has_thumb booleans
 * are recomputed here from crate_get's raw *_key columns (non-null == the
 * object exists); pool_list-only pagination/sort artefacts TrackRow never
 * reads (camelot_sort, row_cursor) get harmless placeholders rather than
 * an invented meaning nothing downstream consumes.
 */
export function crateItemToPoolTrack(item: CrateItem): PoolTrack {
  return {
    file_id: item.file_id,
    track_id: item.track_id,
    uploaded_by: item.uploaded_by,
    uploader_name: item.uploader_name,
    original_filename: item.original_filename,
    display_artist: item.display_artist,
    display_title: item.display_title,
    container: item.container,
    byte_size: item.byte_size,
    duration_ms: item.duration_ms,
    bpm: item.bpm,
    ibi_std_ms: item.ibi_std_ms,
    key_camelot: item.key_camelot,
    key_open: item.key_open,
    key_musical: item.key_musical,
    camelot_sort: 0,
    quality_tier: item.quality_tier,
    lossy_ancestor: item.lossy_ancestor,
    meas_cutoff_hz: item.meas_cutoff_hz,
    integrated_lufs: item.integrated_lufs,
    has_preview: item.preview_key !== null,
    has_peaks: item.peaks_key !== null,
    has_thumb: item.thumb_key !== null,
    created_at: item.created_at,
    row_cursor: item.file_id,
    download_count: item.download_count,
    tags: item.tags,
    like_count: item.like_count,
    liked_by_me: item.liked_by_me,
    play_count: item.play_count,
  }
}
