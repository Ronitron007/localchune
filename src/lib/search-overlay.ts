// src/lib/search-overlay.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The nav's search overlay. THE ONLY MODULE IN THIS REPO THAT IS LOADED
 * LAZILY, and the reason is the same one shell-bundle.test.ts already
 * enforces for the queue engine: Shell.astro mounts on every page, so
 * anything reachable from site.ts's static graph ships to /login. site.ts
 * reaches this file through `await import()` inside the click handler, so
 * Rollup emits it as its own chunk and a member pays for it the first time
 * they open search — not on every page view, and never if they never
 * search. src/lib/search-bundle.test.ts fails the build if that import
 * ever becomes a static one.
 *
 * ═══ THE ROW IS NOT A NEW COMPONENT. ═══
 *
 * This is the single most important thing in the file. Every row below is
 * built to match TrackRow.astro's markup CONTRACT exactly — `[data-play-row]`
 * on the row, `a.play[data-track-id]` carrying the six queue attributes,
 * `button.rowmenu`, `button.queueadd[data-file-id]`, `form.likeform`,
 * `details.cratepick[data-file-id]`. Because it does, every document-level
 * delegation site.ts already has serves these rows with NO NEW CODE:
 *
 *   whole-row tap  -> playLinkFromTap()  -> plays
 *   the ⋮          -> openRowSheet()     -> THE pool row's action sheet
 *   + queue        -> the queueadd delegation
 *   the ♥          -> the form.likeform submit delegation
 *   a crate        -> openCrateSheet() + populateCratePickers()
 *
 * So there is no second sheet vocabulary, no second like implementation and
 * no second play path to drift. A row here and a row on /pool are the same
 * row wearing different CSS. If a selector in that list ever changes, it
 * changes in both places or neither — which is what survive-list #7 is for.
 *
 * ═══ WHAT PLAYING A RESULT MEANS ═══
 *
 * These rows are deliberately NOT inside a `[data-queue-list]` container.
 * site.ts's `listContainerOf` therefore returns null and the play is
 * "this track alone, queue nothing" — the same semantics /track/[id] and
 * /review already have. That is the honest reading of a search result: a
 * member who searched for one track did not ask for the other nine to
 * follow it.
 *
 * ═══ NO TEXT GLYPHS ═══
 *
 * Standing owner directive: iOS emoji-renders bare characters like ▶ and ⋮,
 * which is why the icon set exists. Every control here draws an SVG from
 * icons.ts. The one apparent exception is the play triangle, which is drawn
 * by `a.play`'s CSS pseudo-elements (global.css) and is not a character
 * either. The like heart inside the hidden like form is never painted — it exists
 * only so site.ts's delegation has the node it expects to update.
 */

import { debounce } from './debounce'
import { iconEl } from './icons'
import { nextFocusIndex } from './sheet'
import { SessionExpiredError } from './org-api'
import {
  fetchSearch, isAbortError, isSearchable, type SearchResult,
} from './search-api'
import { artistHref } from './pool-api'
import { artThumb2xUrl, artThumbUrl, formatBpm, keyTooltip, LIKE_ICON } from './track-format'
import { formatDuration } from './format'

/**
 * Long enough that a fast typist issues one request per word rather than
 * one per keystroke; short enough that the results feel attached to the
 * keyboard. The pool filter's own auto-submit is 300ms because it costs a
 * full page load; this costs one JSON round trip, so it can be half that.
 */
export const DEBOUNCE_MS = 150

const ART_BASE = import.meta.env.PUBLIC_ART_BASE_URL

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  // textContent, never innerHTML: a title comes from a member's file tags.
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * One result row.
 *
 * The hidden controls at the end are not padding. `openRowSheet` builds its
 * rows by ASKING THE ROW what it can do — it offers "Add to queue" only if
 * `button.queueadd` exists, "Like" only if `form.likeform` does. Rendering
 * them hidden is how a search result gets the same six-row sheet a pool row
 * gets, without this file knowing what any of those actions do. It is also
 * exactly what the pool's own mobile card does: those controls are
 * `display: none` under `html.has-rowmenu`, present in the DOM, clicked by
 * the sheet.
 */
