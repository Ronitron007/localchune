// src/lib/crate-picker-single-source.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// ONE PICKER, ONE CREATE MODAL, ONE PLACE THAT ADDS A TRACK TO A CRATE.
//
// This is `sheet-single-source.test.ts`'s argument applied to the surface
// that grew fastest. Add-to-crate is now reachable from FIVE places — a
// pool row's inline picker, a feed row's, a search result's, the row ⋮'s
// crate sheet, and (owner, 2026-08-07) the player bar's crate button,
// which acts on whatever is playing from any page. The owner asked for a
// sixth thing on all of them: "+ New crate…", opening a modal.
//
// Five surfaces and one new step is exactly the shape that produced two
// navigations and three hand-typed ⋮ buttons. Nothing fails when a picker
// forks: both copies are valid HTML and both mostly work. What breaks is
// that one of them ends up with two of the three error branches, and the
// one that is wrong is whichever nobody re-read.
//
// So this file pins four properties:
//
//   1. The picker's ROW MODEL is computed in one module (crate-picker.ts)
//      and nowhere else.
//   2. `addToCrate()` — the request — has exactly ONE call site in the
//      bundle, and every surface reaches it through `addFileToCrate`.
//   3. There is exactly one create MODAL, and every surface opens THAT.
//   4. The modal is the sheet primitive, not a second overlay.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// A rule about rendered text must read rendered text, not the prose that
// documents it — see that module's header for the five times this repo has
// paid for the difference.
import { withoutComments } from './source-scan'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
const site = read('scripts/site.ts')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(full)
    if (e.name.endsWith('.test.ts')) return []
    return /\.(astro|ts)$/.test(e.name) ? [full] : []
  })
}

