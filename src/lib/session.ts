// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

export type Member = {
  user_id: string
  email: string
  role: 'member' | 'owner'
  access_expires_at: string
  // Migration 17: null until the member claims one at /welcome. Middleware
  // reads this directly to gate the claim-flow redirect — see
  // src/middleware.ts.
  username: string | null
}

const DAY_MS = 86_400_000

/** Credits are a display projection of access_expires_at. Never stored. */
export function creditsRemaining(expiresAt: string, now: Date = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

/** True once access_expires_at is in the past. Wired into src/middleware.ts. */
export function isActive(m: Member, now: Date = new Date()): boolean {
  return new Date(m.access_expires_at).getTime() > now.getTime()
}

/**
 * Final-review finding F2: src/middleware.ts's username-claim gate used to
 * `ctx.redirect('/welcome')` unconditionally, including for `/api/*`
 * requests. A redirect is a 200 by the time `fetch()` sees it (it follows
 * the Location header itself), so src/lib/uploader.ts's readJson() could
 * only tell it apart from a real JSON response by content-type — and read
 * it as "session ended", killing an in-flight upload batch. This is the
 * bare predicate the gate branches on: an API path gets a JSON 403 instead
 * of a redirect, since a JSON body some client already knows how to parse
 * fails the ONE request cleanly instead of masquerading as a dead session.
 */
export function isApiPath(path: string): boolean {
  return path.startsWith('/api/')
}
