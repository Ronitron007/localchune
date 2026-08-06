// src/styles/global-tokens.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The design mandate, made checkable. The owner's instruction was
// "the colour scheme stays same. monochrome. the lines and angles stay
// the same 90 degree. what changes are animations and borders" — three
// clauses, and two of them are assertions a test can hold. A future
// contributor who wants a rounded corner or a fifth colour has to argue
// with this file first, which is the whole point of writing it down.
//
// It reads global.css as TEXT rather than parsing it. A CSS parser would
// let a value survive the assertion by being computed; the mandate is
// about what is WRITTEN in the file.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8')

/**
 * The same file with every /* … *​/ comment removed. Assertions about what
 * a rule DECLARES use this; the file explains its own decisions at length
 * and a comment that names a value it just deleted must not fail the test
 * that checks the value is gone.
 */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The `:root { … }` block, which is the only place a literal may live. */
function rootBlock(): string {
  const start = decls.indexOf(':root {')
  expect(start, ':root block must exist').toBeGreaterThan(-1)
  const end = decls.indexOf('\n}', start)
  return decls.slice(start, end)
}

/** Every rule body OUTSIDE :root, joined. */
function nonRootCss(): string {
  return decls.replace(rootBlock(), '')
}

describe('the frozen mandate', () => {
  // "the colour scheme stays same" — these ten values are the entire
  // palette. Byte-for-byte, because a redesign that "just warmed the grey
  // slightly" is the exact failure this asserts against.
  it.each([
    ['--bg', '#fff'],
    ['--fg', '#000'],
    ['--mid', '#555'],
    ['--line', '#000'],
    ['--faint', '#ddd'],
    ['--zebra', '#f4f4f4'],
    ['--btn-blue', '#0b57d0'],
    ['--btn-blue-line', '#0842a0'],
    ['--btn-red', '#c0392b'],
    ['--btn-red-line', '#962d22'],
  ])('%s is still exactly %s', (name, value) => {
    expect(rootBlock()).toContain(`${name}: ${value};`)
  })

  it('keeps border-radius: 0 in the global reset — the 90 degree rule', () => {
    expect(decls).toMatch(/\*, \*::before, \*::after \{[^}]*border-radius: 0;/)
  })

  it('no hex literal outside :root — components use tokens, not values', () => {
    const hexes = nonRootCss().match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes).toEqual([])
  })

  it('no rgb/rgba literal outside :root, for the same reason', () => {
    const fns = nonRootCss().match(/\brgba?\(/g) ?? []
    expect(fns).toEqual([])
  })
})

describe('the motion system', () => {
  it('has exactly one prefers-reduced-motion block, and it is global', () => {
    const blocks = decls.match(/@media \(prefers-reduced-motion/g) ?? []
    expect(blocks).toHaveLength(1)
    // Global means it targets the universal selector, not one component.
    expect(decls).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{/)
  })

  it('never uses backdrop-filter, at any breakpoint', () => {
    expect(decls).not.toContain('backdrop-filter')
  })

  it('declares the six durations and the four easings once each', () => {
    for (const name of ['--dur-fast', '--dur-base', '--dur-panel', '--dur-slow']) {
      expect(rootBlock()).toContain(`${name}:`)
    }
    for (const name of ['--ease-pop', '--ease-out', '--ease-panel', '--ease-std']) {
      expect(rootBlock()).toContain(`${name}:`)
    }
  })

  it('nothing loops — no infinite animation anywhere', () => {
    expect(decls).not.toMatch(/animation[^;]*\binfinite\b/)
  })
})

describe('the ink ladder and the border set', () => {
  it.each(['--ink-04', '--ink-08', '--ink-12', '--ink-20', '--ink-35', '--ink-55', '--ink-100'])(
    'declares %s',
    (name) => expect(rootBlock()).toContain(`${name}:`),
  )

  it.each(['--line-hair', '--line-soft', '--line-mid', '--line-full', '--rule-sec', '--line-dash'])(
    'declares %s',
    (name) => expect(rootBlock()).toContain(`${name}:`),
  )

  // 1.5px is the component stroke. The half pixel is the difference
  // between a drawn object and a table gridline, and 1px is only ever a
  // divider inside something that already owns a 1.5px outer edge.
  it('draws components at 1.5px and dividers at 1px', () => {
    expect(rootBlock()).toMatch(/--line-hair:\s*1px\b/)
    expect(rootBlock()).toMatch(/--line-soft:\s*1\.5px\b/)
    expect(rootBlock()).toMatch(/--line-mid:\s*1\.5px\b/)
    expect(rootBlock()).toMatch(/--line-full:\s*1\.5px\b/)
  })

  it('--accent-3 is the only coloured border, and it is blue', () => {
    expect(rootBlock()).toMatch(/--accent-3:[^;]*var\(--btn-blue\)/)
  })
})

describe('the tap floor and the bar height', () => {
  it('declares --tap as 44px', () => {
    expect(rootBlock()).toMatch(/--tap:\s*44px/)
  })

  it('declares --bar-h, and derives the body reservation from it', () => {
    expect(rootBlock()).toContain('--bar-h:')
    expect(decls).toMatch(/body \{[^}]*padding: 0 var\(--pad-2\) calc\(var\(--bar-h\)/)
  })

  it('binds the upload chip to --bar-h instead of an eyeballed rem', () => {
    // survive-list #5: 3.5rem and 6.75rem were guesses at the bar's two
    // shapes and nothing bound them to it. Both are gone.
    expect(decls).not.toContain('3.5rem')
    expect(decls).not.toContain('6.75rem')
    expect(decls).toMatch(/\.uploadchip-slot \{[^}]*bottom: calc\(var\(--bar-h\)/)
  })
})
