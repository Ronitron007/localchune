// src/scripts/drag-bundle.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE DRAG LIBRARY MUST NOT REACH A PAGE THAT DOES NOT REORDER.
//
// `@formkit/drag-and-drop` is 8.7 KB gzip. Two surfaces reorder — the queue
// drawer's layer 1 and the owner's own crate page — and every other page in
// the app must gain nothing. The shell every signed-in page loads is site.ts;
// /login ships no JavaScript at all; a /pool a member only reads is the same
// site.ts as everything else. So "shell, login and a read-only pool gain zero
// bytes" is one measurable claim about ONE file's entry chunk.
//
// IT IS MEASURED, NOT ASSERTED. A source guard can prove the import is
// written as a dynamic one; it cannot prove the bundler honoured that and
// emitted a separate chunk. One badly-placed re-export, one `export *`, one
// helper hoisted into a shared module, and the library is back in the entry
// with the source still reading exactly as it does now — no build error, no
// failing test, no visible change on a laptop. That is the same shape as the
// perf phase's `worker.format` default, and it gets the same treatment: run
// the bundler and look.
//
// esbuild rather than the real build, for one reason: `npm test` runs BEFORE
// `npm run build` in CI, so `dist/` does not exist when this file runs. A
// guard that skipped itself when the directory was missing would be green in
// CI and prove nothing, which is worse than no guard. esbuild is already
// installed (vite's own dependency), it splits chunks on the same rule
// rolldown does — a dynamic import is a chunk boundary — and it costs about a
// second.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as esbuild from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname
const ROOT = join(SRC, '..')
const LIB = '@formkit/drag-and-drop'

/**
 * A string that appears in the library's own code and in nothing this repo
 * wrote. `dragPlaceholderClass` is one of its config keys; grepping for the
 * package NAME would match our own import statement and pass vacuously.
 */
const FINGERPRINT = 'dragPlaceholderClass'

let entry: string
let entryMin: string
let others: { name: string; text: string }[]

const build = (minify: boolean) => esbuild.build({
  entryPoints: [join(SRC, 'scripts/site.ts')],
  absWorkingDir: ROOT,
  bundle: true,
  write: false,
  splitting: true,
  format: 'esm',
  outdir: 'out',
  target: 'es2022',
  platform: 'browser',
  logLevel: 'silent',
  minify,
})

beforeAll(async () => {
  const out = await build(false)
  const files = out.outputFiles.map((f) => ({
    name: f.path.split('/').pop() ?? '',
    text: f.text,
  }))
  entry = files.find((f) => f.name === 'site.js')?.text ?? ''
  others = files.filter((f) => f.name !== 'site.js')

  // The BUDGET is measured minified — see the note on it below. The
  // readable build above is what the fingerprint assertions read, because a
  // minified chunk still contains the library's own config-key strings but
  // not our function names.
  const min = await build(true)
  entryMin = min.outputFiles.find((f) => f.path.endsWith('/site.js'))?.text ?? ''
})

