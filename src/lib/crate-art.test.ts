// src/lib/crate-art.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { crateStackIds, SLEEVE_PX, SLEEVE_STEP_PX, STACK_MAX } from './crate-art'
import { withoutComments } from './source-scan'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`)

describe('crateStackIds', () => {
  it('keeps the order it was given — the front sleeve is the crate\'s first track', () => {
    expect(crateStackIds(['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('caps the stack at STACK_MAX', () => {
    expect(crateStackIds(ids(9))).toHaveLength(STACK_MAX)
    expect(crateStackIds(ids(9))).toEqual(ids(STACK_MAX))
  })

  it('an absent, null or non-array input is an empty stack, not a crash', () => {
    // The value arrives over the wire from an RPC. A crate row from before
    // migration 35, a failed call, or a cached older response must degrade
    // to the card's empty tile.
    expect(crateStackIds(null)).toEqual([])
    expect(crateStackIds(undefined)).toEqual([])
    expect(crateStackIds([])).toEqual([])
    expect(crateStackIds('nope' as unknown as string[])).toEqual([])
  })

  it('drops blanks and non-strings rather than rendering a broken sleeve', () => {
    expect(crateStackIds(['a', '', '   ', 'b'])).toEqual(['a', 'b'])
    expect(crateStackIds(['a', null as unknown as string, 'b'])).toEqual(['a', 'b'])
  })

  it('collapses duplicates — a merge can leave two files of one recording', () => {
    // Two identical sleeves stacked 5px apart reads as a rendering fault,
    // not as two records.
    expect(crateStackIds(['a', 'a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('counts the cap AFTER deduping, so a duplicate never costs a sleeve', () => {
    expect(crateStackIds(['a', 'a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('trims, because an id is used to build a URL', () => {
    expect(crateStackIds([' a ', 'b'])).toEqual(['a', 'b'])
  })
})

describe('the numbers are shared with the places that draw them', () => {
  const css = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8')
  const block = css.slice(css.indexOf('.cratestack {'))
  // COMMENTS STRIPPED FIRST: the "no perspective" assertion below failed
  // on the comment that says the stack has no perspective transform. A
  // rule about declarations should be reading declarations.
  const stackCss = withoutComments(block.slice(0, block.indexOf('/* The empty crate')))

  it('the CSS sleeve is SLEEVE_PX square', () => {
    expect(stackCss).toContain(`width: ${SLEEVE_PX}px`)
    expect(stackCss).toContain(`height: ${SLEEVE_PX}px`)
  })

  it('the container reserves the front sleeve plus every step behind it', () => {
    // A container sized to the front sleeve alone would clip the stack, and
    // `overflow: visible` would let it collide with the card's own border.
    const expected = SLEEVE_PX + (STACK_MAX - 1) * SLEEVE_STEP_PX
    expect(stackCss).toContain(`height: ${expected}px`)
  })

  it('the step is SLEEVE_STEP_PX on both axes, and the second one is negative', () => {
    // Up and to the right: records leaning back in a crate.
    expect(stackCss).toContain(`calc(var(--i, 0) * ${SLEEVE_STEP_PX}px)`)
    expect(stackCss).toContain(`calc(var(--i, 0) * -${SLEEVE_STEP_PX}px)`)
  })

  it('the sleeves get NO shadow — §4.3 rations one per view', () => {
    // Twelve crate cards times four sleeves is forty-eight shadows on one
    // screen, which is the collapse the ration exists to prevent. Depth
    // here is occlusion: an opaque fill and a 1px edge.
    expect(stackCss).not.toContain('box-shadow')
    expect(stackCss).toContain('background: var(--bg)')
    expect(stackCss).toContain('border: 1px solid var(--line)')
  })

  it('and NO rotation — the owner asked for a straight-on view', () => {
    expect(stackCss).not.toContain('rotate')
    expect(stackCss).not.toContain('perspective')
    expect(stackCss).not.toContain('border-radius')
  })
})
