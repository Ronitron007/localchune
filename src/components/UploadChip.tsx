// src/components/UploadChip.tsx
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { uploadRows } from '../lib/upload-store'
import {
  DONE_LINGER_MS, aggregateUploads, chipAnnouncement, chipPhase, chipText, chipVisible,
} from '../lib/upload-progress'

/**
 * UX.12's mini progress chip: the batch, visible from every page that is not
 * /upload.
 *
 * Shell.astro mounts exactly one of these, with `transition:persist` — the
 * same mechanism the `.playerbar` div uses, and for the same reason: a
 * persisted element is MOVED into the incoming body rather than recreated
 * (Astro's `swapBodyElement`), so it never disconnects, `astro:unmount`
 * never fires for it, and @astrojs/solid-js never disposes this component.
 * The chip therefore keeps ticking through a navigation instead of
 * unmounting and flashing back in.
 *
 * It renders NO state of its own. Every number comes from the module-scope
 * store in upload-engine.ts and every rule from the pure functions in
 * upload-progress.ts, which /upload's own progress line uses too. There is
 * no second source of truth here to drift.
 *
 * It is an <a href="/upload">, not a button with an onClick: a plain link is
 * keyboard-reachable, announces itself, works if hydration never happens,
 * and lets ClientRouter do the navigation — which is now a safe thing to do
 * mid-batch, and is in fact the whole point of the feature.
 */
export default function UploadChip() {
  const agg = createMemo(() => aggregateUploads(uploadRows))
  const phase = createMemo(() => chipPhase(agg()))

  // Server-rendered HTML has no location. The queue is always empty at that
  // point too, so the chip renders hidden either way and hydration matches.
  const [pathname, setPathname] = createSignal(
    typeof location === 'undefined' ? '' : location.pathname,
  )

  // A persisted island mounts ONCE per document, so `location.pathname` read
  // at mount would be frozen at whatever page the member first landed on —
  // and the one rule this component has is "hide on /upload". ClientRouter
  // fires astro:after-swap on `document` for every soft navigation, which is
  // the moment the URL is authoritative and the new body is in place.
  onMount(() => {
    const sync = () => setPathname(location.pathname)
    sync()
    document.addEventListener('astro:after-swap', sync)
    onCleanup(() => document.removeEventListener('astro:after-swap', sync))
  })

  // `done` is the one phase that expires on a clock rather than on a state
  // change, so it needs a timer to re-run the visibility check; nothing else
  // would tell Solid to look again. Modelled as a boolean rather than a live
  // millisecond count on purpose — a chip that re-renders 60 times a second
  // to count down a value nobody sees is a battery bug, and chipVisible()
  // only ever compares against the one threshold.
  const [lingerExpired, setLingerExpired] = createSignal(false)
  createEffect(() => {
    if (phase() !== 'done') {
      setLingerExpired(false)
      return
    }
    setLingerExpired(false)
    const timer = setTimeout(() => setLingerExpired(true), DONE_LINGER_MS)
    onCleanup(() => clearTimeout(timer))
  })

  const visible = createMemo(() => chipVisible({
    phase: phase(),
    pathname: pathname(),
    sinceSettledMs: lingerExpired() ? DONE_LINGER_MS : 0,
  }))

  return (
    <div class="uploadchip-slot">
      {/* The live region is this hidden span, NOT the pill — see
          chipAnnouncement's own comment. It sits OUTSIDE the <Show> because
          an aria-live region has to be in the document BEFORE its content
          changes; one that appears already-populated is not reliably
          announced. */}
      <span class="sr-only" aria-live="polite">{chipAnnouncement(agg(), phase())}</span>
      <Show when={visible()}>
        <a class={`uploadchip ${phase()}`} href="/upload">
          <span class="uploadchip-text">{chipText(agg(), phase())}</span>
          {/* The bar is progress, so it only draws while there is progress
              to show. "done" and "failed" are words, not fractions. */}
          <Show when={phase() === 'active'}>
            <span class="uploadchip-bar">
              <span class="uploadchip-fill" style={{ width: `${agg().percent}%` }} />
            </span>
          </Show>
        </a>
      </Show>
    </div>
  )
}
