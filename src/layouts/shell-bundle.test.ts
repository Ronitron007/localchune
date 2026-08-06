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
