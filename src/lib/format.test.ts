// src/lib/format.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('stays in bytes below 1024', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('switches to KB, MB, GB as the value grows', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('drops the decimal once the value reaches double digits', () => {
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(99 * 1024 * 1024)).toBe('99 MB')
  })

  it('never advances past GB — the largest unit this app needs', () => {
    // my_storage()/member_storage() sum bigint bytes across every file a
    // member has ever contributed; this only has to stay readable, not
    // exact, at that scale.
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1024 GB')
  })
})
