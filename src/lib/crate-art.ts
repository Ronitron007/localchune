// src/lib/crate-art.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The crate card's stacked artwork, decided once — the numbers and the
// normalisation, with no DOM. CrateStack.astro renders it and
// global.css draws it; both read these names rather than typing a
// constant, because the card appears on THREE surfaces (/crates' two
// sections, the home feed's "New public crates", and /member/[username])
// and a stack that is four sleeves deep on one and three on another is
// the same object drawn two ways.

/**
 * How many sleeves a stack can hold: the front one plus three behind it.
 *
 * The owner asked for "the first tracks album art followed by other 2-3
 * tracks album art stacked behind it" — four is the top of the range they
 * named. Migration 35's `art_file_ids` returns at most four for the same
 * reason, so this and the SQL `limit 4` are one decision; changing it
 * means changing both, and `crate-art.test.ts` says so.
 */
export const STACK_MAX = 4

/**
 * The front sleeve's CSS box, square. It is the `width`/`height`
 * ATTRIBUTE on every `<img>` as well as the CSS size — an image with no
 * intrinsic size attributes reserves no space, and a list of crate cards
 * whose artwork pops in is a list that reflows under a thumb (CLS).
 */
export const SLEEVE_PX = 56

/**
 * The step between one sleeve and the one behind it, in px, on both axes.
 * Each sleeve behind the front is inset by this much and pushed up by it,
 * so the stack grows up and to the right exactly as a row of records
 * leaning back in a crate does.
 *
 * 5, not 8: at 8 a four-deep stack is 24px taller than its front sleeve,
 * which is nearly half the tile again and turns the card's first line into
 * a stack of paper. 5 reads as depth and costs 15px.
 */
export const SLEEVE_STEP_PX = 5

/**
 * The ids a stack should draw, front first.
 *
 * Total and defensive, because the input comes over the wire: a null or
 * absent array (an older RPC, a failed call, a crate row from before
 * migration 35) is an EMPTY stack rather than a crash, and the card falls
 * back to its empty tile. Blank entries are dropped and duplicates are
 * collapsed — a crate may legitimately hold two files of the same
 * recording after a merge, and two identical sleeves stacked 5px apart
 * reads as a rendering fault rather than as two records.
 */
export function crateStackIds(ids: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    kept.push(trimmed)
    if (kept.length === STACK_MAX) break
  }
  return kept
}
