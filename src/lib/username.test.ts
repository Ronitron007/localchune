// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import { suggestUsername } from './username'

describe('suggestUsername', () => {
  it('lowercases and keeps a plain local part as-is', () => {
    expect(suggestUsername('Rohan@example.com')).toBe('rohan')
  })
  it('folds dots and plus-tags to underscore', () => {
    expect(suggestUsername('rohan.maliko99@gmail.com')).toBe('rohan_maliko99')
    expect(suggestUsername('john+doe@example.com')).toBe('john_doe')
  })
  it('collapses runs of folded characters to one underscore', () => {
    expect(suggestUsername('a...b@example.com')).toBe('a_b')
  })
  it('trims leading/trailing underscores left by folding', () => {
    expect(suggestUsername('.leading@example.com')).toBe('leading')
    expect(suggestUsername('trailing.@example.com')).toBe('trailing')
  })
  it('prefixes a letter when the local part starts with a digit', () => {
    expect(suggestUsername('123abc@example.com')).toBe('x123abc')
  })
  it('pads up to the 3-character floor', () => {
    expect(suggestUsername('ab@example.com')).toBe('ab0')
  })
  it('falls back to a plausible placeholder for a pathological local part', () => {
    expect(suggestUsername('__@example.com')).toBe('x00')
  })
  it('truncates to the 20-character ceiling', () => {
    expect(suggestUsername(`${'a'.repeat(30)}@example.com`)).toBe('a'.repeat(20))
  })
  it('never throws on input with no @', () => {
    expect(() => suggestUsername('nope')).not.toThrow()
  })
})