function rowEl(r: SearchResult): HTMLElement {
  const artist = r.display_artist ?? 'Unknown artist'
  const row = el('div', 'searchrow')
  row.dataset.playRow = ''

  // ---- the artwork, which IS the play control (global.css draws the
  //      triangle over it with two pseudo-elements) --------------------
  const play = el('a', 'play')
  play.href = `/track/${r.file_id}`
  play.dataset.trackId = r.file_id
  if (r.display_artist !== null) play.dataset.artist = r.display_artist
  play.dataset.title = r.display_title
  if (r.duration_ms !== null) play.dataset.duration = String(r.duration_ms)
  if (r.bpm !== null) play.dataset.bpm = String(r.bpm)
  if (r.key_camelot !== null) play.dataset.key = r.key_camelot
  play.setAttribute('aria-label', `Play ${r.display_title}`)

  if (r.has_thumb) {
    const img = el('img', 'thumb')
    img.src = artThumbUrl(ART_BASE, r.file_id)
    img.srcset = `${artThumb2xUrl(ART_BASE, r.file_id)} 2x`
    img.alt = ''
    img.width = 44
    img.height = 44
    img.loading = 'lazy'
    play.appendChild(img)
  } else {
    const empty = el('span', 'thumb-empty')
    empty.setAttribute('aria-hidden', 'true')
    play.appendChild(empty)
  }
  row.appendChild(play)

  // ---- two lines: title (linked to the track page) over artist -------
  // The title link is TrackRow's "open track page" affordance, unchanged.
  // It is inside ROW_TAP_EXEMPT, so tapping the words navigates while
  // tapping anywhere else in the row plays — the grammar /pool already
  // ships and the owner has already reviewed.
  const text = el('span', 'searchrow-text')
  const titleLink = el('a', 'searchrow-title', r.display_title)
  titleLink.href = `/track/${r.file_id}`
  text.appendChild(titleLink)
  // The artist line links to the act's page, exactly as the pool row's
  // artist cell and the player bar's second line do. `artistHref` is the
  // one place that knows how an artist page is addressed — see pool-api.
  // Plain text when there is no artist: "Unknown artist" has no page.
  if (r.display_artist === null) {
    text.appendChild(el('span', 'searchrow-artist', artist))
  } else {
    const artistLink = el('a', 'searchrow-artist', artist)
    artistLink.href = artistHref(r.display_artist)
    text.appendChild(artistLink)
  }
  row.appendChild(text)

  // ---- the chips a DJ scans. These class names are ALSO what
  //      openRowSheet's ROW_META reads by `cellText(row, cls)`, which is
  //      why they are `bpm`/`key`/`duration`/`quality` and not
  //      `searchrow-*`. Two jobs, one node, no duplicated value.
  const meta = el('span', 'searchrow-meta')
  if (r.key_camelot !== null) {
    const chip = el('span', 'keychip key', r.key_camelot)
    chip.title = keyTooltip(r.key_camelot, null, null)
    meta.appendChild(chip)
  }
  meta.appendChild(el('span', 'bpm num', formatBpm(r.bpm, null)))
  // Hidden from the row, present for the sheet: the card grammar (§5.1)
  // says two lines of text, so length and quality live in the ⋮ only.
  const dur = el('span', 'duration', formatDuration(r.duration_ms))
  dur.hidden = true
  meta.appendChild(dur)
  if (r.quality_tier !== null) {
    const q = el('span', 'quality', `Tier ${r.quality_tier}`)
    q.hidden = true
    meta.appendChild(q)
  }
  row.appendChild(meta)

  // ---- the ⋮, which is the row's whole control set ------------------
  const menu = el('button', 'rowmenu')
  menu.type = 'button'
  menu.setAttribute('aria-haspopup', 'dialog')
  menu.setAttribute('aria-label', `More actions for ${r.display_title}`)
  menu.appendChild(iconEl('kebab', { size: 20 }))
  row.appendChild(menu)

  // ---- the controls the sheet clicks. Hidden, never removed. --------
  const queueadd = el('button', 'queueadd btn-secondary')
  queueadd.type = 'button'
  queueadd.hidden = true
  queueadd.dataset.fileId = r.file_id
  queueadd.setAttribute('aria-label', `Add ${r.display_title} to the queue`)
  row.appendChild(queueadd)

  // A real POST form with data-astro-reload, because the house rule
  // (CLAUDE.md, astro-forms.test.ts) applies to markup built in a portal
  // exactly as it does to markup on a page. site.ts's delegation
  // intercepts the submit; without JS this row does not exist at all.
  const likeform = el('form', 'likeform')
  likeform.method = 'post'
  likeform.action = `/api/track/${r.file_id}/like`
  likeform.setAttribute('data-astro-reload', '')
  likeform.hidden = true
  const likebtn = el('button', 'likebtn')
  likebtn.type = 'submit'
  likebtn.dataset.fileId = r.file_id
  // The overlay never renders liked state — search_tracks returns
  // liked_by_me but the projection drops it, because a two-line card has
  // nowhere to put it and the sheet re-reads it from here anyway. `false`
  // is the honest default: the sheet shows "Like", and a member who taps it
  // on an already-liked track gets the toggle's real answer back.
  likebtn.setAttribute('aria-pressed', 'false')
  likebtn.setAttribute('aria-label', `Like ${r.display_title}`)
  // The same icon the four rendered surfaces use, not a character. This
  // form is hidden — it exists so site.ts's like delegation has the nodes
  // it expects — but site.ts REPAINTS this glyph on every toggle, so
  // seeding it with anything else would put a stale character in the DOM
  // waiting for a stylesheet change to reveal it.
  const glyph = el('span', 'likeglyph')
  glyph.appendChild(iconEl(LIKE_ICON.name, { size: LIKE_ICON.size }))
  likebtn.appendChild(glyph)
  likebtn.appendChild(el('span', 'likecount', ''))
  likeform.appendChild(likebtn)
  row.appendChild(likeform)

  const cratepick = el('details', 'cratepick')
  cratepick.dataset.fileId = r.file_id
  cratepick.hidden = true
  const summary = document.createElement('summary')
  summary.className = 'btn-secondary'
  cratepick.appendChild(summary)
  cratepick.appendChild(el('div', 'cratepick-menu'))
  row.appendChild(cratepick)

  return row
}

