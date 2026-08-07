// src/components/upload-remove-ui.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE ✕ ON A QUEUE ROW, RENDERED.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, because /track/[id] learned the hard
// way what happens when a component test is allowed to stand in for a look:
//
//   It CAN pin the markup — which rows grow a ✕ and which do not, that the
//   glyph is the Phase-1 SVG and not a character a phone may render as
//   emoji, that the control carries a name a screen reader can tell apart
//   from 550 others, that no inline `onclick=` reaches the bundle, and that
//   every count on the page is derived from the store rather than held
//   somewhere a removal would not reach.
//
//   It CANNOT prove the target is 44px or that the ✕ sits where a thumb
//   expects it. Those are global.css and the acceptance for them is a
//   screenshot of the real page at 1280 and 375 —
//   .superpowers/sdd/upload-remove-shots/.
//
// The DIVISION OF LABOUR with upload-engine.test.ts is deliberate. That file
// drives the real engine and proves the store shrinks, the journal is
// cleaned and the in-flight file is refused. This one seeds the store
// directly and proves the component renders whatever the store says. Neither
// re-tests the other's half, and between them the path from a click to a
// number on screen is covered end to end.
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { loadRenderers } from 'astro:container'
import { getContainerRenderer } from '@astrojs/solid-js'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { produce } from 'solid-js/store'
import UploadDropzone from './UploadDropzone'
import { setUploadRows, uploadRows, type Row } from '../lib/upload-store'
import { ICONS } from '../lib/icons'
import type { RowStatus } from '../lib/upload-progress'

let container: AstroContainer

beforeAll(async () => {
  // Explicit renderer, same as track-page.test.ts: without it the container
  // throws on the island instead of rendering it. The deprecation hint on
  // getContainerRenderer is known and it is still the only way in.
  container = await AstroContainer.create({
    renderers: await loadRenderers([getContainerRenderer()]),
  })
})

const row = (over: Partial<Row> & { key: string }): Row => ({
  fileId: '', name: `${over.key}.mp3`, size: 1_000, status: 'queued',
  loaded: 0, message: 'ready', duration: '03:00', resumed: false,
  discarded: false, ...over,
})

beforeEach(() => {
  // The store is a module singleton — the point of UX.12 — so it has to be
  // emptied between tests rather than re-created.
  setUploadRows(produce((list) => { list.splice(0) }))
})

const render = async (rows: Row[]): Promise<string> => {
  setUploadRows(produce((list) => { list.push(...rows) }))
  return container.renderToString(UploadDropzone as never, { props: { userId: 'member-1' } })
}

/** The <li> for one row, so an assertion cannot accidentally match a
 *  different row's control. */
const liFor = (html: string, name: string): string => {
  const at = html.indexOf(`>${name}<`)
  expect(at, `no row rendered for ${name}`).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<li', at)
  return html.slice(open, html.indexOf('</li>', at) + 5)
}

const hasRemove = (html: string, name: string): boolean =>
  liFor(html, name).includes('class="rowremove"')

/**
 * The rendered COPY, as a member reads it.
 *
 * Solid's SSR fences every dynamic expression in hydration markers, so
 * `{count} file{count === 1 ? '' : 's'} selected` reaches the page as
 * `<!--$-->3<!--/--> file<!--$-->s<!--/--> selected`. Asserting on raw HTML
 * would therefore test Solid's marker placement rather than the sentence,
 * and would break on any refactor that moved an interpolation boundary.
 */
const copy = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// ------------------------------------------------- which rows get the ✕

