// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// /track/[id], RENDERED — task 3.6 and the two defects the owner reported
// on this exact page.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, said plainly, because getting this
// wrong is how the separator defect survived a fix:
//
//   It CAN pin the shape of the markup — that `.signals` is an element the
//   HTML parser will not close early, that the count run has real sibling
//   children for the `> * + *` rule to hang a dot on, that the play control
//   carries an <svg> and not a glyph, that the hero reserves its box, and
//   that every survive-list contract on the page is intact.
//
//   It CANNOT prove the owner sees a dot. The separator is a `::before` in
//   global.css and the bug was a browser PARSER behaviour, so the acceptance
//   for the visual defect is a screenshot of the real page at 375px —
//   .superpowers/sdd/track-page/. A component test standing in for that is
//   what shipped the defect twice.
//
// The parser half of the rule is enforced repo-wide by
// src/lib/astro-html-nesting.test.ts; the glyph half by
// src/lib/control-glyphs.test.ts. This file is the per-surface pin.
// The Solid renderer is wired explicitly because this renders the whole
// PAGE, Shell included, and Shell mounts `<UploadChip client:load>`. Without
// it the container throws on the island rather than rendering the article.
// `getContainerRenderer` carries a deprecation hint under astro check; it is
// still the only way to hand the container a renderer, and dropping it fails
// all seventeen assertions here — verified, not assumed.
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { loadRenderers } from 'astro:container'
import { getContainerRenderer } from '@astrojs/solid-js'
import { beforeAll, describe, expect, it } from 'vitest'
import Page from './track/[id].astro'

const FILE_ID = '11111111-2222-4333-8444-555555555555'

/** The owner's own worst case: likes > 0, plays > 0, downloads = 0 — three
 *  adjacent numerals in one run — plus a 103-character filename and a
 *  copyright line longer than the content box. */
const row = {
  file_id: FILE_ID,
  track_id: FILE_ID,
  uploaded_by: 'user-1',
  uploader_name: 'rohan',
  original_filename:
    '01 Anonymous Recordings Collective Berlin - A Very Long Title (Extended Club Mix) [Remastered 2026].flac',
  r2_key: 'a/b',
  display_artist: 'Anonymous Recordings Collective Berlin',
  display_title: 'A Very Long Title (Extended Club Mix)',
  container: 'flac',
  byte_size: 48_123_456,
  state: 'stored',
  duration_ms: 384_000,
  bpm: 128.4,
  ibi_std_ms: 2.1,
  beat_count: 812,
  key_camelot: '8A',
  key_open: '1m',
  key_musical: 'Am',
  key_strength: 0.8,
  key_alt_profiles: { edma: '8A' },
  integrated_lufs: -8.2,
  lra_lu: 4.1,
  true_peak_dbtp: 1.2,
  replaygain_db: -2.4,
  clipped_pct: 0.12,
  quality_tier: 3,
  quality_score: 0.9,
  lossy_ancestor: null,
  meas_cutoff_hz: 21000,
  preview_key: null,
  peaks_key: null,
  artwork_key: 'art/x',
  thumb_key: 'thumb/x',
  provenance: {
    copyright: '(C) 2026 A Very Long Record Label Name Limited, under exclusive licence',
    label: 'Some Label Recordings',
  },
  analysis_version: 'v3',
  analyzed_at: '2026-08-01T10:00:00Z',
  batch_id: 'b-1',
  batch_label: 'august dig',
  claim_names: ['mate'],
  created_at: '2026-07-01T10:00:00Z',
  download_count: 0,
  upload_count: 2,
  tags: ['techno', 'peak-time'],
  like_count: 3,
  liked_by_me: true,
  play_count: 17,
}

const locals = {
  member: {
    user_id: 'user-1',
    username: 'rohan',
    role: 'owner',
    access_expires_at: '2036-01-01T00:00:00Z',
    email: 'owner@local.test',
  },
  supabase: {
    rpc: (name: string) =>
      Promise.resolve(
        name === 'pool_get'
          ? { data: [row], error: null }
          : name === 'my_storage'
            ? { data: [{ occupying_bytes: 1, contributed_bytes: 2 }], error: null }
            : name === 'review_pending_count'
              ? { data: 0, error: null }
              : { data: [{ id: 'c-1', name: 'friday night', is_mine: true }], error: null },
      ),
  },
} as unknown as App.Locals

