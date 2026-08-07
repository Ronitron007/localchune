// src/lib/player-label-single-source.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE TRACK NAME IS NOT A PLACE TO PUT A MESSAGE.
//
// OWNER, 2026-08-08, with a screenshot: the player bar read "already in It
// just goes and goes" and never went away. The track title and its link
// were GONE, so the track page could not be reached from the bar at all. A
// second instance the same day: "artist — song name — 21 of 100 pool",
// equally permanent.
//
// The cause was one element doing two jobs. #player-label was the
// now-playing identity AND the app's one aria-live status region, and
// `setStatus` wrote `label.textContent = text` — textContent removes every
// child, the title anchor with it. Shell.astro's comment called those
// messages "transient". Nothing ever put the identity back, so every status
// message in the file was permanent until the next track change.
//
// The fix is not a timer. The message has its own strip now and the two
// elements share nothing, so the failure is not a bug that can recur — it
// is a shape that does not exist. THIS FILE IS WHAT KEEPS IT THAT WAY,
// because the cheapest possible regression is one `label.textContent = …`
// typed by somebody who does not know any of the above.
//
// Every assertion reads CODE. withoutComments() exists because five guards
// in this repo have failed on a comment documenting what they guard, and
// this file's own prose is full of the exact strings it forbids.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './source-scan'

const SRC = new URL('../', import.meta.url).pathname
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const site = withoutComments(read('scripts/site.ts'))
const shell = withoutComments(read('layouts/Shell.astro'))

