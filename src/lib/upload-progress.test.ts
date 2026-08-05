// src/lib/upload-progress.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  DONE_LINGER_MS, aggregateUploads, chipAnnouncement, chipPhase, chipText, chipVisible,
  isUploadPage, type ProgressRow, type RowStatus,
} from './upload-progress'

const row = (status: RowStatus, size = 100, loaded = 0): ProgressRow => ({ status, size, loaded })

describe('aggregateUploads', () => {
  it('returns an all-zero aggregate for an empty queue', () => {
    expect(aggregateUploads([])).toEqual({
      total: 0, finished: 0, failed: 0, pending: 0, inFlight: 0,
      sentBytes: 0, totalBytes: 0, percent: 0,
    })
  })

  it('counts done and already as finished', () => {
    const agg = aggregateUploads([row('done', 100, 100), row('already', 100, 100)])
    expect(agg.finished).toBe(2)
    expect(agg.total).toBe(2)
  })

  it('counts failed and cancelled as failed', () => {
    const agg = aggregateUploads([row('failed'), row('cancelled')])
    expect(agg.failed).toBe(2)
  })

  it('counts queued and checking as pending, uploading as in-flight', () => {
    const agg = aggregateUploads([row('queued'), row('checking'), row('uploading', 100, 50)])
    expect(agg.pending).toBe(2)
    expect(agg.inFlight).toBe(1)
  })

  it('excludes skipped rows from every count and from both byte totals', () => {
    const agg = aggregateUploads([row('done', 100, 100), row('skipped', 900, 0)])
    expect(agg.total).toBe(1)
    expect(agg.totalBytes).toBe(100)
    expect(agg.sentBytes).toBe(100)
    // The regression this guards: a skipped file in the denominator caps a
    // finished batch below 100% forever.
    expect(agg.percent).toBe(100)
  })

  it('weights percent by bytes, not by file count', () => {
    // One tiny finished file and one huge untouched one is nowhere near 50%.
    const agg = aggregateUploads([row('done', 1, 1), row('queued', 999, 0)])
    expect(agg.finished).toBe(1)
    expect(agg.total).toBe(2)
    expect(agg.percent).toBe(0)
  })

  it('sums partial progress from an in-flight row', () => {
    const agg = aggregateUploads([row('uploading', 200, 50), row('done', 200, 200)])
    expect(agg.sentBytes).toBe(250)
    expect(agg.totalBytes).toBe(400)
    expect(agg.percent).toBe(63)
  })

  it('reports 0% rather than NaN when every row is zero bytes', () => {
    const agg = aggregateUploads([row('queued', 0, 0)])
    expect(agg.totalBytes).toBe(0)
    expect(agg.percent).toBe(0)
  })

  it('clamps percent to 100 if a row over-reports loaded bytes', () => {
    expect(aggregateUploads([row('uploading', 100, 250)]).percent).toBe(100)
  })
})

describe('chipPhase', () => {
  it('is idle for an empty queue', () => {
    expect(chipPhase(aggregateUploads([]))).toBe('idle')
  })

  it('is idle when every row was skipped', () => {
    expect(chipPhase(aggregateUploads([row('skipped'), row('skipped')]))).toBe('idle')
  })

  it('is active while anything is pending', () => {
    expect(chipPhase(aggregateUploads([row('queued')]))).toBe('active')
  })

  it('is active while anything is in flight', () => {
    expect(chipPhase(aggregateUploads([row('uploading', 100, 10)]))).toBe('active')
  })

  it('stays active when live files sit alongside failed ones', () => {
    // "3 failed" while bytes are still moving reads as "it stopped".
    expect(chipPhase(aggregateUploads([row('failed'), row('uploading', 100, 10)]))).toBe('active')
  })

  it('is failed once everything settled and something failed', () => {
    expect(chipPhase(aggregateUploads([row('failed'), row('done', 100, 100)]))).toBe('failed')
  })

  it('is done once everything settled cleanly', () => {
    expect(chipPhase(aggregateUploads([row('done', 100, 100), row('already', 100, 100)]))).toBe('done')
  })
})

