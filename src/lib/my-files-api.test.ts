// src/lib/my-files-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import { groupFilesByBatch, type MyFile } from './my-files-api'

const file = (over: Partial<MyFile>): MyFile => ({
  file_id: 'f0', original_filename: 'x.flac', state: 'stored', last_error: null,
  byte_size: 100, created_at: '2026-01-01T00:00:00Z', batch_id: 'b0',
  batch_label: null, bpm: null, key_camelot: null, ...over,
})

describe('groupFilesByBatch', () => {
  it('returns nothing for an empty list', () => {
    expect(groupFilesByBatch([])).toEqual([])
  })

  it('keeps files from the same batch together, in their given order', () => {
    const files = [
      file({ file_id: 'a', batch_id: 'b1' }),
      file({ file_id: 'b', batch_id: 'b1' }),
    ]
    const groups = groupFilesByBatch(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].files.map((f) => f.file_id)).toEqual(['a', 'b'])
  })

  it('orders groups by the first row each batch appears in — my_files() is already newest-first', () => {
    const files = [
      file({ file_id: 'a', batch_id: 'newer' }),
      file({ file_id: 'b', batch_id: 'older' }),
      file({ file_id: 'c', batch_id: 'newer' }),
    ]
    const groups = groupFilesByBatch(files)
    expect(groups.map((g) => g.batch_id)).toEqual(['newer', 'older'])
  })

  it('does not split a batch into two groups when its rows are interleaved with another batch', () => {
    const files = [
      file({ file_id: 'a', batch_id: 'x' }),
      file({ file_id: 'b', batch_id: 'y' }),
      file({ file_id: 'c', batch_id: 'x' }),
    ]
    const groups = groupFilesByBatch(files)
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.batch_id === 'x')?.files.map((f) => f.file_id)).toEqual(['a', 'c'])
  })

  it('carries the batch label through once per group', () => {
    const files = [file({ file_id: 'a', batch_id: 'b1', batch_label: 'Friday drop' })]
    expect(groupFilesByBatch(files)[0].batch_label).toBe('Friday drop')
  })

  it('reports a null label for an unlabelled batch', () => {
    const files = [file({ file_id: 'a', batch_id: 'b1', batch_label: null })]
    expect(groupFilesByBatch(files)[0].batch_label).toBeNull()
  })
})
