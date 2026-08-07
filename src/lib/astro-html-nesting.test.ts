// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE MARKUP INVARIANT, CHECKED ACROSS THE WHOLE REPO: no `<p>` in this
// codebase contains an element that the HTML parser uses to close it.
//
// WHY THIS IS A TEST AND NOT A CONVENTION. It has now cost the owner two
// reports of the SAME defect.
//
//   PR #41  "♥ 1 0 plays reads as 10 plays" — fixed with a generated `·`
//           separator in global.css's COUNT RUNS block. Shipped, tested,
//           believed done.
//   after   the owner, reading the same track page: "the plays downloads
//           still doesnt have what i was talking about".
//
// The separator rule was `.signals > * + *::before`. The markup was
// `<p class="signals"><form class="likeform">…</form><span…><span…></p>`.
// `form` is on the HTML5 list of elements whose START TAG implies `</p>`,
// so the browser closed the paragraph before the form and the real DOM was:
//
//   <p class="signals"></p>          <- empty. Nothing to be a child of.
//   <form class="likeform">…</form>  <- a SIBLING
//   <span class="signal">17 plays</span>
//   <span class="signal">0 downloads</span>
//
// `> * + *` matched nothing, so no dot — and the flex `gap` was lost too,
// which is why the numbers touched: "♥ 317 plays0 downloads". The `.stats`
// run on the same page holds only spans, was never auto-closed, and DID
// render its dot. One page, two count runs, one separator, and the
// difference was an element type nobody could see.
//
// WHAT MAKES THIS CLASS OF BUG SPECIAL, and why the fix needs a parser
// rather than a string match: THE SERVER HTML AND THE BROWSER DOM DISAGREE.
// Every assertion in this repo that reads rendered markup as text — and
// they are the right tool for everything else — would have passed on the
// broken page, because `<p class="signals"><form` is exactly what the
// server sent. Only something that models implied end tags can see it.
// A component test cannot be the acceptance for a defect the owner reports
// by looking at a screen; the browser is.
//
// THE RULE, stated so it needs no judgement: if a `<p>` in a template
// contains any of the tags below before its own `</p>`, that `<p>` does not
// exist at runtime. Use a `<div>`. A paragraph of prose is what `<p>` is
// for; a flex container holding a form is not a paragraph.
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
 * The HTML5 "a start tag whose tag name is one of these ... close the p
 * element" list, verbatim from the tree-construction rules for "in body".
 * `p` is in it twice over: nested paragraphs close the outer one too.
 */
const CLOSES_P = [
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog',
  'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'listing',
  'main', 'menu', 'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section',
  'summary', 'table', 'ul', 'xmp',
] as const

/**
 * Comments are stripped before the scan, and this file is the reason why:
 * the fix for the defect above is DOCUMENTED in track/[id].astro with the
 * broken markup quoted inside a `{/* … *\/}` block. A scanner that read
 * comments would fail on the explanation of the bug it exists to prevent.
 * HTML comments go too — same argument, and `<!-- <p><div> -->` is legal.
 */
function markup(source: string): string {
  const end = source.indexOf('---', 3)
  const body = source.startsWith('---') && end > 0 ? source.slice(end + 3) : source
  return body
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

interface Offence {
  file: string
  line: number
  culprit: string
}

/**
 * Every `<p>` whose content reaches an implied closer before `</p>`.
 *
 * Deliberately a forward scan rather than a full parse: the question is not
 * "what tree does this produce" but "does this paragraph survive", and the
 * first implied closer answers it. `<p` must be followed by `>`, whitespace
 * or `/` so that `<pre>` and `<path>` are not read as paragraphs.
 */
function offences(file: string, source: string): Offence[] {
  const html = markup(source)
  const found: Offence[] = []
  const open = /<p(?=[\s/>])/g
  let m: RegExpExecArray | null
  while ((m = open.exec(html)) !== null) {
    const rest = html.slice(m.index + 2)
    const close = rest.search(/<\/p\s*>/)
    const tag = new RegExp(`<(${CLOSES_P.join('|')})(?=[\\s/>])`, 'i').exec(rest)
    if (tag === null) continue
    if (close !== -1 && close < tag.index) continue
    found.push({
      file: file.slice(SRC.length),
      line: html.slice(0, m.index).split('\n').length,
      culprit: tag[1].toLowerCase(),
    })
  }
  return found
}

describe('no <p> in this repo is closed out from under itself', () => {
  const files = astroFiles(SRC)

  it('finds templates to scan at all', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('every <p> reaches its own </p> first', () => {
    const all = files.flatMap((f) => offences(f, readFileSync(f, 'utf8')))
    const report = all.map((o) => `${o.file}:${o.line} — <p> holds <${o.culprit}>`)
    expect(report, 'these paragraphs do not exist in the DOM; use a <div>').toEqual([])
  })
})

describe('the scanner itself', () => {
  // A guard test that cannot fail is worse than no guard test: it reads as
  // coverage. These four cases are the exact shapes the repo contains.
  it('catches the shipped defect', () => {
    const bad = '---\n---\n<p class="signals"><form method="post"></form></p>'
    expect(offences('/x/a.astro', bad)).toHaveLength(1)
    expect(offences('/x/a.astro', bad)[0].culprit).toBe('form')
  })

  it('passes the fixed markup', () => {
    const good = '---\n---\n<div class="signals"><form method="post"></form></div>'
    expect(offences('/x/a.astro', good)).toEqual([])
  })

  it('does not mistake <pre> for a paragraph', () => {
    expect(offences('/x/a.astro', '---\n---\n<pre><div></div></pre>')).toEqual([])
  })

  it('ignores a <p> quoted inside an Astro comment', () => {
    const doc = '---\n---\n{/* was <p class="signals"><form> */}\n<div></div>'
    expect(offences('/x/a.astro', doc)).toEqual([])
  })

  it('allows a paragraph that closes before the next block', () => {
    expect(offences('/x/a.astro', '---\n---\n<p>prose</p><div></div>')).toEqual([])
  })
})
