// src/components/crate-card.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE CARD THAT PUT A BUTTON ON ITS OWN TITLE.
//
// The owner photographed `+ QUEUE` sitting on the crate name on the home
// feed. The cause was that `.cratecard` had NO LAYOUT — `border` and
// `padding` and nothing else — so the title `<a>`, the 44px `.queueadd`
// button and the `.explain` line were inline content sharing one line box.
// The button was a word inside the title's sentence, and it landed
// wherever the title's last line ended.
//
// Nothing in the DOM could see that, and no unit test could either: the
// markup was correct and the attributes were all present. So this file
// pins the LAYOUT PROPERTIES that make the collision impossible, in the
// stylesheet, where the bug actually lived.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
const css = read('styles/global.css')

/** `.cratecard`'s own rule block, up to the closing brace. */
const cardBlock = (() => {
  const start = css.indexOf('.cratecard {')
  return css.slice(start, css.indexOf('}', start))
})()

describe('the crate card cannot put a control on its title', () => {
  it('is a grid, so the title and the button are not in one line box', () => {
    // THE FIX, stated as the property it guarantees. Inline content in a
    // shared line box is the entire defect; a grid gives each child a cell
    // it cannot leave, at every width.
    expect(cardBlock).toContain('display: grid')
    expect(cardBlock).toContain('grid-template-areas')
  })

  it('the text column is minmax(0, 1fr), so a long name wraps instead of pushing', () => {
    // Without the 0 minimum a grid column is at least min-content wide, and
    // a long crate name would push the control out of the card rather than
    // wrap inside it.
    expect(cardBlock).toContain('minmax(0, 1fr)')
  })

  it('every child is placed by area — none of them auto-flows', () => {
    // An unplaced child lands in the next free cell, which is how a card
    // grows a row nobody designed. Each of the five is named.
    for (const area of ['art', 'name', 'chip', 'meta', 'act']) {
      expect(css, `.cratecard has no child placed in "${area}"`)
        .toMatch(new RegExp(`\\.cratecard > [^{]+\\{[^}]*grid-area: ${area}`))
    }
  })

  it('no two children are placed in the SAME area', () => {
    // Two items in one grid cell STACK — which is this bug again, wearing
    // a grid. It nearly came back through the PRIVATE chip: `grid-area:
    // name; justify-self: end` looks like alignment and is actually two
    // boxes in one cell, invisible until a private crate has a long name.
    const areas = [...css.matchAll(/\.cratecard > [^{]+\{[^}]*grid-area: (\w+)/g)].map((m) => m[1])
    expect(areas.length).toBeGreaterThan(0)
    expect(new Set(areas).size, `duplicate grid-area in .cratecard: ${areas.join(', ')}`)
      .toBe(areas.length)
  })

  it('a name that cannot wrap breaks rather than overflowing the card', () => {
    // Reproduced in WebKit at 320/343/375px: a single-token crate name
    // (a normal way to name a crate) overflowed the card entirely and
    // dropped the button below it. `.memberhero h1` already carries this
    // for the same reason — it is a string a member chose.
    expect(css).toMatch(/\.cratecard > a \{[^}]*overflow-wrap: anywhere/)
  })

  it('the + QUEUE button honours its own `hidden` attribute', () => {
    // `.btn-secondary`'s `display: inline-flex` BEATS the UA sheet's
    // `[hidden] { display: none }`, because an author rule always does. So
    // the control painted before site.ts ever revealed it — the same trap
    // `.searchrow` and `.cratepick` already carry a fix for.
    expect(css).toContain('.cratecard > .queueadd[hidden] { display: none; }')
  })
})

describe('every crate card surface renders the same object', () => {
  const surfaces = [
    'pages/crates.astro',
    'pages/index.astro',
    'pages/member/[username].astro',
  ] as const

  it.each(surfaces)('%s renders <CrateStack>', (file) => {
    // A card that draws its own artwork is a second answer to "what does a
    // crate look like". One component, three pages.
    expect(read(file)).toContain('<CrateStack ')
  })

  it('no page builds the stack markup itself', () => {
    const astro = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name)
        if (e.isDirectory()) return astro(full)
        return e.name.endsWith('.astro') ? [full] : []
      })
    const offenders = astro(SRC)
      .filter((f) => f.slice(SRC.length) !== 'components/CrateStack.astro')
      .filter((f) => /class="cratestack/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })

  it('the RPC column is threaded through, not invented client-side', () => {
    // Migration 35 added art_file_ids to crate_list() and
    // feed_new_crates(). Reconstructing it from anything else — the track
    // count, a second fetch — would be a different answer on each page.
    expect(read('lib/org-api.ts')).toContain('art_file_ids')
    for (const file of surfaces) expect(read(file)).toContain('art_file_ids')
  })
})
