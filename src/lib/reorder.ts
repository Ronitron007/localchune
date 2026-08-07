// src/lib/reorder.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * ONE MOVE, FOR EVERY REORDER IN THE APP.
 *
 * Three surfaces reorder a list: the queue drawer's layer 1 (drag, and the
 * arrow keys on the drag handle), the crate page's track order (drag), and
 * the crate's no-JS ↑/↓ POST route. Before this file the first did not exist
 * and the other two each carried their own swap. Two implementations of one
 * permutation is the shape of bug this codebase has already paid for twice,
 * and it is worse here than most: a reorder that disagrees with itself is
 * silent, has no exception and no log line, and shows up only as "the wrong
 * song plays".
 *
 * So there is one function, it is pure, it is dependency-free, and it is
 * tested exhaustively rather than by sample (reorder.test.ts runs every
 * from/to pair). `queue-engine.ts` calls it for the drawer and
 * `org-api.ts`'s `moveInList` delegates to it for the crate.
 *
 * A MOVE IS NOT A SWAP, and the difference is the whole reason this is not
 * three lines inline. Moving index 0 to index 3 of [a b c d e] gives
 * [b c d a e] — b, c and d each slide up one and stay adjacent. Swapping 0
 * and 3 gives [d b c a e], which puts a track nobody touched at the top of
 * the queue. For an ADJACENT move the two are identical, which is what lets
 * the one-step callers delegate here without changing behaviour by a byte.
 *
 * TOTAL, LIKE THE REDUCER IT SERVES. Every rejected input — a source outside
 * the list, a `NaN` from a missing `data-index`, a fractional index — returns
 * a NEW array equal to the input rather than throwing or mutating. The
 * destination is CLAMPED instead of rejected, because the caller that needs
 * it most is a drag: a drop past the last pin means "put it last", and the
 * engine relies on exactly that to fold a drop into the auto tail back onto
 * the intent boundary.
 */

/**
 * `list` with the item at `from` moved to `to`.
 *
 * @param from Must address an existing item, or the call is a no-op.
 * @param to   CLAMPED into `[0, list.length - 1]`. The result satisfies
 *             `out[clamped] === list[from]` — the item lands exactly where it
 *             was asked to, which is the property the drag depends on.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice()
  if (!Number.isInteger(from) || from < 0 || from >= next.length) return next
  if (!Number.isInteger(to)) return next

  const dest = Math.max(0, Math.min(to, next.length - 1))
  if (dest === from) return next

  const [moved] = next.splice(from, 1)
  next.splice(dest, 0, moved)
  return next
}
