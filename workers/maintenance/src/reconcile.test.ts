// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { deletablePendingObjects, reconcile, type DbFile, type R2ObjectRow } from './reconcile'

const row = (key: string, state: string, size: number): DbFile => ({
  r2_key: key,
  state,
  byte_size: size,
})
const obj = (key: string, size: number): R2ObjectRow => ({ key, size })

describe('reconcile', () => {
  it('reports nothing when the bucket and the table agree', () => {
    const d = reconcile([row('audio/u/1.flac', 'stored', 100)], [obj('audio/u/1.flac', 100)])
    expect(d.missingObjects).toEqual([])
    expect(d.orphanObjects).toEqual([])
    expect(d.sizeMismatches).toEqual([])
    expect(d.pendingDeletion).toEqual([])
  })

  it('flags a row that holds bytes but has no object', () => {
    const d = reconcile([row('audio/u/1.flac', 'stored', 100)], [])
    expect(d.missingObjects).toEqual([{ key: 'audio/u/1.flac', state: 'stored' }])
    expect(d.orphanObjects).toEqual([])
  })

  it('flags a size disagreement', () => {
    const d = reconcile([row('audio/u/1.flac', 'received', 100)], [obj('audio/u/1.flac', 99)])
    expect(d.sizeMismatches).toEqual([{ key: 'audio/u/1.flac', expected: 100, actual: 99 }])
    expect(d.missingObjects).toEqual([])
  })

  it('flags an object with no row at all', () => {
    const d = reconcile([], [obj('audio/u/ghost.flac', 7)])
    expect(d.orphanObjects).toEqual([{ key: 'audio/u/ghost.flac', size: 7 }])
  })

  it('ignores in-flight uploads in both directions', () => {
    // pending/uploading rows are the sweeper's business, not the
    // reconcile's. Absent object = still uploading. Present object = a
    // single PUT that landed before its finalize call. Neither is drift.
    const d = reconcile(
      [row('audio/u/a.wav', 'uploading', 10), row('audio/u/b.wav', 'pending', 10)],
      [obj('audio/u/a.wav', 10)],
    )
    expect(d.missingObjects).toEqual([])
    expect(d.orphanObjects).toEqual([])
    expect(d.sizeMismatches).toEqual([])
    expect(d.pendingDeletion).toEqual([])
  })

  it('reports a terminal row whose object is still present as pending deletion', () => {
    const d = reconcile(
      [row('audio/u/q.flac', 'quarantined', 100), row('audio/u/x.flac', 'abandoned', 100)],
      [obj('audio/u/q.flac', 100)],
    )
    expect(d.pendingDeletion).toEqual([{ key: 'audio/u/q.flac', state: 'quarantined' }])
    expect(d.orphanObjects).toEqual([])
    expect(d.missingObjects).toEqual([])
  })
})

describe('deletablePendingObjects', () => {
  it('includes failed and abandoned rows whose object still exists', () => {
    const d = reconcile(
      [row('audio/u/a.mp3', 'failed', 10), row('audio/u/b.mp3', 'abandoned', 10)],
      [obj('audio/u/a.mp3', 10), obj('audio/u/b.mp3', 10)],
    )
    expect(deletablePendingObjects(d)).toEqual([
      { key: 'audio/u/a.mp3', state: 'failed' },
      { key: 'audio/u/b.mp3', state: 'abandoned' },
    ])
  })

  // Critical #1's belt-and-braces flag must never touch these — they are
  // M3-owned states where a human, not a cron, decides what happens to the
  // object (e.g. keeping a quarantined file as evidence).
  it('excludes quarantined and rejected_* even though they are pendingDeletion too', () => {
    const d = reconcile(
      [
        row('audio/u/c.mp3', 'quarantined', 10),
        row('audio/u/d.mp3', 'rejected_duration', 10),
        row('audio/u/e.mp3', 'rejected_redundant', 10),
      ],
      [obj('audio/u/c.mp3', 10), obj('audio/u/d.mp3', 10), obj('audio/u/e.mp3', 10)],
    )
    expect(d.pendingDeletion).toHaveLength(3)
    expect(deletablePendingObjects(d)).toEqual([])
  })

  it('is empty when there is nothing pending deletion', () => {
    const d = reconcile([row('audio/u/f.mp3', 'stored', 10)], [obj('audio/u/f.mp3', 10)])
    expect(deletablePendingObjects(d)).toEqual([])
  })
})

// Migration 33. A member deleted their own upload; upload_delete()
// tombstoned the row and /api/track/[id]/delete then issued the object
// delete BEST-EFFORT, swallowing any failure on purpose. These two cases
// are the whole contract this job owes that route.
describe('a deleted tombstone', () => {
  it('is NOT drift once the object is really gone — that is the steady state', () => {
    const d = reconcile([row('audio/u/g.flac', 'deleted', 10)], [])
    expect(d.missingObjects).toEqual([])
    expect(d.pendingDeletion).toEqual([])
    expect(d.sizeMismatches).toEqual([])
    expect(d.orphanObjects).toEqual([])
  })

  // The route's delete failed (R2 hiccup, expired credential). The bytes
  // are still billed and nothing will ever serve them, so this job is the
  // backstop that finishes the job rather than a reporter of corruption.
  it('is swept when the route could not reclaim the object', () => {
    const d = reconcile([row('audio/u/h.flac', 'deleted', 10)], [obj('audio/u/h.flac', 10)])
    expect(d.missingObjects).toEqual([])
    expect(d.pendingDeletion).toEqual([{ key: 'audio/u/h.flac', state: 'deleted' }])
    expect(deletablePendingObjects(d)).toEqual([{ key: 'audio/u/h.flac', state: 'deleted' }])
  })
})