describe('the picker has one row model', () => {
  it('cratePickerRows is defined once, in crate-picker.ts', () => {
    expect(read('lib/crate-picker.ts')).toContain('export function cratePickerRows')
    const offenders = sourceFiles(SRC)
      .filter((f) => f.slice(SRC.length) !== 'lib/crate-picker.ts')
      .filter((f) => /function cratePickerRows/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })

  it('site.ts renders the sheet from it rather than mapping crates itself', () => {
    expect(site).toContain('rows: cratePickerRows(crates)')
    // The shape this replaced: `crates.map((c) => ({ id: c.id, label: …`
    // built inline in openCrateSheet. A second one would be a second
    // answer to "what is in a picker".
    expect(site).not.toMatch(/crates\.map\(\(c\) => \(\{\s*id: c\.id/)
  })

  it('the create row label is one constant, not a typed string', () => {
    // Two surfaces render it as markup (the picker menu, the track page)
    // and one as a sheet row. A literal in any of them is a label that can
    // drift on one screen out of three.
    const typed = sourceFiles(SRC)
      .filter((f) => f.slice(SRC.length) !== 'lib/crate-picker.ts')
      .filter((f) => /New crate…/.test(withoutComments(readFileSync(f, 'utf8'))))
    expect(typed.map((f) => f.slice(SRC.length)), 'use NEW_CRATE_LABEL').toEqual([])
  })
})

describe('one request path puts a track in a crate', () => {
  it('addToCrate() is called from exactly two places, and both are the ones', () => {
    // `addFileToCrate` (the option button, the ⋮ sheet, the player bar)
    // and the create modal's second step, which has its own outcome to
    // report and cannot share the first one's messages.
    expect(site.match(/await addToCrate\(/g)?.length).toBe(2)
  })

  it('addFileToCrate exists once and carries all three outcomes', () => {
    expect(site.match(/async function addFileToCrate/g)?.length).toBe(1)
    const fn = site.slice(site.indexOf('async function addFileToCrate'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('DuplicateCrateItemError')
    expect(body).toContain('SessionExpiredError')
    expect(body).toContain('addFailedMessage')
  })

  it('the player bar and the row ⋮ open the SAME picker', () => {
    expect(site.match(/function openCratePicker/g)?.length).toBe(1)
    // Two callers, one function. `openCrateSheet` — the row-only version
    // this replaced — must not come back.
    expect(site.match(/openCratePicker\(\{/g)?.length).toBe(2)
    expect(site).not.toContain('function openCrateSheet')
  })

  it('the row ⋮ still clicks the ROW\'s own button rather than adding itself', () => {
    // The sheet is built by reading the row and acts by pressing what the
    // row already carries — sheet-single-source.test.ts's rule, and the
    // reason the row's in-flight disabling still works from the sheet.
    expect(site).toContain('button.cratepick-option[data-crate-id=')
  })
})

describe('there is one create modal, on the one overlay', () => {
  it('openNewCrateModal is defined once', () => {
    expect(site.match(/function openNewCrateModal/g)?.length).toBe(1)
  })

  it('every surface opens it through the one delegation or the one call', () => {
    // The menus and the track page use `button.cratepick-new`; the picker
    // sheet's create row uses NEW_CRATE_ID. Those are the only two doors.
    expect(site.match(/closest\?\.\('button\.cratepick-new'\)/g)?.length).toBe(1)
    expect(site).toContain('if (id === NEW_CRATE_ID)')
  })

  it('it is the sheet primitive, not a second overlay', () => {
    const fn = site.slice(site.indexOf('function openNewCrateModal'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('openActionSheet({')
    // A second scrim, a second Escape handler or a second <dialog> here
    // would be a second dismissal behaviour — §5.2's whole warning.
    // `scrimEl` rather than the old `sheet-scrim`: the scrim is built by
    // src/lib/overlay.ts now and the class name no longer appears in any
    // module, so the old string had stopped being able to fail.
    for (const smell of ['scrimEl', 'lockPage', 'showModal', 'createElement(\'dialog\')', 'keydown']) {
      expect(body, `the modal must not build its own ${smell}`).not.toContain(smell)
    }
  })

  it('the modal never becomes a POST form by accident', () => {
    const fn = site.slice(site.indexOf('function openNewCrateModal'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    // It fetches. A `method = 'post'` here would be a form inside a
    // portal, which is the one shape §5.2 forbids without
    // data-astro-reload — and this form has no server route to fall back
    // to, so the answer is that it must never be one.
    //
    // MATCHED AS AN ASSIGNMENT, not as the word. A bare `.not
    // .toContain('method')` failed on this function's OWN comment, which
    // says it has no `method` attribute — the substring-versus-meaning
    // trap the drag and search guards were both caught by.
    expect(body).not.toMatch(/\.method\s*=|setAttribute\(\s*'method'/)
    expect(body).not.toMatch(/\.action\s*=|setAttribute\(\s*'action'/)
    expect(body).toContain('e.preventDefault()')
  })
})

describe('every add-to-crate surface offers the create step', () => {
  it('the picker menu builds the trigger', () => {
    const fn = site.slice(site.indexOf('function renderCratePickMenu'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain("'cratepick-new")
    expect(body).toContain('NEW_CRATE_LABEL')
    // The inline text field this replaced must not come back: the owner
    // asked for the create step to be a modal.
    expect(body).not.toContain("input.type = 'text'")
  })

  it('the track page renders it, hidden until JS', () => {
    const page = read('pages/track/[id].astro')
    expect(page).toContain('class="cratepick-new btn-secondary"')
    expect(page).toContain('data-file-id={t.file_id}')
    expect(page).toContain('aria-haspopup="dialog"')
    expect(page).toContain('NEW_CRATE_LABEL')
    // A control that would do nothing without JS must not be visible.
    const btn = page.slice(page.indexOf('class="cratepick-new'))
    expect(btn.slice(0, btn.indexOf('</button>'))).toContain('hidden')
  })

  it('the player bar renders the control the delegation looks for', () => {
    const shell = read('layouts/Shell.astro')
    expect(shell).toContain('class="playercrate"')
    expect(site).toContain("closest?.('button.playercrate')")
  })

  it('site.ts reveals the track page trigger with the other JS-only controls', () => {
    const fn = site.slice(site.indexOf('function revealQueueControls'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('button.cratepick-new[hidden]')
  })
})
