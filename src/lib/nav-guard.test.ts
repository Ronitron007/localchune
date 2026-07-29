// src/lib/nav-guard.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { isSoftNavClick, shouldConfirmBeforeNavigating, type NavClickInfo } from './nav-guard'

const ORIGIN = 'https://localchune.butternutcrack.com'

const baseClick: NavClickInfo = {
  href: '/uploads',
  target: null,
  download: false,
  reload: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
}

describe('isSoftNavClick', () => {
  it('is true for a plain left click on a same-origin internal link', () => {
    expect(isSoftNavClick(baseClick, ORIGIN)).toBe(true)
  })

  it('resolves a relative href against the current origin', () => {
    expect(isSoftNavClick({ ...baseClick, href: 'upload' }, ORIGIN)).toBe(true)
  })

  it('is false with no href', () => {
    expect(isSoftNavClick({ ...baseClick, href: null }, ORIGIN)).toBe(false)
    expect(isSoftNavClick({ ...baseClick, href: '' }, ORIGIN)).toBe(false)
  })

  it('is false for an unparseable href', () => {
    expect(isSoftNavClick({ ...baseClick, href: 'https://[::1' }, ORIGIN)).toBe(false)
  })

  it('is false for a cross-origin link', () => {
    expect(isSoftNavClick({ ...baseClick, href: 'https://example.com/x' }, ORIGIN)).toBe(false)
  })

  it('is false for a new-tab target', () => {
    expect(isSoftNavClick({ ...baseClick, target: '_blank' }, ORIGIN)).toBe(false)
  })

  it('is true for an explicit _self target', () => {
    expect(isSoftNavClick({ ...baseClick, target: '_self' }, ORIGIN)).toBe(true)
  })

  it('is false for a download link', () => {
    expect(isSoftNavClick({ ...baseClick, download: true }, ORIGIN)).toBe(false)
  })

  it('is false for a link opted out with data-astro-reload', () => {
    expect(isSoftNavClick({ ...baseClick, reload: true }, ORIGIN)).toBe(false)
  })

  it('is false for a non-primary button click', () => {
    expect(isSoftNavClick({ ...baseClick, button: 1 }, ORIGIN)).toBe(false)
  })

  it('is false when a modifier key is held (new tab / window / download)', () => {
    expect(isSoftNavClick({ ...baseClick, metaKey: true }, ORIGIN)).toBe(false)
    expect(isSoftNavClick({ ...baseClick, ctrlKey: true }, ORIGIN)).toBe(false)
    expect(isSoftNavClick({ ...baseClick, altKey: true }, ORIGIN)).toBe(false)
    expect(isSoftNavClick({ ...baseClick, shiftKey: true }, ORIGIN)).toBe(false)
  })
})

describe('shouldConfirmBeforeNavigating', () => {
  it('is false when no batch is running, even for an interceptable click', () => {
    expect(shouldConfirmBeforeNavigating(false, baseClick, ORIGIN)).toBe(false)
  })

  it('is true when a batch is running and the click would soft-navigate', () => {
    expect(shouldConfirmBeforeNavigating(true, baseClick, ORIGIN)).toBe(true)
  })

  it('is false when a batch is running but the click would not soft-navigate', () => {
    expect(shouldConfirmBeforeNavigating(true, { ...baseClick, target: '_blank' }, ORIGIN)).toBe(false)
  })
})
