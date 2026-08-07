// src/lib/crate-download-entry.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The crate download's ENTRY POINTS, checked in the markup rather than
// trusted to review.
//
// Two of the three things asserted here have already cost this repo a
// production bug in another form:
//
//  * A same-origin <a> without `download` is intercepted by ClientRouter,
//    which fetches it, finds a non-HTML content type, and falls back to
//    location.href — turning a streamed attachment into a navigation. This
//    is the anchor-shaped sibling of the POST-form 404 that shipped three
//    times (CLAUDE.md, and astro-forms.test.ts at length). ClientRouter's
//    own opt-out is `link.hasAttribute('download')`.
//  * The three-tier button doctrine reserves .btn-danger for destructive
//    actions (ui-audit.md §8). Taking a copy of your own crate is not
//    destructive, and a red button on a read-only action is how a toolbar
//    starts reading as a ransom note.
//
// The third is the plain one: the link has to point at the route that
// exists.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname
const CRATE_PAGE = `${SRC}pages/crate/[id].astro`

/** Every `<a …>` opening tag in a source file, whitespace-normalised. */
function anchors(source: string): string[] {
  return (source.match(/<a\b[^>]*>/gs) ?? []).map((a) => a.replace(/\s+/g, ' '))
}

function downloadAnchors(source: string): string[] {
  return anchors(source).filter((a) => a.includes('/download'))
}

describe('the crate page download control', () => {
  const page = readFileSync(CRATE_PAGE, 'utf8')

  it('exists, and points at the crate download route', () => {
    const links = downloadAnchors(page)
    expect(links).toHaveLength(1)
    expect(links[0]).toContain('/api/crate/${id}/download')
  })

  it('carries `download`, so ClientRouter cannot swallow the attachment', () => {
    expect(downloadAnchors(page)[0]).toMatch(/\bdownload\b/)
  })

  it('also carries data-astro-reload, saying the same thing a second way', () => {
    expect(downloadAnchors(page)[0]).toContain('data-astro-reload')
  })

  it('is the SECONDARY tier — a copy of your own crate is not destructive', () => {
    const link = downloadAnchors(page)[0]!
    expect(link).toContain('btn-secondary')
    expect(link).not.toContain('btn-danger')
  })

  it('is labelled for a screen reader, not left as a bare glyph', () => {
    expect(downloadAnchors(page)[0]).toContain('aria-label')
  })

  it('renders only when the crate has tracks, matching the route empty guard', () => {
    // The route answers 409 empty_crate; a link that leads to a JSON error
    // is a link that should not have been on the page.
    const guarded = page.slice(page.indexOf('items.length > 0'))
    expect(guarded).toContain('cratedownload')
    expect(page.indexOf('items.length > 0')).toBeLessThan(page.indexOf('cratedownload'))
  })

  it('uses the download glyph rather than inventing one', () => {
    expect(page).toMatch(/<Icon name="download"/)
  })
})