let openOverlay: { close: () => void } | null = null

/** True while the overlay is on screen — site.ts checks before re-opening. */
export const isSearchOpen = (): boolean => openOverlay !== null

/**
 * Builds and shows the overlay. Returns a function that closes it.
 *
 * `returnFocusTo` is the nav icon that opened it: a keyboard user dumped at
 * the top of the document after closing has to find their place again.
 */
export function openSearchOverlay(returnFocusTo?: HTMLElement | null): () => void {
  openOverlay?.close()

  const root = el('div', 'searchoverlay')
  root.dataset.searchOverlay = ''
  const scrim = el('div', 'searchoverlay-scrim')

  const panel = el('div', 'searchoverlay-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', 'Search the pool')

  // ---- the input bar ------------------------------------------------
  const bar = el('div', 'searchoverlay-bar')
  const leading = iconEl('search', { size: 20 })
  leading.classList.add('searchoverlay-leading')
  bar.appendChild(leading)

  const input = el('input', 'searchoverlay-input')
  input.type = 'search'
  input.name = 'q'
  // enterkeyhint: the phone keyboard says "search" rather than "go".
  input.setAttribute('enterkeyhint', 'search')
  input.autocomplete = 'off'
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocorrect', 'off')
  input.spellcheck = false
  input.placeholder = 'artist, title, 128, 8A'
  input.setAttribute('aria-label', 'Search the pool')
  bar.appendChild(input)

  const closeBtn = el('button', 'searchoverlay-close')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close search')
  closeBtn.appendChild(iconEl('close', { size: 20 }))
  bar.appendChild(closeBtn)
  panel.appendChild(bar)

  // ---- results ------------------------------------------------------
  const results = el('div', 'searchoverlay-results')
  results.setAttribute('role', 'group')
  results.setAttribute('aria-label', 'Search results')
  panel.appendChild(results)

  /**
   * The count, announced.
   *
   * A SECOND aria-live REGION, and survive-list #12 says #player-label is
   * the app's one. That rule exists because the player's NAME and ARTIST
   * were about to become two regions describing ONE change, which
   * double-announces. This region describes a different subject entirely,
   * it only exists while a modal is open, and `polite` QUEUES rather than
   * interrupts — so a track advancing mid-search reads after the count
   * instead of racing it. Without this a blind member gets no signal at
   * all that a query returned nothing, which is the worse failure.
   */
  const status = el('p', 'searchoverlay-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  panel.appendChild(status)

  root.appendChild(scrim)
  root.appendChild(panel)

  // ---- state --------------------------------------------------------
  let rows: HTMLElement[] = []
  let active = -1
  let inflight: AbortController | null = null
  let closed = false
  const prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'

  function setActive(i: number): void {
    rows[active]?.classList.remove('is-active')
    active = i
    const row = rows[active]
    if (row === undefined) return
    row.classList.add('is-active')
    row.scrollIntoView({ block: 'nearest' })
  }

  /**
   * The three messages, kept apart — survive-list #16 and §6.6.
   *
   * "No tracks match that" and "Search is unavailable" MUST NOT look alike.
   * A restyle that made an outage read as an empty pool was named the worst
   * possible outcome of the redesign, and a search box is exactly where
   * that confusion costs most: a member who believes their pool is empty
   * stops looking.
   *
   * The message goes in the RESULTS area, not only in the status line — a
   * blank panel with one small grey line at the bottom is not a state, it
   * is a page that failed to render.
   */
  function setMessage(text: string, kind: 'hint' | 'empty' | 'error'): void {
    rows = []
    active = -1
    const box = el('p', `searchoverlay-message is-${kind}`, text)
    results.replaceChildren(box)
    // The status line stays the announcement. Silent for the opening hint:
    // a screen reader has just been handed the input's own label, and
    // reading the placeholder syntax at it unprompted is noise.
    status.textContent = kind === 'hint' ? '' : text
  }

  /** What the overlay says before anything is typed. It TEACHES THE TOKENS,
   *  because a tempo or a key query is otherwise undiscoverable — nothing
   *  else in the app hints that `128` or `8A` mean anything here. */
  const showOpeningHint = (): void => setMessage(
    'Search by artist or title. A number is a tempo (128), and a Camelot key (8A) finds its harmonic neighbours too.',
    'hint',
  )

  function render(list: SearchResult[]): void {
    if (list.length === 0) { setMessage('No tracks match that.', 'empty'); return }
    rows = list.map(rowEl)
    results.replaceChildren(...rows)
    active = -1
    status.textContent = `${list.length} ${list.length === 1 ? 'track' : 'tracks'}`
  }

  const run = debounce((q: string) => {
    // CANCEL THE PREVIOUS ONE. Without this, a slow answer to `mo` can land
    // after a fast answer to `mochakk` and repaint the older result — the
    // classic search race, and it looks exactly like the search being wrong.
    inflight?.abort()
    const ac = new AbortController()
    inflight = ac
    void fetchSearch(q, ac.signal)
      .then((list) => { if (!ac.signal.aborted && !closed) render(list) })
      .catch((err) => {
        if (isAbortError(err) || closed) return
        setMessage(err instanceof SessionExpiredError
          ? 'Session ended — reload to sign in.'
          : 'Search is unavailable right now.', 'error')
      })
  }, DEBOUNCE_MS)

  input.addEventListener('input', () => {
    const raw = input.value
    if (!isSearchable(raw)) {
      // ZERO REQUESTS BELOW THE FLOOR — cancel the pending timer too, or a
      // keystroke that deletes back to one character still fires the search
      // that was already scheduled.
      run.cancel()
      inflight?.abort()
      inflight = null
      // Deleting everything returns to the opening hint rather than to a
      // blank box: the state is "nothing typed yet", which is the state
      // that hint describes.
      if (raw.trim() === '') showOpeningHint()
      else setMessage('Keep typing…', 'hint')
      return
    }
    run(raw.trim())
  })

  function close(): void {
    if (closed) return
    closed = true
    openOverlay = null
    run.cancel()
    inflight?.abort()
    document.body.style.overflow = prevOverflow
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('astro:before-swap', close)
    root.remove()
    if (returnFocusTo?.isConnected) returnFocusTo.focus()
  }

  function onKeydown(e: KeyboardEvent): void {
    // A sheet opened FROM a row sits above this overlay and owns the
    // keyboard while it is up. Its panel is portalled to <body>, outside
    // this root, so testing containment is what keeps Escape closing the
    // sheet rather than closing both at once.
    if (!root.contains(document.activeElement)) return

    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (rows.length === 0) return

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // nextFocusIndex wraps at both ends and returns 0 for an
      // out-of-range current — which is exactly what `active === -1`
      // (nothing highlighted yet) should do on a first ArrowDown.
      setActive(nextFocusIndex(active, rows.length, e.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (e.key === 'Home') { e.preventDefault(); setActive(0); return }
    if (e.key === 'End') { e.preventDefault(); setActive(rows.length - 1); return }

    if (e.key === 'Enter') {
      // Enter with nothing highlighted means the FIRST result: a member who
      // typed a query and pressed enter meant the best match, not nothing.
      const row = rows[active] ?? rows[0]
      const link = row?.querySelector<HTMLAnchorElement>('a.play[data-track-id]')
      if (link === null || link === undefined) return
      e.preventDefault()
      // .click() rather than calling into the player: site.ts's play
      // delegation is the ONE play path, and it is listening on document.
      link.click()
      close()
    }
  }

  scrim.addEventListener('click', close)
  closeBtn.addEventListener('click', close)

  /**
   * A tap that resolved to an action dismisses the overlay — the member got
   * what they came for, and leaving a search box over the thing that just
   * started playing is the one state nobody wants.
   *
   * Bubble phase, so site.ts's capture-phase play delegation has already
   * run by the time this fires.
   *
   * THE ⋮ IS THE EXCEPTION, and it is load-bearing. `openRowSheet` builds
   * its sheet by READING THE ROW — the row's `a.play`, its `likeform`, its
   * `cratepick`, its metadata cells. Closing here would detach that row
   * from the document before the sheet had finished reading it, and the
   * sheet's own "Add to a crate…" step re-queries the row LATER still. So
   * the overlay stays up underneath the sheet, which is also why it sits at
   * z-index 45 and the sheet at 60.
   */
  results.addEventListener('click', (e) => {
    const target = e.target as Element | null
    if (target === null) return
    if (target.closest('button.rowmenu') !== null) return
    if (target.closest('details.cratepick') !== null) return
    // Either an explicit control was hit, or the row itself was — which
    // site.ts has just turned into a play.
    const acted = target.closest('a, button') !== null
      || target.closest('[data-play-row]') !== null
    if (acted) close()
  })
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('astro:before-swap', close)

  showOpeningHint()
  document.body.appendChild(root)
  requestAnimationFrame(() => root.classList.add('is-open'))
  input.focus()

  openOverlay = { close }
  return close
}
