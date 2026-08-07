// src/lib/track-format.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, expect, it } from 'vitest'
import {
  camelotSortKey, formatBpm, harmonicKeys, keyTooltip, parseCamelot,
  qualityLabel, qualityTooltip, UNKNOWN_SORT_KEY,
} from './track-format'

describe('parseCamelot', () => {
  it('parses both wheel halves', () => {
    expect(parseCamelot('8A')).toEqual({ num: 8, letter: 'A' })
    expect(parseCamelot('12B')).toEqual({ num: 12, letter: 'B' })
  })
  it('accepts lowercase and surrounding space', () => {
    expect(parseCamelot(' 10b ')).toEqual({ num: 10, letter: 'B' })
  })
  it('rejects anything off the wheel', () => {
    expect(parseCamelot('0A')).toBeNull()
    expect(parseCamelot('13A')).toBeNull()
    expect(parseCamelot('8C')).toBeNull()
    expect(parseCamelot('')).toBeNull()
    expect(parseCamelot(null)).toBeNull()
  })
})

describe('camelotSortKey', () => {
  it('is num*10 + (letter === B), so 2A sorts before 10A', () => {
    // The cue-tracks trick. Lexicographic sorting puts '10A' before '2A';
    // this is the three-line fix, mirrored by the SQL in migration 11.
    expect(camelotSortKey('2A')).toBe(20)
    expect(camelotSortKey('10A')).toBe(100)
    expect(camelotSortKey('8B')).toBe(81)
    expect(camelotSortKey('2A') < camelotSortKey('10A')).toBe(true)
  })
  it('sends an unknown key to the end', () => {
    expect(camelotSortKey(null)).toBe(UNKNOWN_SORT_KEY)
    expect(camelotSortKey('nonsense')).toBe(UNKNOWN_SORT_KEY)
    expect(camelotSortKey('12B') < UNKNOWN_SORT_KEY).toBe(true)
  })
})

describe('harmonicKeys', () => {
  it('returns self, +1, -1 and the relative mode', () => {
    expect(harmonicKeys('8A')).toEqual(['8A', '9A', '7A', '8B'])
  })
  it('wraps 12 to 1', () => {
    expect(harmonicKeys('12B')).toEqual(['12B', '1B', '11B', '12A'])
  })
  it('wraps 1 to 12', () => {
    expect(harmonicKeys('1A')).toEqual(['1A', '2A', '12A', '1B'])
  })
  it('is empty for an unparseable key', () => {
    expect(harmonicKeys('nope')).toEqual([])
  })
})

describe('formatBpm', () => {
  it('renders one decimal', () => {
    expect(formatBpm(128, 2)).toBe('128.0')
    expect(formatBpm(174.32, 2)).toBe('174.3')
  })
  it('renders an em dash when no beat was detected', () => {
    // Degraded analysis is DATA, not an error: the worker answers bpm 0
    // for a beatless recording and that must not look like a failure.
    expect(formatBpm(0, 0)).toBe('—')
    expect(formatBpm(null, null)).toBe('—')
    expect(formatBpm(-1, 0)).toBe('—')
  })
  it('prefixes ~ once the beat grid stops being constant', () => {
    // cv = ibi_std_ms * bpm / 60000. PRD 4: cv < 0.02 is a genuinely
    // constant tempo. 128 bpm => mean IBI 468.75 ms, so the threshold is
    // 9.375 ms of standard deviation.
    expect(formatBpm(128, 9)).toBe('128.0')
    expect(formatBpm(128, 10)).toBe('~128.0')
  })
  it('does not prefix when the deviation is unknown', () => {
    expect(formatBpm(128, null)).toBe('128.0')
  })
})

describe('keyTooltip', () => {
  it('names all three profiles it has', () => {
    expect(keyTooltip('8A', '1m', 'Am')).toBe('Camelot 8A · Open Key 1m · A minor')
  })
  it('drops the profiles it does not have', () => {
    expect(keyTooltip('8A', null, null)).toBe('Camelot 8A')
  })
  it('explains the em dash', () => {
    expect(keyTooltip(null, null, null)).toBe('no key detected')
  })
})

describe('qualityLabel / qualityTooltip', () => {
  it('labels the five tiers', () => {
    expect(qualityLabel(5)).toBe('Tier 5')
    expect(qualityLabel(null)).toBe('—')
  })
  it('says MEASURED, and names the measurement', () => {
    expect(qualityTooltip(5, 'suspected', 16800)).toBe(
      'Tier 5 · FLAC/WAV container, measured cutoff 16.8 kHz — transcode suspected')
  })
  it('states a confirmed ancestor plainly', () => {
    expect(qualityTooltip(2, 'confirmed', 15000)).toBe(
      'Tier 2 · measured cutoff 15.0 kHz — lossy ancestor confirmed')
  })
  it('renders abstain as neutral, never accusatory', () => {
    // PRD 7.2: abstain means the detector had nothing to say. Presenting
    // that as suspicion is how a clean rip gets called a fake.
    expect(qualityTooltip(4, 'abstain', null)).toBe(
      'Tier 4 · not enough signal to judge the source')
  })
  it('says nothing at all when there is no analysis', () => {
    expect(qualityTooltip(null, null, null)).toBe('not analysed yet')
  })
})

import { artThumbUrl } from './track-format'

describe('artThumbUrl', () => {
  it('builds the public bucket URL from base + file id', () => {
    expect(artThumbUrl('https://art.example.com', 'abc')).toBe('https://art.example.com/derived/abc/thumb.jpg')
  })
  it('strips trailing slashes from the base', () => {
    expect(artThumbUrl('https://art.example.com/', 'abc')).toBe('https://art.example.com/derived/abc/thumb.jpg')
  })
  it('falls back to the signed route when the env base is unset', () => {
    expect(artThumbUrl(undefined, 'abc')).toBe('/api/track/abc/art?full=1')
  })
})

