// src/lib/debounce.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

export type Debounced<A extends unknown[]> = ((...args: A) => void) & { cancel: () => void }

/**
 * Trailing-edge debounce. `cancel` exists so an island can drop a pending
 * search on cleanup — a timer that fires after the component is gone sets
 * state nothing is reading and, worse, issues a request nothing will use.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void, ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: A) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, ms)
  }
  wrapped.cancel = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
  }
  return wrapped
}
