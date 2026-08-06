// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// PERF TASK 2.1 — the sequential-RPC guard, and the outage guard that has
// to come with it.
//
// The audit's number one finding: every signed-in page render ran a 4–5
// deep chain of Supabase calls, each awaited before the next began, at a
// measured 60–165 ms per round trip. Because the UI is server-rendered
// under ClientRouter, every sort click, filter change, search keystroke and
// pagination click ran the whole chain again.
//
// TWO ASSERTIONS, AND THE SECOND IS THE IMPORTANT ONE.
//
// 1. STAGES. A page may await at most two Supabase network stages. One is
//    the norm; two is allowed because two pages genuinely need a result
//    before they can form the next request (member/[username] resolves a
//    username to a user_id before it can filter tracks by it; track/[id]
//    only reads ingest_jobs for a file it has already found to be failed
//    and its own).
//
// 2. ERRORS. Batching is where an outage quietly turns into an empty page.
//    `.rpc()` resolves to {data, error} rather than rejecting, so a
//    Promise.all of four calls succeeds with four failures in it, and a
//    page that destructures only `data` renders "you have nothing" during
//    an outage. Survive-list #16 is the rule that those two must never read
//    the same. So: every `error` a page destructures must be read again.
//    The stage assertion on its own would happily pass a page that swallowed
//    every failure it batched.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGES = new URL('../pages/', import.meta.url).pathname

function astroPages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return astroPages(full)
    return e.name.endsWith('.astro') ? [full] : []
  })
}

/** Frontmatter only — the markup below the fence contains no awaits. */
const frontmatter = (source: string): string => {
  const m = source.match(/^---\n([\s\S]*?)\n---/)
  return m === null ? '' : m[1]
}

/**
 * One "stage" is one `await` that blocks on the network. A `Promise.all`
 * of six calls is ONE stage; six separate awaits are six. Deliberately
 * over-counts a Promise.all that holds no Supabase call at all — there is
 * no such page, and a guard that errs toward failing is the right kind.
 */
const stages = (fm: string): number =>
  (fm.match(/await\s+(?:Promise\.(?:all|allSettled)\(|Astro\.locals\.supabase)/g) ?? []).length

const pages = astroPages(PAGES).map((f) => ({
  name: f.slice(PAGES.length),
  fm: frontmatter(readFileSync(f, 'utf8')),
}))

describe('every page render is at most two Supabase stages', () => {
  it('finds the pages at all — a silent empty scan would pass everything', () => {
    expect(pages.length).toBeGreaterThan(8)
    expect(pages.some((p) => p.name === 'pool.astro')).toBe(true)
  })

  for (const { name, fm } of pages) {
    it(`${name}`, () => {
      expect(stages(fm)).toBeLessThanOrEqual(2)
    })
  }
})

describe('an outage never renders as an empty page — survive-list #16', () => {
  /** Every identifier a page binds to a result's `error`, from either
   *  `{ data, error }` or `{ data: x, error: xError }`. */
  const errorBindings = (fm: string): string[] =>
    [...fm.matchAll(/(?<![.\w])error(?:\s*:\s*(\w+))?\s*(?=[,}])/g)].map((m) => m[1] ?? 'error')

  for (const { name, fm } of pages) {
    const bound = [...new Set(errorBindings(fm))]
    if (bound.length === 0) continue
    it(`${name} reads every error it binds`, () => {
      for (const id of bound) {
        // Twice: once where it is bound, once where it is branched on.
        // `console.error` cannot satisfy this — the lookbehind excludes a
        // preceding dot.
        const uses = fm.match(new RegExp(`(?<![.\\w])${id}\\b`, 'g'))?.length ?? 0
        expect(uses, `${name}: '${id}' is destructured and never read`).toBeGreaterThanOrEqual(2)
      }
    })
  }
})

describe('the chrome does not make its own round trip any more', () => {
  const COMPONENTS = new URL('../components/', import.meta.url).pathname
  const read = (f: string) => readFileSync(join(COMPONENTS, f), 'utf8')

  // Both of these render inside Shell, i.e. AFTER the page's frontmatter has
  // finished. An await here can only ever be last, which is exactly why the
  // call had to move to the middleware.
  for (const file of ['AppNav.astro', 'StorageChip.astro']) {
    it(`${file} calls no RPC of its own`, () => {
      expect(frontmatter(read(file))).not.toMatch(/Astro\.locals\.supabase/)
    })
    it(`${file} reads the middleware's promise`, () => {
      expect(frontmatter(read(file))).toMatch(/chromeData\(Astro\.locals\)/)
    })
  }

  it('the middleware starts it without awaiting it', () => {
    const mw = readFileSync(new URL('../middleware.ts', import.meta.url).pathname, 'utf8')
    expect(mw).toMatch(/locals\.chrome = startChromeData\(/)
    // Awaiting here would rebuild the chain this task removes: the two
    // calls would once again finish before the page's own began.
    expect(mw).not.toMatch(/await startChromeData/)
  })
})