/** The body of a named function, to the next top-level `\n}`. */
function fnBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}`)
  expect(at, `${name} exists`).toBeGreaterThan(-1)
  return source.slice(at, source.indexOf('\n}', at) + 2)
}

describe('the label holds identity and nothing else', () => {
  it('setNowPlaying is the ONLY function that touches #player-label', () => {
    // `label` is the captured element. Every write to it must be inside the
    // one function whose job is the identity.
    const body = fnBody(site, 'setNowPlaying')
    const all = [...site.matchAll(/\blabel\.(textContent|appendChild|innerHTML|replaceChildren)/g)]
    expect(all.length, 'the label is written somewhere').toBeGreaterThan(0)
    const start = site.indexOf('function setNowPlaying')
    const end = start + body.length
    const strays = all.filter((m) => (m.index ?? 0) < start || (m.index ?? 0) > end)
    expect(strays.map((m) => m[0]), 'only setNowPlaying may write the label').toEqual([])
  })

  it('setStatus cannot reach the label at all', () => {
    // The whole bug, in one assertion. If this ever fails, the two jobs
    // have been merged back into one element.
    const body = fnBody(site, 'setStatus')
    expect(body).not.toMatch(/\blabel\b/)
    expect(body).not.toContain('player-label')
    expect(body).not.toContain('setNowPlaying')
  })

  it('setStatus writes the strip, and only the strip', () => {
    const body = fnBody(site, 'setStatus')
    expect(body).toContain('statusText')
    expect(body).toContain('statusStrip')
  })

  it('there is exactly one status writer', () => {
    // A second `function setStatus`-alike is how a surface would get its
    // own message behaviour, which is the two-sheets incident in another
    // costume.
    expect(site.match(/function setStatus\(/g)?.length).toBe(1)
    // The strip's text node is reachable from exactly one function: its own
    // declaration, the null-check, and the alias taken inside setStatus.
    // A fourth reference means a second surface has started writing it.
    const refs = [...site.matchAll(/\bstatusText\b/g)]
    expect(refs.length).toBe(3)
    const declEnd = site.indexOf('\n', site.indexOf('const statusText'))
    const start = site.indexOf('function setStatus')
    const end = start + fnBody(site, 'setStatus').length
    const outside = refs.filter((m) => {
      const at = m.index ?? 0
      return at > declEnd && (at < start || at > end)
    })
    expect(outside.map((m) => m[0])).toEqual([])
  })
})

describe('the strip always leaves, and never stacks', () => {
  const body = fnBody(site, 'setStatus')

  it('clears every timer it owns before arming them again', () => {
    // Three timers: the pan, the hide and the unmount after the fade. A
    // second message must replace the first, not queue behind it and not
    // leak a handle that fires over the next one.
    for (const timer of ['statusHideTimer', 'statusPanTimer', 'statusDropTimer']) {
      expect(body, `${timer} must be cleared on entry`)
        .toContain(`window.clearTimeout(${timer})`)
    }
  })

  it('hides the strip on a timer it derives, never a hard-coded one', () => {
    // The durations belong to src/lib/player-status.ts, which is tested
    // with no DOM. A number typed here is a second source for how long a
    // member gets to read something.
    expect(body).toContain('marqueePlan(')
    expect(body).toContain('plan.totalMs')
    expect(body).not.toMatch(/setTimeout\([^,]+,\s*\d{3,}\)/)
  })

  it('empties the strip when it goes, so a stale message cannot flash', () => {
    expect(body).toContain('strip.hidden = true')
    expect(body).toContain("inner.textContent = ''")
  })

  it('respects reduced motion in both directions', () => {
    // No pan, and the message wraps instead of clipping — which is the
    // better trade anyway: zero travel AND fully readable.
    expect(body).toContain('prefersReducedMotion()')
    expect(body).toContain("classList.toggle('is-wrap', reduced)")
  })
})

describe('the name marquee only moves a line that overflows', () => {
  const body = fnBody(site, 'armNameMarquee')

  it('measures rather than guessing from the string length', () => {
    expect(body).toContain('scrollWidth')
    expect(body).toContain('clientWidth')
    expect(body).toContain('shouldMarquee(')
  })

  it('asks the pure helper about reduced motion instead of re-deciding', () => {
    // shouldMarquee() returns false at any overflow under reduced motion,
    // so the rule cannot be forgotten at one of the three call sites.
    expect(body).toContain('reducedMotion')
    expect(withoutComments(read('lib/player-status.ts')))
      .toMatch(/if \(reducedMotion\) return false/)
  })

  it('clears the previous track\'s animation before measuring the new one', () => {
    // A title that FITS must not inherit the last one's pan, and re-adding
    // a class an element already carries does not restart an animation.
    expect(body).toContain("classList.remove('is-marquee')")
    expect(body).toContain('removeProperty')
    expect(body.indexOf("classList.remove('is-marquee')"))
      .toBeLessThan(body.indexOf("classList.add('is-marquee')"))
  })

  it('re-measures when the box changes, not only when the track does', () => {
    expect(site).toContain("window.addEventListener('resize', remeasureNames)")
    expect(site).toContain('debounce(armNameMarquee')
  })

  it('loops, because the owner asked for a car stereo — and only this one does', () => {
    // The exception is declared in global-tokens.test.ts by NAME. This is
    // the other half: the animation it names actually is the looping one.
    const css = withoutComments(read('styles/global.css'))
    expect(css).toMatch(/animation: name-marquee var\(--marquee-ms, 0ms\) var\(--ease-panel\) infinite/)
    // Paused while the queue is open: a member reading twenty rows does not
    // need a line sliding underneath them, and pausing resumes where it was
    // rather than restarting.
    expect(css).toContain('body.queueopen .marquee-text.is-marquee { animation-play-state: paused; }')
  })

  it('the loop dies with the line — a hidden or fitting name never animates', () => {
    const body = fnBody(site, 'armNameMarquee')
    expect(body).toContain('if (line.hidden) continue')
    // shouldMarquee() is the only gate, and it answers false for reduced
    // motion, for a zero-width box and for anything inside the slop.
    expect(body).toContain('if (!shouldMarquee(')
  })
})

describe('the markup keeps the two jobs apart', () => {
  it('the label carries no aria-live and the strip does', () => {
    const labelTag = shell.slice(shell.indexOf('id="player-label"'))
    expect(labelTag.slice(0, labelTag.indexOf('>'))).not.toContain('aria-live')
    const stripTag = shell.slice(shell.indexOf('id="player-status"'))
    expect(stripTag.slice(0, stripTag.indexOf('>'))).toContain('aria-live="polite"')
  })

  it('the strip lives inside the persisted player node', () => {
    // Outside it a soft navigation would recreate the strip and drop the
    // element references site.ts captured once, at module load.
    const persisted = shell.slice(shell.indexOf('transition:persist="player"'))
    expect(persisted.indexOf('id="player-status"')).toBeGreaterThan(-1)
    expect(persisted.indexOf('id="player-status"'))
      .toBeLessThan(persisted.indexOf('<audio'))
  })
})
