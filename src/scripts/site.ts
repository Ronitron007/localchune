// src/scripts/site.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { debounce } from '../lib/debounce'

/**
 * The whole client, ~30 lines: play-link delegation into the one persisted
 * <audio>, and the search box's auto-submit. Document-level listeners on
 * purpose — the ClientRouter swaps page bodies, and delegation is what
 * survives a swap without re-binding. Without JS every play link degrades
 * to its href (the track page) and the Filter button submits the form.
 */
const audio = document.getElementById('player-audio') as HTMLAudioElement | null
const label = document.getElementById('player-label')

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a.play[data-track-id]')
  if (!(a instanceof HTMLAnchorElement) || audio === null) return
  e.preventDefault()
  void (async () => {
    const res = await fetch(`/api/track/${a.dataset.trackId}/source`, {
      headers: { accept: 'application/json' },
    })
    // Non-JSON means middleware redirected to /login — say so, do not parse.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (label) label.textContent = 'Session ended — reload to sign in.'
      return
    }
    const body = (await res.json()) as { url?: string; message?: string; error?: string }
    if (!res.ok || !body.url) {
      if (label) label.textContent = body.message ?? body.error ?? 'could not load that track'
      return
    }
    audio.src = body.url
    if (label) label.textContent = a.dataset.label ?? ''
    void audio.play().catch(() => {
      if (label) label.textContent = 'That track would not play. Try downloading it.'
    })
  })()
})

const autosubmit = debounce((form: HTMLFormElement) => form.requestSubmit(), 300)
document.addEventListener('input', (e) => {
  const el = e.target
  if (el instanceof HTMLInputElement && el.name === 'q'
      && el.form?.hasAttribute('data-autosubmit')) autosubmit(el.form)
})
