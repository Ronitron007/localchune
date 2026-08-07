// src/layouts/shell-bundle.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE DRAWER MUST NOT PULL THE ENGINE INTO EVERY PAGE.
//
// UX.12 paid for this lesson once already: Shell.astro mounts on EVERY page,
// and whatever it imports is shipped in every page's client bundle — /login
// included. That is why upload-store.ts is split from upload-engine.ts, and
// why queue-store.ts imports queue-model and nothing else (its own guard test
// enforces that half).
//
// This is the other half, and it is the half a source guard on queue-store.ts
// CANNOT see: nothing stops a future contributor from importing queue-engine
// straight into Shell.astro, or turning the drawer into an island component
// that does. Either would ship the Camelot scorer, the four strategies and the
// candidate client to a page with no audio on it, and neither would fail a
// single existing test.
//
// The defence is the design: Shell.astro renders INERT MARKUP and site.ts
// fills it. site.ts is a single `<script src>` the layout already loads, so
// the engine lives in exactly one graph. This file asserts the layout keeps
// its hands empty.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname
const SHELL = join(SRC, 'layouts/Shell.astro')
const shell = readFileSync(SHELL, 'utf8')

/** Frontmatter only — the `---` fence is the only place an .astro file can
 *  import anything, and the body below it is prose and markup that legitimately
 *  mentions these module names. */
const frontmatter = (source: string): string => {
  const m = source.match(/^---\n([\s\S]*?)\n---/)
  return m === null ? '' : m[1]
}

const QUEUE_MODULES = [
  'queue-engine', 'queue-strategies', 'queue-candidates', 'queue-store', 'queue-view',
  'queue-model',
]

