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
 */
import { formatDuration } from './format'

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
