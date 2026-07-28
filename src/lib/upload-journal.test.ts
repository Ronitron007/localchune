// src/lib/upload-journal.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  journalKey, rememberFile, lookupFile, forgetFile, pruneJournal,
  JOURNAL_TTL_MS,
} from './upload-journal'

const USER = '00000000-0000-0000-0000-0000000000e1'
const identity = { name: 'Artist - Title.flac', size: 40_000_000, lastModified: 1_700_000_000_000 }

describe('journalKey', () => {
  it('is userId|size|lastModified|name', () => {
    expect(journalKey(USER, identity))
      .toBe(`${USER}|40000000|1700000000000|Artist - Title.flac`)
  })

  it('changes when only lastModified changes', () => {
    expect(journalKey(USER, { ...identity, lastModified: identity.lastModified + 1 }))
      .not.toBe(journalKey(USER, identity))
  })

  it('changes when only the size changes', () => {
    expect(journalKey(USER, { ...identity, size: identity.size + 1 }))
      .not.toBe(journalKey(USER, identity))
  })

  it('is stable across two picks of the same file', () => {
    expect(journalKey(USER, { ...identity })).toBe(journalKey(USER, { ...identity }))
  })

  it('cannot be forged by a pipe in the filename', () => {
    // The free-form field is LAST, behind a uuid and two integers, so no
    // filename can impersonate another file's key. This is why the field
    // order is not the name|size|lastModified of the prose.
    const sneaky = journalKey(USER, { name: '1|2|real.flac', size: 9, lastModified: 9 })
    const real = journalKey(USER, { name: 'real.flac', size: 9, lastModified: 9 })
    expect(sneaky).not.toBe(real)
  })
})

describe('the in-memory fallback (node has no indexedDB)', () => {
  const key = journalKey(USER, identity)

  beforeEach(async () => {
    await forgetFile(key)
  })

  it('remembers and looks up a file id', async () => {
    await rememberFile({
      key, userId: USER, fileId: 'f1', batchId: 'b1',
      name: identity.name, size: identity.size, lastModified: identity.lastModified,
    })
    const hit = await lookupFile(key)
    expect(hit?.fileId).toBe('f1')
    expect(hit?.batchId).toBe('b1')
  })

  it('returns null for a key it has never seen', async () => {
    expect(await lookupFile('nope')).toBeNull()
  })

  it('forgets a key', async () => {
    await rememberFile({
      key, userId: USER, fileId: 'f1', batchId: 'b1',
      name: identity.name, size: identity.size, lastModified: identity.lastModified,
    })
    await forgetFile(key)
    expect(await lookupFile(key)).toBeNull()
  })

  it('prunes entries older than the TTL and keeps fresh ones', async () => {
    const now = 2_000_000_000_000
    await rememberFile({
      key: 'stale', userId: USER, fileId: 'old', batchId: 'b0',
      name: 'a.mp3', size: 1, lastModified: 1,
    }, now - JOURNAL_TTL_MS - 1)
    await rememberFile({
      key: 'fresh', userId: USER, fileId: 'new', batchId: 'b0',
      name: 'b.mp3', size: 1, lastModified: 1,
    }, now)
    await pruneJournal(now)
    expect(await lookupFile('stale')).toBeNull()
    expect((await lookupFile('fresh'))?.fileId).toBe('new')
  })
})
