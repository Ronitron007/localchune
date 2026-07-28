// src/lib/build-info.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { REPO_URL, shortSha, sourceUrl } from './build-info'

const SHA = '546f9fa1b2c3d4e5f60718293a4b5c6d7e8f9012'

describe('sourceUrl', () => {
  it('pins the link to the deployed commit — AGPL §13 needs the running version', () => {
    expect(sourceUrl(SHA)).toBe(`${REPO_URL}/tree/${SHA}`)
  })
  it('falls back to the repo root when the commit is unknown or dirty', () => {
    // A dirty tree has no published commit to point at. Linking one would
    // be a link to source that is not the source running.
    expect(sourceUrl('unknown')).toBe(REPO_URL)
    expect(sourceUrl(`${SHA}-dirty`)).toBe(REPO_URL)
  })
})

describe('shortSha', () => {
  it('shows seven characters', () => {
    expect(shortSha(SHA)).toBe('546f9fa')
  })
  it('marks a dirty build so it is never mistaken for a release', () => {
    expect(shortSha(`${SHA}-dirty`)).toBe('546f9fa+')
  })
  it('passes an unknown build through', () => {
    expect(shortSha('unknown')).toBe('unknown')
  })
})