import { artFallback, artMediumUrl, artThumb2xUrl } from './track-format'

describe('artThumb2xUrl / artMediumUrl', () => {
  it('names the two derivative keys the backfill writes', () => {
    expect(artThumb2xUrl('https://art.example.com', 'abc'))
      .toBe('https://art.example.com/derived/abc/thumb-2x.jpg')
    expect(artMediumUrl('https://art.example.com', 'abc'))
      .toBe('https://art.example.com/derived/abc/medium.jpg')
  })
  it('strips trailing slashes like the thumb builder does', () => {
    expect(artMediumUrl('https://art.example.com//', 'abc'))
      .toBe('https://art.example.com/derived/abc/medium.jpg')
  })
  it('falls back to the signed route when the env base is unset', () => {
    expect(artThumb2xUrl(undefined, 'abc')).toBe('/api/track/abc/art?full=1')
    expect(artMediumUrl(undefined, 'abc')).toBe('/api/track/abc/art?full=1')
  })
  /* The key grammar matters: src/lib/r2.ts only signs a derived key whose
     basename is [a-z0-9][a-z0-9-]*, so `thumb@2x.jpg` would be unsignable
     and the hyphen is not cosmetic. */
  it('uses key names the signer will accept', () => {
    const re = /^derived\/[0-9a-f-]{36}\/[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9]{2,5}$/
    const id = '00e18c90-7419-451f-9908-e6ba5ab1f247'
    for (const url of [artThumb2xUrl('https://a.example', id), artMediumUrl('https://a.example', id)]) {
      expect(url.replace('https://a.example/', '')).toMatch(re)
    }
  })
})

describe('artFallback', () => {
  it('drops the srcset when a 2x candidate is missing', () => {
    expect(artFallback(true, false)).toBe('drop-srcset')
    expect(artFallback(true, true)).toBe('drop-srcset')
  })
  it('sends the hero to the signed full-size original', () => {
    expect(artFallback(false, true)).toBe('signed-full')
  })
  it('leaves a plain failed thumb alone — there is nothing better to show', () => {
    expect(artFallback(false, false)).toBe('none')
  })
})

import { LIKE_ICON, likeActionLabel, trackHref } from './track-format'
import { ICONS, renderIcon } from './icons'

/* The player bar's ♥ and its title link. site.ts writes these into the DOM
 * and cannot be imported here (it touches `document` at module scope), so
 * the three decisions it makes live in the module above and are checked
 * here — the same split queue-view.ts already uses for the drawer. */
describe('trackHref', () => {
  it('points at the detail page for the id it is given', () => {
    expect(trackHref('9f1c0f0e-0000-4000-8000-000000000001'))
      .toBe('/track/9f1c0f0e-0000-4000-8000-000000000001')
  })

  it('encodes the id rather than trusting what came over the wire', () => {
    // A file id is a uuid today. This is what keeps the href honest if a
    // route ever hands back something else — an unencoded `?` or `#` would
    // silently truncate the path into a query or a fragment.
    expect(trackHref('a b?c#d')).toBe('/track/a%20b%3Fc%23d')
  })
})

describe('LIKE_ICON', () => {
  /* It used to be `likeGlyph(liked)` returning '♥' or '♡'. Both are gone:
   * iOS gives U+2665 emoji presentation on its own, so the owner saw a red
   * heart in a monochrome bar — the same font decision that made the
   * transport emoji. The state is no longer a CHOICE OF CHARACTER; it is
   * one path, stroked at rest and filled when liked. */
  it('names a glyph that really exists in the set', () => {
    expect(Object.keys(ICONS)).toContain(LIKE_ICON.name)
  })

  it('is the one glyph whose paint carries the state', () => {
    // `heart` must be STROKED at rest, or "filled when liked" has nothing
    // to say. Every transport glyph is a solid primitive and could not do
    // this — which is why the set draws this one differently.
    expect(ICONS[LIKE_ICON.name]).toContain('fill="none"')
    expect(renderIcon(LIKE_ICON.name, { filled: true })).toContain('fill="currentColor"')
    expect(renderIcon(LIKE_ICON.name, { filled: false })).toContain('fill="none"')
  })

  it('pins the size, because five surfaces render it', () => {
    // TrackRow's pool cell, FeedRow's meta run, track/[id]'s signals block,
    // the player bar and the search overlay. site.ts repaints whichever is
    // on screen the instant a like is toggled, so a surface that picked its
    // own size would visibly resize on first click.
    expect(renderIcon(LIKE_ICON.name, { size: LIKE_ICON.size }))
      .toContain(`width="${LIKE_ICON.size}"`)
  })
})

describe('likeActionLabel', () => {
  it('names the action and the track, and flips with the state', () => {
    expect(likeActionLabel(false, 'Aphex Twin — Xtal')).toBe('Like Aphex Twin — Xtal')
    expect(likeActionLabel(true, 'Aphex Twin — Xtal')).toBe('Unlike Aphex Twin — Xtal')
  })

  it('falls back to the bare verb when there is no title yet', () => {
    // The bar is the one caller that can be in this state: the glyph is
    // aria-hidden, so this string is the whole accessible name, and
    // "Like " with a trailing space is not an answer.
    expect(likeActionLabel(false, '')).toBe('Like')
    expect(likeActionLabel(true, '   ')).toBe('Unlike')
  })
})
