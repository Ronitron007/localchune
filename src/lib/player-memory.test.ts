// src/lib/player-memory.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  PLAYER_MEMORY_TTL_MS, isStale, makeEntry, parseEntry, serializeEntry,
  type PlayerMemoryEntry,
} from './player-memory'

const NOW = Date.parse('2026-07-28T12:00:00.000Z')

describe('makeEntry', () => {
  it('floors position_s and stamps updated_at as ISO', () => {
    const entry = makeEntry('file-1', 'DJ Sten — Night Drive', 12.9, NOW)
    expect(entry).toEqual({
      file_id: 'file-1',
      title: 'DJ Sten — Night Drive',
      position_s: 12,
      updated_at: '2026-07-28T12:00:00.000Z',
    })
  })

  it('clamps a negative position to zero', () => {
    expect(makeEntry('file-1', 'x', -5, NOW).position_s).toBe(0)
  })
})

describe('serializeEntry / parseEntry round trip', () => {
  it('parses exactly what it serialized', () => {
    const entry = makeEntry('file-1', 'x', 30, NOW)
    expect(parseEntry(serializeEntry(entry))).toEqual(entry)
  })
})

describe('parseEntry', () => {
  it('is null for a missing value', () => {
    expect(parseEntry(null)).toBeNull()
  })

  it('is null for corrupt JSON', () => {
    expect(parseEntry('{not json')).toBeNull()
  })

  it('is null for a JSON value that is not an object', () => {
    expect(parseEntry('"just a string"')).toBeNull()
    expect(parseEntry('42')).toBeNull()
    expect(parseEntry('null')).toBeNull()
  })

  it('is null when file_id is missing, empty, or non-string', () => {
    const base = { title: 'x', position_s: 1, updated_at: '2026-07-28T12:00:00.000Z' }
    expect(parseEntry(JSON.stringify(base))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, file_id: '' }))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, file_id: 7 }))).toBeNull()
  })

  it('is null when title is missing or non-string', () => {
    const base = { file_id: 'f', position_s: 1, updated_at: '2026-07-28T12:00:00.000Z' }
    expect(parseEntry(JSON.stringify(base))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, title: 9 }))).toBeNull()
  })

  it('is null when position_s is missing, negative, non-finite, or non-numeric', () => {
    const base = { file_id: 'f', title: 'x', updated_at: '2026-07-28T12:00:00.000Z' }
    expect(parseEntry(JSON.stringify(base))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, position_s: -1 }))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, position_s: Infinity }))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, position_s: '30' }))).toBeNull()
  })

  it('accepts position_s of exactly zero', () => {
    const raw = JSON.stringify({ file_id: 'f', title: 'x', position_s: 0, updated_at: '2026-07-28T12:00:00.000Z' })
    expect(parseEntry(raw)?.position_s).toBe(0)
  })

  it('is null when updated_at is missing or unparseable', () => {
    const base = { file_id: 'f', title: 'x', position_s: 1 }
    expect(parseEntry(JSON.stringify(base))).toBeNull()
    expect(parseEntry(JSON.stringify({ ...base, updated_at: 'not a date' }))).toBeNull()
  })

  it('ignores unknown extra fields (forward compatible with a wider schema)', () => {
    const raw = JSON.stringify({
      file_id: 'f', title: 'x', position_s: 1, updated_at: '2026-07-28T12:00:00.000Z',
      audio_url: 'https://example.com/should-be-ignored.mp3',
    })
    const entry = parseEntry(raw)
    expect(entry).toEqual({
      file_id: 'f', title: 'x', position_s: 1, updated_at: '2026-07-28T12:00:00.000Z',
    })
    expect(entry).not.toHaveProperty('audio_url')
  })
})

describe('isStale', () => {
  const fresh = (ageMs: number): PlayerMemoryEntry =>
    makeEntry('f', 'x', 0, NOW - ageMs)

  it('is false for an entry saved just now', () => {
    expect(isStale(fresh(0), NOW)).toBe(false)
  })

  it('is false one millisecond inside the ttl', () => {
    expect(isStale(fresh(PLAYER_MEMORY_TTL_MS - 1), NOW)).toBe(false)
  })

  it('is false exactly at the ttl boundary', () => {
    expect(isStale(fresh(PLAYER_MEMORY_TTL_MS), NOW)).toBe(false)
  })

  it('is true one millisecond past the ttl', () => {
    expect(isStale(fresh(PLAYER_MEMORY_TTL_MS + 1), NOW)).toBe(true)
  })

  it('is true for a 30-day-old entry (well past 14 days)', () => {
    expect(isStale(fresh(30 * 24 * 60 * 60 * 1000), NOW)).toBe(true)
  })

  it('is true when updated_at cannot be parsed', () => {
    const entry: PlayerMemoryEntry = { file_id: 'f', title: 'x', position_s: 0, updated_at: 'garbage' }
    expect(isStale(entry, NOW)).toBe(true)
  })
})
