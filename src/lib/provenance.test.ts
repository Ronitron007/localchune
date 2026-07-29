// src/lib/provenance.test.ts
// localchune — MIT licensed. See LICENSE.
import { describe, expect, it } from 'vitest'
import { formatTagDate, sourceLine } from './provenance'

describe('formatTagDate', () => {
  it('formats an iTunes purchase_date (date + time) to day month year', () => {
    expect(formatTagDate('2023-11-06 06:55:31')).toBe('6 Nov 2023')
  })
  it('formats a date-only value', () => {
    expect(formatTagDate('2017-06-09')).toBe('9 Jun 2017')
  })
  it('passes a bare year through', () => {
    expect(formatTagDate('2017')).toBe('2017')
  })
  it('does not zero-pad the day', () => {
    expect(formatTagDate('2020-01-09')).toBe('9 Jan 2020')
  })
  it('returns null for junk, empty and nullish input', () => {
    expect(formatTagDate('not a date')).toBeNull()
    expect(formatTagDate('')).toBeNull()
    expect(formatTagDate(null)).toBeNull()
    expect(formatTagDate(undefined)).toBeNull()
  })
  it('refuses an out-of-range month or day instead of inventing one', () => {
    expect(formatTagDate('2020-13-01')).toBeNull()
    expect(formatTagDate('2020-00-01')).toBeNull()
    expect(formatTagDate('2020-01-32')).toBeNull()
  })
  it('never shifts the calendar day (no Date round-trip)', () => {
    // A TZ-sensitive implementation would render 5 Nov in UTC-negative
    // zones for a midnight timestamp.
    expect(formatTagDate('2023-11-06 00:00:00')).toBe('6 Nov 2023')
  })
})

describe('sourceLine', () => {
  it('derives an iTunes purchase with its date from purchase_date', () => {
    expect(sourceLine({ purchase_date: '2023-11-06 06:55:31' }, '02 GOLD.m4a'))
      .toBe('iTunes purchase · 6 Nov 2023')
  })
  it('derives iTunes from Apple-atom presence alone, without a date', () => {
    expect(sourceLine({ apple: true }, 'track.m4a')).toBe('iTunes purchase')
  })
  it('falls back to the label without a date when purchase_date is junk', () => {
    expect(sourceLine({ purchase_date: 'soon' }, 'x.m4a')).toBe('iTunes purchase')
  })
  it('derives Beatport from the leading-track-id filename pattern', () => {
    expect(sourceLine({}, '1234567_Some Track_(Original Mix).mp3')).toBe('Beatport')
    expect(sourceLine(null, '12345678_Another_(Extended Mix).aiff')).toBe('Beatport')
  })
  it('does not call a short leading number Beatport', () => {
    expect(sourceLine({}, '01_intro.mp3')).toBeNull()
    expect(sourceLine({}, '12345_track.mp3')).toBeNull()
  })
  it('prefers the purchase receipt over a Beatport-looking filename', () => {
    expect(sourceLine({ purchase_date: '2023-11-06 06:55:31' }, '1234567_x.mp3'))
      .toBe('iTunes purchase · 6 Nov 2023')
  })
  it('returns null when nothing marks a store', () => {
    expect(sourceLine({}, 'Artist - Title.flac')).toBeNull()
    expect(sourceLine(null, null)).toBeNull()
    expect(sourceLine(undefined, undefined)).toBeNull()
  })
})