describe('the ✕ appears on exactly the rows the engine will honour', () => {
  it.each<[RowStatus, boolean]>([
    ['checking', true],
    ['queued', true],
    ['skipped', true],
    ['uploading', false],
    ['done', false],
    ['already', false],
    ['failed', false],
    ['cancelled', false],
  ])('%s -> %s', async (status, expected) => {
    const html = await render([row({ key: 'a', name: 'a.mp3', status })])
    expect(hasRemove(html, 'a.mp3')).toBe(expected)
  })

  it('the in-flight row has NO control while its neighbours do', async () => {
    // The mid-batch picture, in one render: three transferring, two waiting.
    // The waiting rows are evictable and the moving ones are not, on the same
    // screen at the same time — which is the thing a member has to be able
    // to read at a glance without a disabled-looking button lying to them.
    const html = await render([
      row({ key: 'a', name: 'a.mp3', status: 'uploading', loaded: 500 }),
      row({ key: 'b', name: 'b.mp3', status: 'uploading', loaded: 200 }),
      row({ key: 'c', name: 'c.mp3', status: 'uploading', loaded: 10 }),
      row({ key: 'd', name: 'd.mp3', status: 'queued' }),
      row({ key: 'e', name: 'e.mp3', status: 'queued' }),
    ])
    expect(['a.mp3', 'b.mp3', 'c.mp3'].map((n) => hasRemove(html, n))).toEqual([false, false, false])
    expect(['d.mp3', 'e.mp3'].map((n) => hasRemove(html, n))).toEqual([true, true])
  })

  it('is ABSENT rather than disabled on an in-flight row', async () => {
    // A disabled ✕ says "this is removable, later". It is not: this file is
    // being written to R2 right now and Cancel is the control that stops it.
    const html = await render([row({ key: 'a', name: 'a.mp3', status: 'uploading' })])
    expect(liFor(html, 'a.mp3')).not.toContain('rowremove')
  })

  it('is NOT disabled by a running batch, unlike the Retry beside it', async () => {
    // Retry carries `disabled={uploadRunning()}`; evicting a not-yet-started
    // file mid-batch is half of what this feature is for, so the ✕ must not
    // copy that. Asserted on a rendered row that also HAS a Retry, so the
    // two controls are compared in the one place they coexist.
    const html = await render([
      row({ key: 'a', name: 'a.mp3', status: 'failed', message: 'R2 said no' }),
      row({ key: 'b', name: 'b.mp3', status: 'queued' }),
    ])
    const remove = liFor(html, 'b.mp3')
    expect(remove).toContain('rowremove')
    expect(remove.slice(remove.indexOf('rowremove'))).not.toContain('disabled')
  })
})

// ------------------------------------------------------------- the glyph

describe('the ✕ is drawn, not typed', () => {
  it('renders the Phase-1 `close` path, server-side', async () => {
    // Two claims in one. First, the geometry is icons.ts's and not a second
    // copy that will drift from it. Second — and this is the one worth a
    // test — Solid's `innerHTML` SURVIVES SSR: the island is `client:load`,
    // so a glyph that only appeared after hydration would be an empty box on
    // 551 rows for as long as the bundle takes to arrive.
    const html = await render([row({ key: 'a', name: 'a.mp3' })])
    expect(liFor(html, 'a.mp3')).toContain(ICONS.close)
  })

  it('carries no character a phone can render as emoji', async () => {
    // The owner's original report was the player transport rendering as fat
    // blue emoji on iOS. ✕ and × are both in control-glyphs.test.ts's list;
    // that scanner only reads .astro files, so this is the .tsx half of the
    // same rule.
    const html = await render([row({ key: 'a', name: 'a.mp3' })])
    const button = liFor(html, 'a.mp3')
    for (const glyph of ['✕', '✖', '✗', '×', '☓']) {
      expect(button, `drew itself with ${glyph}`).not.toContain(glyph)
    }
  })

  it('hides the glyph from assistive tech and names the BUTTON instead', async () => {
    const button = liFor(await render([row({ key: 'a', name: 'a.mp3' })]), 'a.mp3')
    expect(button).toContain('aria-hidden="true"')
    expect(button).toContain('aria-label="Remove a.mp3 from the queue"')
  })

  it('names each control after its own file, so 551 of them are tellable apart', async () => {
    const html = await render([
      row({ key: 'a', name: 'Mochakk - Jealous.mp3' }),
      row({ key: 'b', name: 'Overmono - So U Kno.flac' }),
    ])
    expect(html).toContain('aria-label="Remove Mochakk - Jealous.mp3 from the queue"')
    expect(html).toContain('aria-label="Remove Overmono - So U Kno.flac from the queue"')
  })
})

