// src/lib/tag-wiring.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE DELEGATED TAG HANDLER, NO INLINE HANDLERS, AND THE PLAIN FORM STAYS.
//
// The tag editor became optimistic (owner, 2026-08-07: adding or removing
// a tag must not reload the page). That is the ♥'s established pattern, and
// this file pins the three things that make it that pattern rather than a
// second idiom:
//
//   1. ONE document-level `form.tagform` submit delegation. A per-form
//      listener would have to be re-bound on every ClientRouter swap and on
//      every chip this code creates — and the chips it creates are exactly
//      the ones nobody would remember to bind.
//   2. NO inline handlers. An `onclick=`/`onsubmit=` in this bundle trips
//      Cloudflare's API WAF and 403s the deploy (survive-list #6). It has
//      cost this project a deploy once.
//   3. The forms keep `method="post"`, a real `action` and
//      `data-astro-reload`. Without JS they are the whole feature.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './source-scan'

const site = readFileSync(new URL('../scripts/site.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../pages/track/[id].astro', import.meta.url), 'utf8')

describe('one delegated handler owns both intents', () => {
  it('exactly one `form.tagform` delegation exists', () => {
    expect(site.match(/closest\?\.\('form\.tagform'\)/g)?.length).toBe(1)
  })

  it('it is registered on the document, in the capture phase', () => {
    // Capture, like every other submit delegation in this file: a form
    // inside a portal or created after load is still reached, and nothing
    // downstream can stop propagation first.
    const at = site.indexOf("closest?.('form.tagform')")
    const before = site.slice(Math.max(0, at - 200), at)
    expect(before).toContain("document.addEventListener('submit'")
    const after = site.slice(at, at + 4000)
    expect(after).toContain('}, true)')
  })

  it('it branches on the same `intent` field the ROUTE branches on', () => {
    // parseTagForm reads `intent === 'remove'`. A client that decided by
    // some other signal — a class, a data attribute — would be a second
    // definition of what a remove is.
    const at = site.indexOf("closest?.('form.tagform')")
    const body = site.slice(at, at + 4000)
    expect(body).toContain("input[name=\"intent\"]")
    expect(body).toContain("input[name=\"tag_key\"]")
    expect(body).toContain("input[name=\"tag\"]")
  })

  it('it calls the ONE fetch wrapper, never fetch() itself', () => {
    const at = site.indexOf("closest?.('form.tagform')")
    const body = site.slice(at, at + 4000)
    expect(body).toContain('editTag(')
    expect(body).not.toContain('fetch(')
  })

  it('it rolls back on failure — both directions', () => {
    const at = site.indexOf("closest?.('form.tagform')")
    const body = site.slice(at, at + 4000)
    // Remove puts the node back at the same index; add takes its chip away.
    expect(body).toContain('list.insertBefore(li,')
    expect(body).toContain('li.remove()')
  })

  it('it decides with tag-edit.ts rather than inventing rules', () => {
    const at = site.indexOf("closest?.('form.tagform')")
    const body = site.slice(at, at + 4000)
    expect(body).toContain('planTagAdd(')
    // A literal 32 or 20 here would be a second copy of tag_add's limits.
    expect(body).not.toMatch(/\b(32|20)\b/)
  })
})

describe('no inline handlers anywhere in the bundle', () => {
  it('site.ts writes no on* attribute', () => {
    // survive-list #6. Matched as an ATTRIBUTE assignment rather than as
    // the substring "onclick", which appears in prose in this file.
    expect(site).not.toMatch(/setAttribute\(\s*['"]on[a-z]+['"]/)
    expect(site).not.toMatch(/\.onclick\s*=|\.onsubmit\s*=|\.onchange\s*=/)
  })

  it('the track page writes none either', () => {
    expect(page).not.toMatch(/\son(click|submit|change|input)=/)
  })
})

describe('the no-JS path is untouched', () => {
  it('both tag forms keep method, action and data-astro-reload', () => {
    const forms = [...page.matchAll(/<form class="tagform"[^>]*>/g)].map((m) => m[0])
    expect(forms.length).toBe(2)
    for (const form of forms) {
      expect(form).toContain('method="post"')
      expect(form).toContain('action={tagsAction}')
      expect(form).toContain('data-astro-reload')
    }
  })

  it('the chip this code BUILDS carries the same three', () => {
    // A chip added optimistically must be removable by the same
    // delegation — and, if the script were to fail between the two, by the
    // browser. Anything less makes a fresh chip a dead end until reload.
    const at = site.indexOf('function tagChipEl')
    const body = site.slice(at, site.indexOf('\n}\n', at))
    expect(body).toContain("form.method = 'post'")
    expect(body).toContain('form.action = action')
    expect(body).toContain("setAttribute('data-astro-reload'")
    expect(body).toContain("className = 'tagform'")
  })

  it('the built chip uses the icon SET, not a text glyph', () => {
    // The control-glyphs allowlist is EMPTY and stays empty. `×` is
    // U+00D7 and iOS is free to emoji-render it. Comments stripped, or
    // this assertion reads the sentence you are reading now.
    const at = site.indexOf('function tagChipEl')
    const body = withoutComments(site.slice(at, site.indexOf('\n}\n', at)))
    expect(body).toContain("iconEl('close'")
    expect(body).not.toContain('×')
  })
})

describe('the route answers both transports', () => {
  const route = readFileSync(new URL('../pages/api/track/[id]/tags.ts', import.meta.url), 'utf8')

  it('JSON on Accept, the 303 otherwise', () => {
    expect(route).toContain("request.headers.get('accept')")
    expect(route).toContain('application/json')
    expect(route).toContain('redirect(`/track/${id}`, 303)')
  })

  it('still parses ONE body shape — the urlencoded form', () => {
    // Ten routes in this app branch on the urlencoded content type
    // (CLAUDE.md). Giving the fetch path a JSON body would be a second
    // parse of the same three fields.
    expect(route).toContain('request.formData()')
    expect(route).not.toContain('request.json()')
  })
})