describe('Shell.astro keeps the queue engine out of every page', () => {
  it.each(QUEUE_MODULES)('does not import %s', (mod) => {
    expect(frontmatter(shell)).not.toContain(mod)
  })

  it('imports no client-side island for the queue at all', () => {
    // A `client:` directive on a queue component would defeat the whole split
    // even without a direct import in this file.
    const islandDirectives = [...shell.matchAll(/<(\w+)[^>]*client:(load|idle|visible|only)/g)]
      .map((m) => m[1])
    expect(islandDirectives).toEqual(['UploadChip'])
  })

  it('still renders the drawer shell, so the assertions above are not vacuous', () => {
    expect(shell).toContain('id="queue-drawer"')
    expect(shell).toContain('id="queue-sections"')
    expect(shell).toContain('id="queue-toggle"')
  })

  it('renders the bar in reading order: name, ♥, crate, then the transport', () => {
    // The queue shipped with no on-page skip control at all — the only way to
    // reach the next track was the lock screen, which does not exist on a
    // desktop.
    //
    // ORDER IS STILL ASSERTED, but the reason changed. It used to be that
    // global.css's mobile `order` rules were written against this DOM
    // order; the bar is a grid now, and grid areas do not care. What the
    // array protects today is the READING order for a screen reader and
    // for a no-CSS render: name, then the artist under it, then the ♥ that
    // is about that name, then the transport. That is also the order the
    // owner-confirmed mock draws.
    //
    // `player-artist` is inside #player-label with the link, because both
    // lines are the region's content and the region is the app's ONE
    // aria-live element (survive-list #12). A second live region for the
    // artist would race this one.
    //
    // OWNER, 2026-08-07: `player-crate` joins the ♥, and it joins it HERE
    // — immediately after it, before the transport — because that is the
    // grouping the owner asked for ("right alongside the like button") and
    // because the DOM order is what a screen reader and a no-CSS render
    // get. The grid draws row 1 as name · ♥ · crate and row 2 as the
    // transport with QUEUE at its head; neither this array nor site.ts
    // knows that.
    const ids = [...shell.matchAll(/id="(player-[a-z]+)"/g)].map((m) => m[1])
    expect(ids).toEqual([
      'player-label', 'player-link', 'player-artist', 'player-like', 'player-crate',
      'player-toggle', 'player-next', 'player-seek', 'player-time', 'player-audio',
    ])
  })

  it('the crate control is inert without JS and names the sheet it opens', () => {
    // Same three properties RowMenu.astro's ⋮ carries, and for the same
    // three reasons: a sheet is client state with no server fallback, an
    // <svg> is aria-hidden so the NAME has to be on the button, and
    // "dialog" rather than "menu" is what a sheet actually is.
    const btn = shell.slice(shell.indexOf('id="player-crate"'), shell.indexOf('id="queue-toggle"'))
    expect(btn).toContain('hidden')
    expect(btn).toContain('aria-haspopup="dialog"')
    expect(btn).toContain('aria-label')
    // No `action`, no form, nothing to POST: it opens a picker.
    expect(btn).not.toContain('<form')
  })

  it('keeps both name lines inside the one aria-live region', () => {
    // survive-list #12. Not "near" it — INSIDE it, so one synchronous
    // write of both lines announces once.
    // Sliced to the FIRST `</span>` after the region opens, which closes
    // the region itself: both children are anchors now, so there is no
    // nested <span> in between. It used to search for `</span></span>`,
    // which stopped matching the moment the artist line became a link to
    // the act's page — a false red about markup that was still correct.
    const region = shell.slice(shell.indexOf('id="player-label"'))
    const closed = region.slice(0, region.indexOf('</span>') + 7)
    expect(closed).toContain('id="player-link"')
    expect(closed).toContain('id="player-artist"')
    expect(closed).toContain('aria-live="polite"')
  })

  it('ships the skip button hidden, like every other JS-only control', () => {
    const btn = shell.slice(shell.indexOf('id="player-next"'))
    expect(btn.slice(0, btn.indexOf('>'))).toContain('hidden')
  })

  it('ships the title link hidden and with NO href', () => {
    // An empty href resolves to the current page, which is a dead link on
    // every page but one. site.ts sets the href and unhides it together, on
    // every change of current — see setNowPlaying.
    const a = shell.slice(shell.indexOf('id="player-link"'))
    const tag = a.slice(0, a.indexOf('>'))
    expect(tag).toContain('hidden')
    expect(tag).not.toContain('href')
  })

  it('keeps the skip button inside the persisted player node', () => {
    // Outside it, a ClientRouter navigation would recreate the button and drop
    // the listener site.ts bound once, at module load.
    const persisted = shell.slice(shell.indexOf('transition:persist="player"'))
    expect(persisted).toContain('id="player-next"')
  })

  it('renders the grab handle, first child of the drawer', () => {
    // OWNER, 2026-08-07: "make it like the drawer component of add to
    // crate". The bar is the affordance for the swipe-down, so it has to
    // be the thing at the top of the panel — a handle under the method
    // row is a decoration.
    const from = shell.indexOf('id="queue-drawer"')
    const grab = shell.indexOf('id="queue-grab"', from)
    const head = shell.indexOf('class="queuedrawer-head"', from)
    expect(grab, 'the drawer has a grab handle').toBeGreaterThan(-1)
    expect(grab).toBeLessThan(head)
  })

  it('the handle is a real button wearing the shared class', () => {
    // `grabhandle`, not a second 36x4 recipe: global.css declares the bar
    // once and site.ts puts the same class on the sheet's handle.
    // drag-dismiss-single-source.test.ts owns that half.
    const at = shell.indexOf('id="queue-grab"')
    const tag = shell.slice(shell.lastIndexOf('<button', at), shell.indexOf('>', at))
    expect(tag).toContain('type="button"')
    expect(tag).toContain('class="grabhandle"')
    // The bar draws no glyph, so the accessible name is the only name it
    // has — the same rule RowMenu.astro's ⋮ follows.
    expect(tag).toContain('aria-label')
  })

  it('the handle does NOT ship hidden, and that exception is structural', () => {
    // Every other JS-only control in this file ships `hidden` because it
    // would be visible and inert without JS. This one cannot be: its
    // parent is the drawer, the drawer ships `hidden`, and only site.ts
    // can unhide it. A `hidden` here would need a fourth unhide call for
    // no gain.
    const at = shell.indexOf('id="queue-grab"')
    const tag = shell.slice(shell.lastIndexOf('<button', at), shell.indexOf('>', at))
    expect(tag).not.toContain('hidden')
    const drawer = shell.slice(shell.indexOf('id="queue-drawer"'))
    expect(drawer.slice(0, drawer.indexOf('>'))).toContain('hidden')
  })

  it('keeps the drawer inside the persisted player node', () => {
    // Outside it, a ClientRouter navigation recreates the drawer and it closes
    // itself on every filter submit and every sort click.
    const persisted = shell.slice(shell.indexOf('transition:persist="player"'))
    const drawerAt = persisted.indexOf('id="queue-drawer"')
    const closeAt = persisted.indexOf('</div>', persisted.indexOf('<audio'))
    expect(drawerAt).toBeGreaterThan(-1)
    expect(drawerAt).toBeLessThan(closeAt)
  })
})

describe('the drawer adds no POST form — §4, stated positively', () => {
  // astro-forms.test.ts proves every POST form carries data-astro-reload.
  // This is the complementary statement: the queue introduces no form to
  // carry it. The queue is client state; there is no server resource for a
  // queue operation to POST to, and a task that finds itself wanting a form
  // here has invented server state the queue does not have.
  //
  // THE ♥ IS NOT A COUNTEREXAMPLE, it is the contrast that makes the rule
  // readable. A like has a server resource — /api/track/[id]/like, backed by
  // migration 26's toggle_like — so it IS a form, and it carries
  // data-astro-reload like every other POST form in the repo. A queue
  // operation still has nothing to POST to. The assertion is scoped to the
  // drawer rather than to the file, which is what it always meant.
  it('has no <form> anywhere in the drawer markup', () => {
    const from = shell.indexOf('id="queue-drawer"')
    const to = shell.indexOf('</div>', shell.indexOf('id="queue-sections"'))
    expect(shell.slice(from, to)).not.toContain('<form')
  })

  it('builds every queue control as a real button, never a bare link', () => {
    const controls = [...shell.matchAll(/id="queue-(toggle|clear)"[\s\S]{0,80}/g)]
    expect(controls.length).toBe(2)
    for (const [chunk] of controls) expect(chunk).not.toContain('<a ')
  })
})

