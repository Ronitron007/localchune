// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE MARKUP INVARIANT, CHECKED ACROSS THE WHOLE REPO: every
// `<form method="post">` carries `data-astro-reload`.
//
// WHY THIS IS A TEST AND NOT A CONVENTION. The rule has now been broken
// twice, in two different PRs, and both times it reached production:
//
//   PR #24  the like / crate / tag forms — "the production ♥→404".
//   today   the /review verdict form and the /merges undo form, added in a
//           parallel PR that never saw #24's fix.
//
// A rule that lives only in a commit message is a rule the next form will
// break, because the failure is invisible in review: the markup looks
// correct, and the page works until someone presses the button.
//
// THE MECHANISM, in the order it happens:
//
//  1. ClientRouter intercepts every same-origin submit and sends the body
//     itself.
//  2. It sends application/x-www-form-urlencoded ONLY when the <form> has an
//     explicit enctype attribute. No form in this repo has one, so it sends
//     a FormData object and fetch labels the request multipart/form-data.
//  3. Our API routes test `content-type.includes('application/x-www-form-
//     urlencoded')` to decide "form or JSON". Multipart fails that test, so
//     the route takes the JSON branch, request.json() throws, and the answer
//     is JSON — not the 303 the form expected.
//  4. ClientRouter's fetchHTML() returns null for any media type other than
//     text/html, and navigate() then falls back to `location.href =
//     to.href`.
//  5. That is a GET of the form's action. Our API routes export POST only,
//     so Astro renders the 404 page AT the API URL — and the write the
//     person asked for either never happened (/review) or happened and was
//     reported as a failure (/merges).
//
// data-astro-reload opts the form out of ClientRouter entirely: the browser
// submits it natively, the body genuinely is x-www-form-urlencoded, and the
// POST→303 round trip behaves the way the route was written for.
//
// Forms that would survive without it are still required to carry it. An
// invariant with exceptions cannot be checked by reading, which is the whole
// reason this file exists; the two exceptions say so in their own comments.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return astroFiles(full)
    return e.name.endsWith('.astro') ? [full] : []
  })
}

/**
 * Every opening <form ...> tag in the repo's MARKUP, with its file and line.
 *
 * The frontmatter fence is removed first, and it has to be: welcome.astro's
 * header comment contains the words `<form method="post">` as prose, and a
 * scan that counted it would demand data-astro-reload inside a JavaScript
 * comment. Frontmatter is JS, so no real tag can be lost this way. The fence
 * is replaced by its own newlines rather than deleted, so reported line
 * numbers still match the file.
 */
function formTags() {
  return astroFiles(SRC).flatMap((file) => {
    const raw = readFileSync(file, 'utf8')
    const source = raw.replace(/^---\n[\s\S]*?\n---/, (m) => '\n'.repeat(m.split('\n').length - 1))
    return [...source.matchAll(/<form\b[^>]*>/gs)].map((m) => ({
      file: file.slice(SRC.length),
      line: source.slice(0, m.index).split('\n').length,
      tag: m[0],
    }))
  })
}

describe('every POST form opts out of ClientRouter', () => {
  const posts = formTags().filter((f) => /method\s*=\s*"post"/i.test(f.tag))

  // A regex that matched nothing would make every assertion below pass
  // vacuously, which is the one way this file could rot into decoration.
  it('finds the POST forms at all', () => {
    expect(posts.length).toBeGreaterThanOrEqual(15)
  })

  it.each(posts.map((f) => [`${f.file}:${f.line}`, f.tag] as const))(
    '%s carries data-astro-reload',
    (_where, tag) => {
      expect(tag).toContain('data-astro-reload')
    },
  )

  // The bug needs BOTH halves: ClientRouter re-sending the body, and a route
  // that only understands one encoding. If a form ever does need to stay
  // inside ClientRouter, an explicit enctype is what would keep the encoding
  // honest — so its absence everywhere is why data-astro-reload is
  // mandatory rather than merely advisable.
  it('no POST form declares an enctype, which is what makes the rule absolute', () => {
    expect(posts.filter((f) => /enctype/i.test(f.tag))).toEqual([])
  })

  // M6b, stated POSITIVELY so it has to be argued with rather than merely
  // not noticed: the queue drawer adds no form at all. The queue is CLIENT
  // state — there is no server resource for a queue operation to POST to —
  // so every control in it is <button type="button">. A task that finds
  // itself wanting a form in the drawer has invented server state the queue
  // does not have; see src/layouts/shell-bundle.test.ts for the full
  // argument and the markup-level assertion.
  it('the queue drawer contributes no POST form to that list', () => {
    expect(posts.filter((f) => f.file.includes('Shell.astro'))).toEqual([])
  })
})