// --------------------------------------------------- the WAF / delegation

describe('no inline handler reaches the bundle — survive-list #6', () => {
  it('the server-rendered island contains no onclick attribute', async () => {
    // An inline `onclick=` in the bundle trips Cloudflare's API WAF and 403s
    // the DEPLOY, not the request — a failure that shows up nowhere until
    // release. Solid compiles `onClick` to a delegated listener and emits
    // nothing in SSR; this asserts that stays true for the whole island, not
    // just for the control added here.
    const html = await render([
      row({ key: 'a', name: 'a.mp3', status: 'queued' }),
      row({ key: 'b', name: 'b.mp3', status: 'failed' }),
    ])
    expect(html).not.toMatch(/\son[a-z]+=/i)
  })
})

// ------------------------------------------------ every count is derived

describe('every number on the page is derived from the store', () => {
  // Removal writes ONE thing — the row list. Anything the page holds
  // separately would keep the old value and the member would read "551 files
  // selected" over a list of 550. These render the before and after states
  // the engine test produces, and read the copy back.
  const three = [
    row({ key: 'a', name: 'a.mp3', size: 100 }),
    row({ key: 'b', name: 'b.mp3', size: 200 }),
    row({ key: 'c', name: 'c.mp3', size: 400 }),
  ]

  /** Re-render the SAME store after a splice, which is what removeRow does
   *  to it. */
  const rerender = async (): Promise<string> =>
    copy(await container.renderToString(UploadDropzone as never, { props: { userId: 'm' } }))

  it('"N files selected" counts rows', async () => {
    expect(copy(await render(three))).toContain('3 files selected')
    setUploadRows(produce((list) => { list.splice(1, 1) }))
    const after = await rerender()
    expect(after).toContain('2 files selected')
    expect(after).not.toContain('3 files selected')
  })

  it('the Upload button counts only queued rows', async () => {
    const html = copy(await render([...three, row({ key: 'd', name: 'd.mp3', status: 'skipped' })]))
    expect(html).toContain('Upload 3 files')
    expect(html).toContain('4 files selected')
  })

  it('singularises at one — the last row before an empty queue', async () => {
    expect(copy(await render([row({ key: 'a', name: 'a.mp3' })]))).toContain('1 file selected')
    expect(uploadRows.length).toBe(1)
  })

  it('the byte line and the progress denominator shrink with the queue', async () => {
    const before = copy(await render(three))
    expect(before).toContain('0 of 3 done — 0 B of 700 B')

    setUploadRows(produce((list) => { list.splice(2, 1) }))
    const after = await rerender()
    expect(after).toContain('0 of 2 done — 0 B of 300 B')
    expect(after).not.toContain('700 B')
  })

  it('the resume prompt re-derives its own count', async () => {
    // "294 of these were uploaded before…" is the copy the owner will see on
    // a second visit. It is a filter over the same rows, so an eviction has
    // to move it without anything being told to recount.
    const before = copy(await render([
      row({ key: 'a', name: 'a.mp3', resumed: true }),
      row({ key: 'b', name: 'b.mp3', resumed: true }),
      row({ key: 'c', name: 'c.mp3', resumed: false }),
    ]))
    expect(before).toContain('2 of these were uploaded before')

    setUploadRows(produce((list) => { list.splice(0, 1) }))
    expect(await rerender()).toContain('1 of these were uploaded before')
  })

  it('an emptied queue puts the page back to its opening state', async () => {
    // Evicting the last row is a real click, and the three <Show>s it closes
    // are the ones that would otherwise render "0 files selected" and a
    // progress bar over nothing.
    await render([row({ key: 'a', name: 'a.mp3' })])
    setUploadRows(produce((list) => { list.splice(0) }))
    const after = await rerender()
    expect(after).not.toContain('files selected')
    expect(after).not.toContain('done —')
    expect(after).toContain('Upload 0 files')
  })
})