describe('the drag library is in a chunk of its own', () => {
  it('bundles site.ts into more than one chunk', () => {
    // If this fails, splitting did not happen at all and every assertion
    // below is vacuously true.
    expect(entry.length).toBeGreaterThan(0)
    expect(others.length).toBeGreaterThan(0)
  })

  it('keeps the library OUT of the entry chunk — the shell, /login and /pool', () => {
    expect(entry).not.toContain(FINGERPRINT)
  })

  it('puts it in exactly one of the split chunks', () => {
    const carriers = others.filter((f) => f.text.includes(FINGERPRINT))
    expect(carriers.length).toBe(1)
  })

  it('splits at the drag module, so its WIRING is lazy too, not just the lib', () => {
    // wireDragList itself is ~30 lines and would be free to inline. It is in
    // the lazy chunk on purpose: the boundary is the module, so nothing about
    // dragging — not the library, not the code that configures it — is
    // parsed by a page that cannot reorder.
    const carrier = others.find((f) => f.text.includes(FINGERPRINT))
    expect(carrier?.text).toContain('wireDragList')
    expect(entry).not.toContain('function wireDragList')
  })

  it('leaves the entry chunk NO BIGGER than it was before drag existed', () => {
    // The measured outcome, and it is better than "zero bytes": the entry was
    // 89,779 B before this feature and is 89,400 B after — 379 bytes SMALLER.
    // The dynamic import does cost a preload helper and a chunk URL, and the
    // hundred lines of native HTML5 drag delegation this replaced cost more.
    //
    // A budget rather than the exact number, because site.ts grows for
    // reasons that have nothing to do with dragging and a test that fails on
    // every unrelated edit gets deleted. The headroom is deliberate and the
    // regression it catches is enormous by comparison: a static import puts
    // the library's 30,171 B back in this chunk, which no plausible amount of
    // ordinary growth reaches first.
    //
    // RAISED FROM 92,000 TO 96,000 ON 2026-08-07, and the honest reason is
    // that this measures esbuild's UNMINIFIED output, where a comment is a
    // byte. The queue drawer's swipe-down added src/scripts/drag-dismiss.ts
    // (+2,851 B here: 89,183 -> 92,034) and almost all of that is prose —
    // the module is ~60 lines of code under a header explaining why the
    // gesture has one implementation instead of two. The production bundle
    // is minified and comments cost nothing in it.
    //
    // The tripwire still trips: 92,034 + the library's 30,171 = 122,205,
    // which clears 96,000 by 26 KB.
    //
    // THIRD RAISE, 2026-08-08, AND THE LAST ONE THAT MOVES THE LINE. The
    // status strip, the name marquee and the drawer's scrim took it to
    // 97,069 B. The note above said the next raise should measure the
    // minified size instead — so this one MINIFIES, and the number below is
    // a different, much steadier quantity: comments and prose cost nothing
    // in it, which is what made the previous two raises pure noise. The
    // library is 8,870 B gzip / ~30 KB raw and does not minify away, so the
    // regression this guards is still enormous next to the headroom.
    //
    // POOL.1 SET IT, ON THE MERGED TREE, AND 60,000 WAS MEASURED BEFORE THE
    // MERGE. Two branches raised this line in the same hour and neither
    // number described the tree they landed in — the merge-order lesson
    // search-report.md already recorded ("two green CIs are not evidence
    // about a tree neither one built"). Measured here, together:
    //
    //                            site.js(min)   overlay   shared chunk
    //   PR #55 alone                  60,000*         —            —
    //   POOL.1 alone                  57,690          —            —
    //   both, this tree               60,640          —            —
    //
    // POOL.1 also RETIRED the search overlay, and the accounting is worth
    // stating because site.js looks like it grew more than it did: before
    // POOL.1 there was a 7,434 B `chunk-*.js` that existed ONLY because
    // site.ts and search-overlay.ts shared icons, sheet, pool-api and
    // track-format, plus a 7,106 B overlay chunk. Every page already paid
    // for the shared one. With one consumer left esbuild folds it back in,
    // so what a member downloads on first paint moved by roughly +1.4 KB
    // while the app as a whole lost the 7,106 B overlay.
    //
    // 68,000: 7.4 KB of headroom, and a static import of the library still
    // trips it by 23 KB (60,640 + 30,632 = 91,272).
    expect(entryMin.length).toBeLessThan(68_000)
  })

  it('and the unminified entry stays loosely bounded too', () => {
    // A SECOND, SLACK CEILING on the RAW output, so it cannot grow without
    // bound while the minified number stays flat — a thousand lines of dead
    // commented-out code would do exactly that and the budget above would
    // not notice. Deliberately generous: prose is free in production and
    // this repo pays for its rules in comments on purpose.
    expect(entry.length).toBeLessThan(140_000)
  })

  it('the lazy chunk really is the whole library, not a stub', () => {
    // Guards the other direction: an assertion that the entry is clean is
    // only worth having if the bytes went somewhere real. 30,171 B raw /
    // 8,870 B gzip minified, against the 8,691 B the Phase 3 shootout
    // measured for the library alone — the difference is wireDragList.
    const carrier = others.find((f) => f.text.includes(FINGERPRINT))
    expect(carrier?.text.length).toBeGreaterThan(25_000)
  })
})