let html = ''

beforeAll(async () => {
  const container = await AstroContainer.create({
    renderers: await loadRenderers([getContainerRenderer()]),
  })
  html = await container.renderToString(Page, {
    params: { id: FILE_ID },
    locals,
    request: new Request(`http://localhost/track/${FILE_ID}`),
  })
})

/** The markup between a container's opening tag and its closing tag. */
function block(openTag: string, closeTag: string): string {
  const start = html.indexOf(openTag)
  expect(start, `${openTag} not rendered`).toBeGreaterThan(-1)
  const end = html.indexOf(closeTag, start)
  return html.slice(start, end)
}

describe('defect 2 — the count run keeps its separators', () => {
  it('.signals is not a <p>, so a <form> cannot close it', () => {
    // The whole defect in one assertion. `<p class="signals"><form>` is
    // valid-looking markup that the parser turns into an EMPTY paragraph
    // with the form as a sibling, and `.signals > * + *::before` then has
    // nothing to match.
    expect(html).toContain('<div class="signals">')
    expect(html).not.toContain('<p class="signals">')
  })

  it('.stats is not a <p> either', () => {
    expect(html).toContain('<div class="stats">')
    expect(html).not.toContain('<p class="stats">')
  })

  it('every count is its own element, so the dot has a sibling to sit on', () => {
    // Three children: the like form, the play count, the download count.
    // Two adjacent siblings means two generated dots.
    const signals = block('<div class="signals">', '</div>')
    expect(signals).toContain('class="likeform"')
    expect((signals.match(/<span class="signal">/g) ?? []).length).toBe(2)
  })

  it('no count run types its own separator', () => {
    // The dot is generated in global.css so no surface can forget it and
    // no surface can double it.
    const signals = block('<div class="signals">', '</div>')
    expect(signals).not.toContain('·')
  })

  it('the adjacent numerals the owner read as one number are still adjacent', () => {
    // 3 likes, 17 plays, 0 downloads — the exact shape that read as "317".
    // Pinned so the fixture cannot drift into non-adjacent numbers and make
    // the separator look unnecessary.
    const signals = block('<div class="signals">', '</div>')
    expect(signals).toContain('>3</span>')
    expect(signals).toContain('17 plays')
    expect(signals).toContain('0 downloads')
  })
})

describe('defect 1 — the play control is a button, not a glyph under a scrim', () => {
  it('the play link renders an <svg>, never a text triangle', () => {
    const transport = block('<div class="transport">', '</div>')
    expect(transport).toContain('<svg')
    expect(transport).not.toContain('▶')
  })

  it('it carries .playbtn, which is what turns the artwork scrim off', () => {
    // a.play's ::before/::after draw a scrim square and a triangle over the
    // artwork the link wraps in a row. This page has no artwork inside the
    // link, so without this class they paint over the label — which is what
    // the owner saw as "►▯ay".
    expect(html).toMatch(/class="play playbtn"/)
  })

  it('download is a real tier button, not a bare ↓ link', () => {
    const transport = block('<div class="transport">', '</div>')
    expect(transport).toContain('btn-secondary')
    expect(transport).not.toContain('↓')
  })
})

