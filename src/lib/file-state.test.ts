// src/lib/file-state.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import { POOL_VISIBLE_STATES, NON_TERMINAL_LABEL, TERMINAL_FAILED_STATES } from './file-state'

describe('POOL_VISIBLE_STATES', () => {
  // Final-review finding F1: src/pages/api/track/[id]/download.ts and
  // source.ts refuse a presign for any state outside this set. It must
  // match SQL pool_visible_states() (migration 06) byte-for-byte, or the
  // route silently disagrees with bump_download()'s own P0002 refusal.
  it('matches SQL pool_visible_states() exactly', () => {
    expect([...POOL_VISIBLE_STATES].sort()).toEqual(
      ['analysing', 'needs_review', 'received', 'stored'].sort(),
    )
  })

  it('includes stored — the happy-path pool track', () => {
    expect(POOL_VISIBLE_STATES.has('stored')).toBe(true)
  })

  it('excludes the pre-verification states — no object confirmed yet', () => {
    expect(POOL_VISIBLE_STATES.has('pending')).toBe(false)
    expect(POOL_VISIBLE_STATES.has('uploading')).toBe(false)
  })

  it('excludes every terminal-failed state — an abandoned upload has no object left', () => {
    for (const state of TERMINAL_FAILED_STATES) {
      expect(POOL_VISIBLE_STATES.has(state)).toBe(false)
    }
  })

  it('is a subset of every state file-state.ts otherwise knows about', () => {
    const known = new Set([...Object.keys(NON_TERMINAL_LABEL), ...TERMINAL_FAILED_STATES])
    for (const state of POOL_VISIBLE_STATES) expect(known.has(state)).toBe(true)
  })
})