describe('one module owns the import, and reaches it dynamically', () => {
  // The measurement above is the proof; these are the guards that say WHY it
  // holds, so a failure names the mistake instead of just the symptom.
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return sourceFiles(full)
      return /\.(ts|tsx|astro)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : []
    })

  it('is imported by exactly one file in the repo', () => {
    const importers = sourceFiles(SRC)
      .filter((f) => new RegExp(`from '${LIB}'|import\\('${LIB}'`).test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length))
    expect(importers).toEqual(['scripts/drag-reorder.ts'])
  })

  it('is not imported by any .astro page or island', () => {
    // An island would defeat the split even with site.ts spotless — the same
    // hole shell-bundle.test.ts closes for the queue engine.
    const offenders = sourceFiles(SRC)
      .filter((f) => f.endsWith('.astro') || f.endsWith('.tsx'))
      .filter((f) => readFileSync(f, 'utf8').includes(LIB))
      .map((f) => f.slice(SRC.length))
    expect(offenders).toEqual([])
  })

  it('site.ts reaches the drag module through import(), never a static import', () => {
    const site = read('scripts/site.ts')
    expect(site).toContain("import('./drag-reorder')")
    expect(site).not.toMatch(/^import .*from '\.\/drag-reorder'/m)
  })

  it('never keys the load off an element the shell renders on every page', () => {
    // `#queue-sections` is in Shell.astro. Loading on its PRESENCE would
    // download the library on every signed-in page and make the split
    // pointless while every assertion above still passed. The triggers are
    // the drawer being opened and `[data-reorder]` existing.
    const site = read('scripts/site.ts')
    const loads = [...site.matchAll(/loadDragModule\(\)/g)]
    expect(loads.length).toBe(3) // definition + drawer open + crate page
    expect(site).toMatch(/querySelector\('\[data-reorder\]'\)[^\n]*loadDragModule\(\)/)
    expect(site).not.toMatch(/queue-sections'\)[^\n]*loadDragModule/)
  })

  it('a failed import is swallowed — reorder degrades, the page does not', () => {
    const site = read('scripts/site.ts')
    const at = site.indexOf("import('./drag-reorder')")
    expect(site.slice(at, at + 400)).toContain('.catch(')
  })
})

