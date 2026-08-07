// src/lib/tag-edit.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// Every case here is `tag_add`'s (migration 16), restated against the
// client. An optimistic chip is a PROMISE about what the server will
// store; where these two rules disagree the page tells the member
// something untrue and then silently corrects itself, which is worse than
// the reload this replaced.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  TAG_CAP, TAG_MAX_LEN, normalizeTag, planTagAdd, tagKey, tagRefusalMessage,
} from './tag-edit'

describe('normalizeTag mirrors btrim(regexp_replace(tag, \'\\s+\', \' \', \'g\'))', () => {
  it('collapses every run of whitespace to one space', () => {
    expect(normalizeTag('peak   time')).toBe('peak time')
    expect(normalizeTag('peak\t\ttime')).toBe('peak time')
    expect(normalizeTag('peak\n time')).toBe('peak time')
  })

  it('trims what the collapse leaves at the ends', () => {
    expect(normalizeTag('  peak time  ')).toBe('peak time')
    expect(normalizeTag('\n\t peak \t')).toBe('peak')
  })

  it('whitespace only is empty, not a tag called " "', () => {
    expect(normalizeTag('   ')).toBe('')
    expect(normalizeTag('\t\n')).toBe('')
  })
})

describe('tagKey mirrors lower(display)', () => {
  it('case folds', () => {
    expect(tagKey('Peak Time')).toBe('peak time')
    expect(tagKey('VINYL-RIP')).toBe('vinyl-rip')
  })
})

describe('planTagAdd', () => {
  it('accepts a normal tag and hands back the NORMALISED display text', () => {
    // The chip must read what the server stores, not what was typed.
    const plan = planTagAdd('  peak   time ', [])
    expect(plan).toEqual({ ok: true, action: 'add', display: 'peak time', key: 'peak time' })
  })

  it('refuses empty', () => {
    expect(planTagAdd('', [])).toEqual({ ok: false, reason: 'empty' })
    expect(planTagAdd('   ', [])).toEqual({ ok: false, reason: 'empty' })
  })

  it(`refuses over ${TAG_MAX_LEN} characters, and accepts exactly ${TAG_MAX_LEN}`, () => {
    expect(planTagAdd('x'.repeat(TAG_MAX_LEN), [])).toMatchObject({ ok: true, action: 'add' })
    expect(planTagAdd('x'.repeat(TAG_MAX_LEN + 1), [])).toEqual({ ok: false, reason: 'too-long' })
  })

  it('measures length AFTER normalising, exactly as tag_add does', () => {
    // tag_add collapses first and length-checks v_display. A raw string of
    // 40 characters that collapses to 20 is a legal tag.
    const raw = 'a'.repeat(20) + ' '.repeat(20)
    expect(planTagAdd(raw, [])).toMatchObject({ ok: true, action: 'add' })
  })

  it('a repeat is a DUPLICATE, not an error — `on conflict do nothing`', () => {
    expect(planTagAdd('techno', ['techno'])).toMatchObject({ ok: true, action: 'duplicate' })
  })

  it('duplicate detection is case- and whitespace-insensitive, like the key', () => {
    expect(planTagAdd('TECHNO', ['techno'])).toMatchObject({ ok: true, action: 'duplicate' })
    expect(planTagAdd('peak time', ['Peak   Time'])).toMatchObject({ ok: true, action: 'duplicate' })
  })

  it(`refuses a NEW tag at ${TAG_CAP}`, () => {
    const full = Array.from({ length: TAG_CAP }, (_, i) => `t${i}`)
    expect(planTagAdd('one-more', full)).toEqual({ ok: false, reason: 'cap' })
  })

  it('but a REPEAT at the cap still succeeds — tag_add counts only new keys', () => {
    // tag_add checks `v_count >= 20` inside `if not v_exists`. A client
    // that checked the cap first would refuse a request the server accepts,
    // which is a client inventing a rule.
    const full = Array.from({ length: TAG_CAP }, (_, i) => `t${i}`)
    expect(planTagAdd('t3', full)).toMatchObject({ ok: true, action: 'duplicate' })
  })

  it('counts DISTINCT keys against the cap, not DOM nodes', () => {
    // A page showing the same tag twice is a bug elsewhere; it must not
    // also cost a slot here.
    const dupes = ['a', 'A', ...Array.from({ length: TAG_CAP - 2 }, (_, i) => `t${i}`)]
    expect(planTagAdd('brand-new', dupes)).toMatchObject({ ok: true, action: 'add' })
  })
})

describe('the refusal messages say what to do next', () => {
  it.each(['empty', 'too-long', 'cap'] as const)('%s is a sentence, not a code', (reason) => {
    const msg = tagRefusalMessage(reason)
    expect(msg.length).toBeGreaterThan(10)
    expect(msg).toMatch(/[.!]$/)
  })

  it('the length and cap messages carry the real numbers', () => {
    expect(tagRefusalMessage('too-long')).toContain(String(TAG_MAX_LEN))
    expect(tagRefusalMessage('cap')).toContain(String(TAG_CAP))
  })
})

describe('the numbers match the server and the markup', () => {
  const migration = readFileSync(
    new URL('../../supabase/migrations/20260729130600_16_file_tags.sql', import.meta.url), 'utf8')

  it('TAG_MAX_LEN is tag_add\'s own limit', () => {
    expect(migration).toContain(`length(v_display) > ${TAG_MAX_LEN}`)
  })

  it('TAG_CAP is tag_add\'s own cap', () => {
    expect(migration).toContain(`v_count >= ${TAG_CAP}`)
  })

  it('the page\'s input maxlength agrees with TAG_MAX_LEN', () => {
    const page = readFileSync(new URL('../pages/track/[id].astro', import.meta.url), 'utf8')
    expect(page).toContain(`maxlength="${TAG_MAX_LEN}"`)
  })
})