describe('the like button reuses the row contract rather than inventing one', () => {
  // ZERO NEW LIKE LOGIC IS THE WHOLE DESIGN. site.ts has exactly one
  // document-level `form.likeform` submit delegation, written for
  // TrackRow.astro's pool cell and track/[id].astro's .signals block. It
  // serves the bar too — but only because this markup matches it EXACTLY.
  // Every selector that handler queries is asserted here; drop any one of
  // them and the bar's heart silently stops toggling, with no other test in
  // the repo noticing, because site.ts cannot be imported under node.
  // Ends at the form's OWN close tag, not at whatever id comes next. It
  // used to slice to `id="queue-toggle"`, which silently included every
  // comment in between — and the moment the crate control landed there
  // with a comment that mentions the ♥, the "starts hollow" assertion
  // below was reading prose instead of markup. A slice that ends at the
  // element cannot be widened by a comment.
  const form = shell.slice(
    shell.indexOf('id="player-like"'),
    shell.indexOf('</form>', shell.indexOf('id="player-like"')),
  )

  it('is a real POST form carrying data-astro-reload', () => {
    expect(form).toContain('method="post"')
    expect(form).toContain('data-astro-reload')
  })

  it('ships with NO action, so the inert form cannot POST to the current page', () => {
    // site.ts writes the action with the file id when a track starts. An
    // absent action submits to the current URL — which is why the button is
    // ALSO disabled below, rather than relying on `hidden` alone.
    expect(form).not.toContain('action=')
  })

  it('ships hidden AND disabled — the one control here that can write', () => {
    expect(form).toContain('hidden')
    expect(form).toContain('disabled')
  })

  it.each(['likeform', 'likebtn', 'likeglyph', 'likecount', 'data-file-id', 'aria-pressed'])(
    'carries `%s`, which the delegation in site.ts queries by name',
    (hook) => { expect(form).toContain(hook) },
  )

  it('starts hollow at zero, the state of a bar with nothing playing', () => {
    // It used to assert the two characters ♡ and ♥. Both are gone: iOS
    // gives U+2665 emoji presentation on its own, so the bar painted a red
    // heart in a monochrome interface. The state is the SAME path, stroked
    // or filled — so "hollow" is the ABSENCE of `filled`, and this file
    // reads Shell.astro's source rather than a render, so that is what it
    // can honestly check.
    expect(form).toContain('likeglyph')
    expect(form).toContain('<Icon name={LIKE_ICON.name}')
    expect(form).not.toContain('filled')
    expect(form).not.toContain('♡')
    expect(form).not.toContain('♥')
  })
})

describe('site.ts is the one client graph the engine lives in', () => {
  const astroFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return astroFiles(full)
      return e.name.endsWith('.astro') || e.name.endsWith('.tsx') ? [full] : []
    })

  it('no .astro page or island imports a queue module', () => {
    const offenders = astroFiles(SRC)
      .filter((f) => QUEUE_MODULES.some((m) => frontmatter(readFileSync(f, 'utf8')).includes(m)))
      .map((f) => f.slice(SRC.length))
    expect(offenders).toEqual([])
  })
})

// -------------------------------------------------------------- perf 2.3
//
// /login is the one page a signed-out visitor sees, the one page nobody has
// a warm cache for, and — until perf task 2.3 — the heaviest page in the
// build: 222 KB of parse / 57.8 KB gzip, the whole of supabase-js, to wire
// one button. The regression is a single `import` away and would produce no
// build error, no failing test and no visible change on a laptop. It gets
// the same treatment the drawer gets above.
describe('/login ships zero JavaScript — perf task 2.3', () => {
  const login = readFileSync(join(SRC, 'pages/login.astro'), 'utf8')

  it('has no <script> at all', () => {
    expect(login).not.toMatch(/<script[\s>]/)
  })

  it('imports nothing from lib/supabase — the 222 KB was that one import', () => {
    expect(frontmatter(login)).not.toMatch(/from '[^']*lib\/supabase/)
  })

  it('signs in through a link, so the page works with JS disabled', () => {
    expect(login).toMatch(/href="\/auth\/start"/)
  })

  it('still renders without a Shell — there is no session here (survive-list #11)', () => {
    expect(frontmatter(login)).not.toMatch(/from '[^']*layouts\/Shell/)
  })
})

describe('/auth/start is reachable signed out — perf task 2.3', () => {
  const middleware = readFileSync(join(SRC, 'middleware.ts'), 'utf8')

  // The plan proposed CLAIM_FLOW_PATHS, which would not have worked: the
  // only caller of /auth/start has no member at all, so the gate it meets
  // is the signed-out redirect, not the username-claim gate. PUBLIC_PATHS
  // clears both — the claim check excludes PUBLIC_PATHS explicitly.
  it('is in PUBLIC_PATHS, or the sign-in button redirects to /login forever', () => {
    const set = /const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\)/.exec(middleware)?.[1] ?? ''
    expect(set).toContain("'/auth/start'")
  })
})