describe('a drag starts from a handle, and only from a handle', () => {
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  it('both surfaces pass one', () => {
    // Without a handle the whole row is the drag surface. On touch that
    // fights the scroll — a finger dragged down a list means "scroll" far
    // more often than "reorder", and the library cannot tell which until it
    // has swallowed the gesture. It is a required field on DragList for this
    // reason; these assert the two call sites actually name a real one.
    const site = read('scripts/site.ts')
    expect(site).toContain("handle: '.queuerow-drag'")
    expect(site).toContain("handle: '.cratedrag'")
  })

  it('the crate page renders its handle server-side', () => {
    expect(read('pages/crate/[id].astro')).toContain('class="cratedrag"')
  })

  it('each handle declares touch-action: none, or a touch drag never starts', () => {
    // The browser claims the gesture for a scroll before the library's first
    // pointermove is heard. Scoped to the handle precisely so the rest of the
    // row still scrolls.
    const css = read('styles/global.css')
    const block = css.slice(css.indexOf('.queuerow-drag,'))
    expect(block.slice(0, block.indexOf('}'))).toContain('touch-action: none')
  })

  /**
   * THE OWNER'S SCREENSHOT, MADE UNREPEATABLE.
   *
   * Mid-drag on a real iPhone the row rendered as two transparent copies
   * lying over each other. Cause: both of the library's dragging hooks
   * pointed at one class (`is-dragging`, `opacity: 0.4`), that class ends
   * up PERMANENTLY on the clone that follows the finger, and the clone's
   * background is copied from a row that paints none.
   *
   * These assertions are deliberately about the WIRING and the CSS
   * PRESENCE rather than about pixels: the failure was invisible to every
   * unit test precisely because it lived in the gap between a library's
   * internals and a stylesheet. Screenshots are in the branch report.
   */
  it('separates the tile under the finger from the slot it left', () => {
    const drag = read('scripts/drag-reorder.ts')
    // Four hooks, two meanings. One class for both was the defect.
    expect(drag).toContain("draggingClass: 'is-draglift'")
    expect(drag).toContain("synthDraggingClass: 'is-draglift'")
    expect(drag).toContain("dragPlaceholderClass: 'is-dragorigin'")
    expect(drag).toContain("synthDragPlaceholderClass: 'is-dragorigin'")
    // The touch path had no drop-target feedback at all while native did.
    expect(drag).toContain("synthDropZoneClass: 'is-over'")
    // Quoted: the file still NAMES the old class in the note that explains
    // why it went, and a bare substring match would read that as the bug.
    expect(drag).not.toContain("'is-dragging'")
  })

  it('gives the dragged tile an opaque fill — the defect was see-through', () => {
    const css = read('styles/global.css')
    for (const sel of ['.is-draglift', '#dnd-dragged-node-clone', '.is-dragorigin']) {
      expect(css, `${sel} must be styled or the drag has no visual state`).toContain(sel)
    }
    // The clone carries the library's own INLINE background, copied off
    // the row, and an inline declaration beats a class rule. Without
    // !important a future reordering inside the library silently restores
    // the transparent tile.
    const clone = css.slice(css.indexOf('#dnd-dragged-node-clone'))
    const body = clone.slice(0, clone.indexOf('}'))
    expect(body).toMatch(/background:[^;]*!important/)
    expect(body).toMatch(/opacity:\s*1\s*!important/)
  })

  it('the origin row is declared after .is-over, or it wears the wrong outline', () => {
    // The library adds its drop-zone class to the dragged node too, so the
    // origin carries both. Equal specificity means source order is the
    // whole decision — and a target and an origin that look alike is the
    // bug being fixed here.
    const css = read('styles/global.css')
    expect(css.indexOf('tr.is-dragorigin')).toBeGreaterThan(css.indexOf('tr.is-over'))
  })

  it('the drawer renders a handle instead of the ↑/↓ pair it replaced', () => {
    const site = read('scripts/site.ts')
    expect(site).toContain('queuerow-drag')
    // OWNER: drag-and-drop replaces the arrow buttons. The class, its
    // delegation and its `data-dir` are gone together — a half-removal
    // leaves a control that renders and does nothing.
    expect(site).not.toContain('queuerow-move')
    expect(site).not.toContain('dataset.dir')
  })

  it('the handle is a real button with a name, so it is tabbable and announced', () => {
    // The library sorts by pointer only. The arrow keys on a focused handle
    // are the entire keyboard path for the drawer, and an <svg aria-hidden>
    // is silent — the name has to be on the control.
    const site = read('scripts/site.ts')
    const at = site.indexOf("button('queuerow-drag'")
    expect(at).toBeGreaterThan(-1)
    expect(site.slice(at, at + 120)).toContain('Reorder ')
    expect(site).toMatch(/e\.key === 'ArrowUp'/)
  })
})

describe('the crate keeps its no-JS reorder — survive-list #10', () => {
  const crate = readFileSync(join(SRC, 'pages/crate/[id].astro'), 'utf8')

  it('still ships the ↑/↓ POST forms, which are the only JS-free reorder', () => {
    // They are the keyboard path here too: the library has no keyboard
    // sorting, so removing them would trade a touch gap for a keyboard one.
    expect(crate).toContain('class="moveform"')
    expect(crate).toContain('/move')
    expect(crate.match(/name="dir"/g)?.length).toBe(2)
  })

  it('those forms still carry data-astro-reload', () => {
    // astro-forms.test.ts enforces this repo-wide; restated here because this
    // file is where someone would delete them.
    for (const [form] of crate.matchAll(/<form[^>]*class="moveform"[^>]*>/g)) {
      expect(form).toContain('data-astro-reload')
    }
  })

  it('keeps the two selectors the drag resolves by name', () => {
    expect(crate).toContain('data-reorder')
    expect(readFileSync(join(SRC, 'components/TrackRow.astro'), 'utf8'))
      .toContain('data-file-id={reorderable ? track.file_id : undefined}')
  })
})