describe('the detail page can queue — owner, 2026-08-07', () => {
  // "on track details page...no way to add it to queue." Every ROW surface
  // has had `+Q` since M6b, and the spec's §4 says "+ queue is a companion
  // to play, everywhere play appears". This page was the one place play
  // appeared without it.
  const transport = () => block('<div class="transport">', '</div>')

  it('the action group reads Play · Download · Queue, in that order', () => {
    const t = transport()
    // Matched on the CLOSING tag of each control, not on the visible word:
    // the word also appears inside `aria-label`s ("Play …", "Add … to the
    // queue") and inside `href`s, so a bare substring finds the wrong
    // occurrence and orders three attributes instead of three controls.
    const order = ['Play</a>', 'Download\n', 'Queue</button>'].map((s) => t.indexOf(s.trim()))
    expect(order.every((i) => i > -1), `missing one of Play/Download/Queue: ${t}`).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('it is the same `button.queueadd` contract every row uses', () => {
    // site.ts finds this by ONE selector and reads ONE attribute; a
    // different class or a missing data-file-id is a control that silently
    // does nothing, with no build error.
    const t = transport()
    expect(t).toContain('class="queueadd btn-secondary"')
    expect(t).toContain(`data-file-id="${FILE_ID}"`)
  })

  it('it does NOT copy the queue metadata — the play link is the source', () => {
    // site.ts's delegation calls playLinkFor(fileId) and scrapes artist,
    // title, duration, bpm and key off `a.play[data-track-id]`. That link
    // is directly above this button and already carries all five. A copy
    // here would be a second source for one queue entry, and the two would
    // eventually disagree.
    const t = transport()
    const btn = t.slice(t.indexOf('class="queueadd'))
    for (const attr of ['data-artist', 'data-title', 'data-duration', 'data-bpm', 'data-key']) {
      expect(btn, `the button must not carry ${attr}`).not.toContain(attr)
    }
  })

  it('ships hidden, because the queue has no server fallback', () => {
    const t = transport()
    const btn = t.slice(t.indexOf('class="queueadd'))
    expect(btn.slice(0, btn.indexOf('>'))).toContain('hidden')
  })

  it('is a <button>, so astro-forms has nothing to enforce here', () => {
    const t = transport()
    expect(t.slice(t.indexOf('class="queueadd'))).not.toContain('<form')
    expect(t).toContain('type="button"')
  })

  it('names the track, since the glyph is aria-hidden', () => {
    expect(transport()).toMatch(/aria-label="Add [^"]+ to the queue"/)
  })
})

describe('survive-list contracts on this page', () => {
  it('#7 — a.play keeps its class and all six data attributes', () => {
    // site.ts scrapes these off THIS element. A rename or a move to a
    // wrapper kills playback from this page with no build error.
    expect(html).toMatch(/<a\s+class="play playbtn"/)
    for (const attr of ['data-track-id', 'data-artist', 'data-title', 'data-duration', 'data-bpm', 'data-key']) {
      expect(html, `a.play lost ${attr}`).toContain(attr)
    }
  })

  it('#7 — the single-track context queues nothing, and that is correct', () => {
    // No [data-queue-list] on this page: playing from a track page plays
    // that track alone. site.ts's scrape finds no list container and
    // starts a one-entry queue, which is the intended behaviour here.
    expect(html).not.toContain('data-queue-list')
  })

  it('#7 — the like form keeps its exact shape', () => {
    // form.likeform > button.likebtn[data-file-id] > .likeglyph + .likecount,
    // the one shape site.ts's document-level submit delegation understands.
    const form = block('<form method="post" action="/api/track/', '</form>')
    expect(form).toContain('class="likeform"')
    expect(form).toContain('class="likebtn"')
    expect(form).toContain('data-file-id')
    expect(form).toContain('class="likeglyph"')
    expect(form).toContain('class="likecount"')
  })

  it('#1 — every POST form carries data-astro-reload', () => {
    const forms = html.match(/<form[^>]*method="post"[^>]*>/g) ?? []
    expect(forms.length).toBeGreaterThan(1)
    for (const f of forms) expect(f, f).toContain('data-astro-reload')
  })

  it('#10 — the no-JS add-to-crate form is still server-rendered here', () => {
    // This form is THE no-JS path for every row's `+` picker in the app.
    expect(html).toContain('action="/api/crate/add-dispatch"')
    expect(html).toContain('<select name="crate_id"')
  })

  it('#15 — the hero keeps the class and id the art fallback reads', () => {
    expect(html).toMatch(/<img\s+class="art"/)
    expect(html).toContain('data-art-file')
  })
})

describe('task 3.6 — the layout fixes', () => {
  it('the hero reserves its box, so the art cannot shift the page', () => {
    const img = block('<img', '>')
    expect(img).toContain('width="256"')
    expect(img).toContain('height="256"')
  })

  it('the long filename is rendered whole — wrapping is the CSS half', () => {
    // The 103-character filename is offender #5's trigger. It is not
    // truncated server-side; `overflow-wrap: anywhere` on every dd is what
    // stops it taking the page sideways.
    expect(html).toContain('[Remastered 2026].flac')
  })

  it('the metadata is a <dl>, which is what the stacking rule targets', () => {
    expect((html.match(/<dl>/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})
