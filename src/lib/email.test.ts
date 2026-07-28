// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import { normalizeEmail } from './email'

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Rohan@Example.COM ')).toBe('rohan@example.com')
  })
  it('strips dots in the gmail local part', () => {
    expect(normalizeEmail('r.o.h.a.n@gmail.com')).toBe('rohan@gmail.com')
  })
  it('strips a gmail plus-tag', () => {
    expect(normalizeEmail('rohan+dj@gmail.com')).toBe('rohan@gmail.com')
  })
  it('treats googlemail as gmail', () => {
    expect(normalizeEmail('ro.han+x@googlemail.com')).toBe('rohan@gmail.com')
  })
  it('leaves non-gmail dots and plus alone', () => {
    expect(normalizeEmail('first.last+tag@fastmail.com')).toBe('first.last+tag@fastmail.com')
  })
  it('throws on input with no @', () => {
    expect(() => normalizeEmail('nope')).toThrow('invalid email')
  })
  it('throws on input with more than one @', () => {
    expect(() => normalizeEmail('a@b@c')).toThrow('invalid email')
  })
})
