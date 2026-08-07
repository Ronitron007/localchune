// src/lib/file-state.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  POOL_VISIBLE_STATES, NON_TERMINAL_LABEL, TERMINAL_FAILED_STATES, FAILURE_EXPLAIN,
  RETRYABLE_STATES, explainLastError, stateLabel,
} from './file-state'

// Migration 33's terminal state. The two properties that matter here are
// both about what 'deleted' must NOT be mistaken for.
describe("the 'deleted' state", () => {
  it('is never pool-visible — the object is gone, so no route may presign it', () => {
    expect(POOL_VISIBLE_STATES.has('deleted')).toBe(false)
  })

  it('is not a FAILURE — it is the one terminal state the member chose', () => {
    expect(TERMINAL_FAILED_STATES.has('deleted')).toBe(false)
  })

  it('is not retryable — "try again" beside it would invite an undo that cannot happen', () => {
    expect(RETRYABLE_STATES.has('deleted')).toBe(false)
  })

  it('has copy that says who did it, for /uploads', () => {
    expect(FAILURE_EXPLAIN.deleted).toBe('You deleted this upload. The file is gone for everyone.')
    expect(stateLabel('deleted')).toBe(FAILURE_EXPLAIN.deleted)
  })

  it('never falls through to the raw state name', () => {
    expect(stateLabel('deleted')).not.toBe('deleted')
  })
})

describe('POOL_VISIBLE_STATES', () => {
  // Final-review finding F1: src/pages/api/track/[id]/download.ts and
  // source.ts refuse a presign for any state outside this set. It must
  // match SQL pool_visible_states() (migration 06) byte-for-byte, or the
  // route silently disagrees with bump_download()'s own P0002 refusal.
  it('matches SQL pool_visible_states() exactly', () => {
    expect([...POOL_VISIBLE_STATES].sort()).toEqual(
      ['analysing', 'needs_review', 'received', 'stored'].sort(),
    )
  })

  it('includes stored — the happy-path pool track', () => {
    expect(POOL_VISIBLE_STATES.has('stored')).toBe(true)
  })

  it('excludes the pre-verification states — no object confirmed yet', () => {
    expect(POOL_VISIBLE_STATES.has('pending')).toBe(false)
    expect(POOL_VISIBLE_STATES.has('uploading')).toBe(false)
  })

  it('excludes every terminal-failed state — an abandoned upload has no object left', () => {
    for (const state of TERMINAL_FAILED_STATES) {
      expect(POOL_VISIBLE_STATES.has(state)).toBe(false)
    }
  })

  it('is a subset of every state file-state.ts otherwise knows about', () => {
    const known = new Set([...Object.keys(NON_TERMINAL_LABEL), ...TERMINAL_FAILED_STATES])
    for (const state of POOL_VISIBLE_STATES) expect(known.has(state)).toBe(true)
  })
})

describe('explainLastError', () => {
  it('null and blank stay null — no reason span renders at all', () => {
    expect(explainLastError(null)).toBeNull()
    expect(explainLastError(undefined)).toBeNull()
    expect(explainLastError('')).toBeNull()
    expect(explainLastError('   ')).toBeNull()
  })

  it('maps the incident string — ffprobe CalledProcessError with Invalid data', () => {
    // Verbatim shape of worker/app/main.py's fail(): TypeName: str(e) | stderr
    const raw =
      "CalledProcessError: Command '['ffprobe', '-v', 'error', '-show_streams', " +
      "'-show_format', '-of', 'json', '/tmp/in.flac']' returned non-zero exit " +
      'status 1. | stderr: [flac @ 0x55] Invalid data found when processing input'
    expect(explainLastError(raw)).toBe('The audio file is corrupt or incomplete.')
  })

  it('maps "Invalid data found" even without CalledProcessError around it', () => {
    expect(explainLastError('ffmpeg: Invalid data found when processing input'))
      .toBe('The audio file is corrupt or incomplete.')
  })

  it('maps a CalledProcessError naming ffprobe without the stderr detail', () => {
    expect(explainLastError("CalledProcessError: Command '['ffprobe', …]' returned non-zero exit status 1."))
      .toBe('The audio file is corrupt or incomplete.')
  })

  it('maps a CalledProcessError naming fpcalc', () => {
    expect(explainLastError("CalledProcessError: Command '['fpcalc', '-raw', '/tmp/in.mp3']' returned non-zero exit status 2."))
      .toBe('The audio could not be fingerprinted — the file may be damaged.')
  })

  it('maps a JSONDecodeError', () => {
    expect(explainLastError('JSONDecodeError: Expecting value: line 1 column 1 (char 0)'))
      .toBe('Analysis hit a tag-parsing fault. The team knows; the file will be retried.')
  })

  it('maps the dead-letter consumer reason', () => {
    expect(explainLastError('dead-lettered after 5 attempts'))
      .toBe('Analysis failed after several attempts.')
  })

  it('maps complete.ts upload-phase reasons — never "Analysis failed."', () => {
    expect(explainLastError('complete: no object at the key after upload'))
      .toBe('The upload never fully arrived in storage.')
    expect(explainLastError('complete: size mismatch — declared 1000, object 900'))
      .toBe('The upload never fully arrived in storage.')
  })

  it('maps abort-recorded transfer failures — never "Analysis failed."', () => {
    for (const raw of [
      'R2 returned 503',
      'network error',
      'timed out',
      'no presigned url for part 3',
      'this file is already failed and cannot be resumed',
      'this file no longer matches the upload it was resuming',
      'this upload expired and was cleaned up — it must restart',
      'R2 returned no readable ETag — the bucket CORS rule is missing ExposeHeaders: ["ETag"]',
    ]) {
      expect(explainLastError(raw)).toBe('The upload was interrupted.')
    }
  })

  it('never echoes an unrecognised raw string back — generic fallback', () => {
    const raw = 'MemoryError: essentia blew the 4 GB rlimit at frame 812000'
    expect(explainLastError(raw)).toBe('Analysis failed.')
    expect(explainLastError(raw)).not.toContain('MemoryError')
  })

  it('is case-insensitive about the tool names', () => {
    expect(explainLastError('calledprocesserror … FFPROBE …'))
      .toBe('The audio file is corrupt or incomplete.')
  })
})
