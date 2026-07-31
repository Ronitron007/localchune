import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATUS,
  bandFor,
  barHeightPct,
  divergencePeakSecond,
  formatDelta,
  formatLength,
  formatScore,
  parseReviewQuery,
  reviewHref,
} from './review-api'

const parse = (s: string) => parseReviewQuery(new URLSearchParams(s))

// The CALIBRATED numbers (migration 29), not the seeded ones. If these ever
// disagree with dedup_config the review page and the matcher are banding the
// same score two different ways.
const CALIBRATED = { t_same: 0.9, t_probable: 0.8, t_related: 0.78 }

describe('bandFor', () => {
  it('reads the thresholds it is given, never a constant', () => {
    // dedup_config exists so a recalibration is an UPDATE, not a deploy. A
    // hardcoded 0.9 in here would put the numbers back into code.
    const seeded = { t_same: 0.9, t_probable: 0.7, t_related: 0.4 }
    expect(bandFor(0.75, seeded)).toBe('probable')
    expect(bandFor(0.75, CALIBRATED)).toBe('different')
  })

  it('treats every lower bound as inclusive', () => {
    expect(bandFor(0.9, CALIBRATED)).toBe('same')
    expect(bandFor(0.8, CALIBRATED)).toBe('probable')
    expect(bandFor(0.78, CALIBRATED)).toBe('related')
  })

  it('bands the measured production landmarks the way the calibration intends', () => {
    // The lowest verified true merge on production, and the highest score
    // any unrelated pair reached across 3404 observations.
    expect(bandFor(0.966014, CALIBRATED)).toBe('same')
    expect(bandFor(0.765937, CALIBRATED)).toBe('different')
    // Blue Monday m4a vs mp3 — the one genuinely ambiguous pair in the pool.
    expect(bandFor(0.814716, CALIBRATED)).toBe('probable')
    // "Feeling For You", original vs DJ tool: nowhere near a merge.
    expect(bandFor(0.666096, CALIBRATED)).toBe('different')
  })

  it('calls a nonsense score different rather than throwing', () => {
    expect(bandFor(Number.NaN, CALIBRATED)).toBe('different')
  })
})

describe('divergencePeakSecond', () => {
  it('finds where two tracks stop agreeing', () => {
    expect(divergencePeakSecond([0.01, 0.01, 0.4, 0.02])).toBe(2)
  })

  it('returns 0 for a strip with no divergence at all', () => {
    expect(divergencePeakSecond([0, 0, 0])).toBe(0)
    expect(divergencePeakSecond([])).toBe(0)
  })

  it('returns 0 for a layer-0 merge, which has no strip', () => {
    // content_sha256 and fp_sha256 merges never score per-second. The page
    // must render them, so this cannot throw.
    expect(divergencePeakSecond(null)).toBe(0)
    expect(divergencePeakSecond(undefined)).toBe(0)
  })

  it('backs off so the snippet starts BEFORE the divergence', () => {
    expect(divergencePeakSecond([0, 0, 0, 0, 0, 0, 0.9], { leadIn: 2 })).toBe(4)
  })

  it('never backs off past the start of the file', () => {
    expect(divergencePeakSecond([0.9, 0.1], { leadIn: 2 })).toBe(0)
  })

  it('keeps the FIRST of two equal peaks', () => {
    expect(divergencePeakSecond([0.1, 0.5, 0.2, 0.5])).toBe(1)
  })

  it('gives ComparePanel two DIFFERENT seconds, which is the point', () => {
    // The strip outlines the peak; the play links open earlier. Passing the
    // backed-off value to both would put the highlight on a bar that is
    // identical in the two files — the one bar carrying no information.
    const ber = [0.01, 0.02, 0.44, 0.03]
    const peakAt = divergencePeakSecond(ber, { leadIn: 0 })
    const startAt = divergencePeakSecond(ber, { leadIn: 2 })
    expect(peakAt).toBe(2)
    expect(startAt).toBe(0)
    expect(startAt).toBeLessThanOrEqual(peakAt)
  })
})

describe('parseReviewQuery', () => {
  it('defaults to pending', () => {
    expect(parse('')).toBe(DEFAULT_STATUS)
    expect(parse('')).toBe('pending')
  })

  it('accepts the three real statuses', () => {
    expect(parse('status=resolved')).toBe('resolved')
    expect(parse('status=all')).toBe('all')
    expect(parse('status=pending')).toBe('pending')
  })

  it('degrades a stale or hand-edited URL to pending rather than erroring', () => {
    expect(parse('status=nonsense')).toBe('pending')
    expect(parse('status=')).toBe('pending')
  })
})

describe('reviewHref', () => {
  it('omits the default so a shared link is the short one', () => {
    expect(reviewHref('pending')).toBe('/review')
    expect(reviewHref('all')).toBe('/review?status=all')
  })
})

describe('formatDelta', () => {
  it('keeps the sign, because it says which side is longer', () => {
    expect(formatDelta(3749)).toBe('+4s')
    expect(formatDelta(-3749)).toBe('-4s')
  })

  it('breaks a big delta into minutes', () => {
    expect(formatDelta(-124531)).toBe('-2m 05s')
    expect(formatDelta(153000)).toBe('+2m 33s')
  })

  it('says so when there is nothing in it', () => {
    expect(formatDelta(0)).toBe('same length')
    expect(formatDelta(400)).toBe('same length')
  })

  it('says unknown rather than 0 when the column is null', () => {
    expect(formatDelta(null)).toBe('unknown')
    expect(formatDelta(undefined)).toBe('unknown')
  })
})

describe('formatLength', () => {
  it('renders mm:ss with a padded seconds field', () => {
    expect(formatLength(300000)).toBe('5:00')
    expect(formatLength(431519)).toBe('7:12')
  })

  it('renders an em dash rather than 0:00 for a missing duration', () => {
    expect(formatLength(null)).toBe('—')
    expect(formatLength(0)).toBe('—')
  })
})

describe('formatScore', () => {
  it('shows three decimals so 0.966 and 0.999 are visibly different', () => {
    expect(formatScore(0.966014)).toBe('0.966')
    expect(formatScore(1)).toBe('1.000')
  })

  it('renders a missing score as an em dash', () => {
    expect(formatScore(null)).toBe('—')
  })
})

describe('barHeightPct', () => {
  it('clamps at half the bits differing — above that the pair is just unrelated', () => {
    expect(barHeightPct(0.5)).toBe(100)
    expect(barHeightPct(0.9)).toBe(100)
  })

  it('keeps a floor so a zero-divergence second is still a visible tick', () => {
    expect(barHeightPct(0)).toBe(2)
    expect(barHeightPct(null)).toBe(2)
  })

  it('scales the middle of the range', () => {
    expect(barHeightPct(0.25)).toBe(50)
  })
})
