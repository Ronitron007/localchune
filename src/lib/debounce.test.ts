// src/lib/debounce.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debounce } from './debounce'

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once, after the quiet period, with the last arguments', () => {
    const calls: string[] = []
    const d = debounce((s: string) => calls.push(s), 200)
    d('a'); d('ab'); d('abc')
    vi.advanceTimersByTime(199)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['abc'])
  })

  it('fires again for a later burst', () => {
    const calls: number[] = []
    const d = debounce((n: number) => calls.push(n), 100)
    d(1); vi.advanceTimersByTime(100)
    d(2); vi.advanceTimersByTime(100)
    expect(calls).toEqual([1, 2])
  })

  it('cancel drops a pending call', () => {
    const calls: number[] = []
    const d = debounce((n: number) => calls.push(n), 100)
    d(1)
    d.cancel()
    vi.advanceTimersByTime(500)
    expect(calls).toEqual([])
  })
})
