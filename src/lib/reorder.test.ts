// src/lib/reorder.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// EXHAUSTIVE, NOT SAMPLED. Every assertion below that calls itself a
// property runs every (from, to) pair over a fixed list rather than a
// random sample, because the list is small enough that "for all" is
// affordable literally. A sampled property test that passes is evidence;
// an exhausted one is a proof, and this function decides what order the
// user's own queue is in.
import { describe, expect, it } from 'vitest'
import { moveItem } from './reorder'

const L = ['a', 'b', 'c', 'd', 'e']
/** Every index of L, plus the four ways to be outside it. */
const INSIDE = [0, 1, 2, 3, 4]
const OUTSIDE = [-1, -99, 5, 99]

describe('moveItem — the one move', () => {
  it('lands the item exactly at the destination, for every from and every to', () => {
    for (const from of INSIDE) {
      for (const to of INSIDE) {
        const out = moveItem(L, from, to)
        expect(out[to], `moving ${from} -> ${to}`).toBe(L[from])
      }
    }
  })

  it('is a permutation for every from and every to — nothing is lost or cloned', () => {
    for (const from of INSIDE) {
      for (const to of [...INSIDE, ...OUTSIDE]) {
        const out = moveItem(L, from, to)
        expect(out).toHaveLength(L.length)
        expect([...out].sort()).toEqual([...L].sort())
      }
    }
  })

  it('preserves the relative order of everything it did not move', () => {
    // The whole difference between a MOVE and a SWAP. A swap of 0 and 3 puts
    // 'd' where 'a' was; a move slides b, c up one and leaves them adjacent.
    for (const from of INSIDE) {
      for (const to of INSIDE) {
        const out = moveItem(L, from, to).filter((v) => v !== L[from])
        expect(out, `moving ${from} -> ${to}`).toEqual(L.filter((v) => v !== L[from]))
      }
    }
  })

  it('is the identity when from === to', () => {
    for (const i of INSIDE) expect(moveItem(L, i, i)).toEqual(L)
  })

  it('CLAMPS a destination past either end to that end', () => {
    // The engine leans on this: a drop into the auto tail is a `to` past the
    // last pin, and it must mean "last pin", not "no-op" and not a throw.
    expect(moveItem(L, 0, 99)).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(moveItem(L, 0, 4)).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(moveItem(L, 4, -99)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(moveItem(L, 4, 0)).toEqual(['e', 'a', 'b', 'c', 'd'])
  })

  it('clamping and the in-range edge agree exactly', () => {
    for (const from of INSIDE) {
      expect(moveItem(L, from, 99)).toEqual(moveItem(L, from, L.length - 1))
      expect(moveItem(L, from, -99)).toEqual(moveItem(L, from, 0))
    }
  })

  it('is a no-op for an out-of-range SOURCE, at either end', () => {
    for (const from of OUTSIDE) {
      for (const to of [...INSIDE, ...OUTSIDE]) {
        expect(moveItem(L, from, to), `from ${from}`).toEqual(L)
      }
    }
  })

  it('is a no-op for a non-integer index rather than a hole in the array', () => {
    // `Number(dataset.index)` yields NaN for a missing attribute, and
    // splice(NaN) silently treats it as 0 — a move nobody asked for.
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(moveItem(L, bad, 2)).toEqual(L)
      expect(moveItem(L, 2, bad)).toEqual(L)
    }
  })

  it('handles the empty and single-item lists without special-casing them', () => {
    expect(moveItem([], 0, 0)).toEqual([])
    expect(moveItem(['a'], 0, 0)).toEqual(['a'])
    expect(moveItem(['a'], 0, 9)).toEqual(['a'])
  })

  it('never mutates its input, and always returns a NEW array', () => {
    const input = ['a', 'b', 'c']
    Object.freeze(input)
    expect(moveItem(input, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(input).toEqual(['a', 'b', 'c'])
    // Even the no-op paths return a copy — same total-function discipline the
    // reducer has, so no caller can ever alias the array it was handed.
    expect(moveItem(input, 0, 0)).not.toBe(input)
    expect(moveItem(input, 9, 0)).not.toBe(input)
  })

  it('is deterministic — the same inputs give the same output every time', () => {
    for (const from of INSIDE) {
      for (const to of INSIDE) {
        expect(moveItem(L, from, to)).toEqual(moveItem(L, from, to))
      }
    }
  })

  it('composes: a move and its inverse restore the original', () => {
    for (const from of INSIDE) {
      for (const to of INSIDE) {
        expect(moveItem(moveItem(L, from, to), to, from)).toEqual(L)
      }
    }
  })
})

describe('moveItem is the one-step move too', () => {
  // org-api.ts's moveInList (the crate's ↑/↓ POST route) delegates here, so
  // the drag and the keyboard press cannot drift into two orderings. For an
  // ADJACENT move a swap and a splice are the same permutation — which is
  // exactly why the delegation is safe and why it is worth stating.
  it('agrees with a swap whenever the move is one step', () => {
    const swap = (list: string[], i: number, j: number): string[] => {
      const out = list.slice()
      const t = out[i]
      out[i] = out[j]
      out[j] = t
      return out
    }
    for (const i of [0, 1, 2, 3]) {
      expect(moveItem(L, i, i + 1)).toEqual(swap(L, i, i + 1))
      expect(moveItem(L, i + 1, i)).toEqual(swap(L, i + 1, i))
    }
  })

  it('disagrees with a swap the moment the move is longer than one step', () => {
    // Stated as a test so nobody "simplifies" moveItem back into a swap.
    expect(moveItem(L, 0, 3)).toEqual(['b', 'c', 'd', 'a', 'e'])
    expect(moveItem(L, 0, 3)).not.toEqual(['d', 'b', 'c', 'a', 'e'])
  })
})
