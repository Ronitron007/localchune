// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

export type Member = {
  user_id: string
  email: string
  role: 'member' | 'owner'
  access_expires_at: string
}

const DAY_MS = 86_400_000

/** Credits are a display projection of access_expires_at. Never stored. */
export function creditsRemaining(expiresAt: string, now: Date = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

// v2 enforcement hook. Credit/expiry enforcement is out of scope for M1 (see
// PRD) — deliberately NOT wired into src/middleware.ts yet. An expired
// member still reaches the app today, showing "0 credits". Kept + tested so
// v2 can gate on it without redesigning this function.
export function isActive(m: Member, now: Date = new Date()): boolean {
  return new Date(m.access_expires_at).getTime() > now.getTime()
}
