// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import { creditsRemaining, isActive, isApiPath } from './session'

const NOW = new Date('2026-07-27T12:00:00Z')
const m = (iso: string) =>
  ({ user_id: 'u', email: 'a@b.com', role: 'member' as const, access_expires_at: iso, username: null })

describe('creditsRemaining', () => {
  it('rounds a partial day up', () => {
    expect(creditsRemaining('2026-07-28T06:00:00Z', NOW)).toBe(1)
  })
  it('counts whole days', () => {
    expect(creditsRemaining('2026-08-26T12:00:00Z', NOW)).toBe(30)
  })
  it('is zero, never negative, once expired', () => {
    expect(creditsRemaining('2026-07-20T12:00:00Z', NOW)).toBe(0)
  })
  it('is zero exactly at expiry', () => {
    expect(creditsRemaining('2026-07-27T12:00:00Z', NOW)).toBe(0)
  })
})

describe('isActive', () => {
  it('is true while expiry is in the future', () => {
    expect(isActive(m('2026-07-27T12:00:01Z'), NOW)).toBe(true)
  })
  it('is false at and after expiry', () => {
    expect(isActive(m('2026-07-27T12:00:00Z'), NOW)).toBe(false)
    expect(isActive(m('2026-07-01T00:00:00Z'), NOW)).toBe(false)
  })
})

describe('isApiPath', () => {
  // Final-review finding F2: this is the switch src/middleware.ts's
  // username-claim gate branches on — JSON 403 instead of a redirect to
  // /welcome, since fetch() follows a redirect and src/lib/uploader.ts's
  // readJson() cannot tell that 200 text/html apart from a dead session.
  it('is true for any /api/* path', () => {
    expect(isApiPath('/api/welcome')).toBe(true)
    expect(isApiPath('/api/track/abc/download')).toBe(true)
    expect(isApiPath('/api/upload/presign')).toBe(true)
  })

  it('is false for a page path, even one that starts similarly', () => {
    expect(isApiPath('/welcome')).toBe(false)
    expect(isApiPath('/')).toBe(false)
    expect(isApiPath('/apicola')).toBe(false)
  })
})