describe('chipText', () => {
  it('renders finished/total and byte percent while active', () => {
    const rows = [
      ...Array.from({ length: 14 }, () => row('done', 100, 100)),
      ...Array.from({ length: 54 }, () => row('queued', 100, 0)),
    ]
    const agg = aggregateUploads(rows)
    expect(agg.total).toBe(68)
    expect(chipText(agg)).toBe('▲ 14/68 · 21%')
  })

  it('renders the failed count once settled', () => {
    const agg = aggregateUploads([row('failed'), row('failed'), row('cancelled')])
    expect(chipText(agg)).toBe('▲ 3 failed')
  })

  it('renders done for a clean finish', () => {
    expect(chipText(aggregateUploads([row('done', 100, 100)]))).toBe('▲ done')
  })

  it('renders nothing when idle', () => {
    expect(chipText(aggregateUploads([]))).toBe('')
  })

  it('honours an explicitly passed phase', () => {
    const agg = aggregateUploads([row('done', 100, 100)])
    expect(chipText(agg, 'idle')).toBe('')
  })
})

describe('chipAnnouncement', () => {
  it('says nothing while active — a ticking percent must not be narrated', () => {
    expect(chipAnnouncement(aggregateUploads([row('uploading', 100, 40)]))).toBe('')
  })

  it('says nothing when idle', () => {
    expect(chipAnnouncement(aggregateUploads([]))).toBe('')
  })

  it('announces a clean finish with the file count', () => {
    const agg = aggregateUploads([row('done', 1, 1), row('already', 1, 1)])
    expect(chipAnnouncement(agg)).toBe('Uploads finished — 2 files.')
  })

  it('announces failures', () => {
    expect(chipAnnouncement(aggregateUploads([row('failed'), row('cancelled')])))
      .toBe('2 uploads failed.')
  })

  it('singularises both messages', () => {
    expect(chipAnnouncement(aggregateUploads([row('done', 1, 1)])))
      .toBe('Uploads finished — 1 file.')
    expect(chipAnnouncement(aggregateUploads([row('failed')]))).toBe('1 upload failed.')
  })
})

describe('isUploadPage', () => {
  it('is true for /upload', () => {
    expect(isUploadPage('/upload')).toBe(true)
  })

  it('is true for /upload with a query string or hash', () => {
    expect(isUploadPage('/upload?resume=1')).toBe(true)
    expect(isUploadPage('/upload#queue')).toBe(true)
  })

  it('is false for /uploads, which is a different page', () => {
    // The one substring trap in this app's route table: "My uploads".
    expect(isUploadPage('/uploads')).toBe(false)
  })

  it('is false for every other route', () => {
    expect(isUploadPage('/')).toBe(false)
    expect(isUploadPage('/crates')).toBe(false)
    expect(isUploadPage('/track/abc')).toBe(false)
  })
})

describe('chipVisible', () => {
  it('is hidden on /upload even mid-batch, where the real queue renders', () => {
    expect(chipVisible({ phase: 'active', pathname: '/upload', sinceSettledMs: 0 })).toBe(false)
  })

  it('is visible on every other page while active', () => {
    expect(chipVisible({ phase: 'active', pathname: '/', sinceSettledMs: 0 })).toBe(true)
    expect(chipVisible({ phase: 'active', pathname: '/uploads', sinceSettledMs: 0 })).toBe(true)
    expect(chipVisible({ phase: 'active', pathname: '/track/abc', sinceSettledMs: 0 })).toBe(true)
  })

  it('is hidden when idle', () => {
    expect(chipVisible({ phase: 'idle', pathname: '/', sinceSettledMs: 0 })).toBe(false)
  })

  it('lingers on done, then hides', () => {
    expect(chipVisible({ phase: 'done', pathname: '/', sinceSettledMs: 0 })).toBe(true)
    expect(chipVisible({ phase: 'done', pathname: '/', sinceSettledMs: DONE_LINGER_MS - 1 })).toBe(true)
    expect(chipVisible({ phase: 'done', pathname: '/', sinceSettledMs: DONE_LINGER_MS })).toBe(false)
  })

  it('keeps a failed batch on screen indefinitely — it is a task, not a notice', () => {
    expect(chipVisible({ phase: 'failed', pathname: '/', sinceSettledMs: 0 })).toBe(true)
    expect(chipVisible({ phase: 'failed', pathname: '/', sinceSettledMs: 60 * 60 * 1000 })).toBe(true)
  })

  it('still hides a failed batch on /upload, where Retry lives', () => {
    expect(chipVisible({ phase: 'failed', pathname: '/upload', sinceSettledMs: 0 })).toBe(false)
  })
})
