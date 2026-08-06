// src/scripts/queue-wiring.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// SOURCE-LEVEL GUARDS ON THE ONE PIECE OF THIS MILESTONE THAT CANNOT BE
// UNIT-TESTED.
//
// vitest here runs `environment: 'node'`: site.ts touches `document` at module
// scope, so it cannot even be imported, let alone driven. Every DECISION it
// makes was extracted into queue-view.ts and is tested there. What is left is
// WIRING — and the wiring has one failure mode bad enough to deserve a test
// that reads the source, exactly as astro-forms.test.ts reads .astro markup
// and queue-store.test.ts reads its own module's imports:
//
//   `reduce` resolves SKIP / TRACK_ENDED / TRACK_FAILED / SELECT_QUEUE_ENTRY /
//   REMOVE_QUEUE_ENTRY against an index into THE ARRAY THE DRAWER RENDERED —
//   which includes the auto tail, and the auto tail is not in QueueState. Hand
//   it a stale or re-derived array and the wrong track plays. No exception, no
//   log line, no failing test anywhere: just the wrong song.
//
// The defence is structural — one variable, one writer, every dispatch site
// passing that variable — and structure is exactly what a source scan can
// check. These assertions are cheap and they fail loudly the first time
// someone adds a second array "just for this one handler".
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SITE = new URL('./site.ts', import.meta.url).pathname
const source = readFileSync(SITE, 'utf8')

/** Source with block and line comments removed — every assertion below is
 *  about CODE, and this file's own prose quotes the very identifiers it
 *  forbids. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

const count = (re: RegExp): number => (code.match(re) ?? []).length

describe('one queue engine, one rendered array', () => {
  it('calls the reducer in exactly one place', () => {
    // "There is exactly one module that decides what the queue array
    // contains… No second code path builds a play order." A second
    // `reduce(...)` call site is how that stops being true.
    expect(count(/\breduce\(/g)).toBe(1)
  })

  it('assigns `renderedQueue` in exactly one place', () => {
    const writes = count(/\brenderedQueue\s*=[^=]/g)
    expect(writes).toBe(1)
  })

  it('writes `renderedQueue` only inside setRenderedQueue', () => {
    const fn = code.slice(code.indexOf('function setRenderedQueue'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toMatch(/renderedQueue\s*=[^=]/)
  })

  // Every event that carries an index must carry THE array, by reference.
  // A literal, a `.slice()`, a freshly assembled array or a variable with
  // another name are all ways to reintroduce the stale-index bug.
  it.each(['SKIP', 'TRACK_ENDED', 'TRACK_FAILED', 'SELECT_QUEUE_ENTRY', 'REMOVE_QUEUE_ENTRY'])(
    'dispatches %s with `queue: renderedQueue` wherever it dispatches it at all',
    (type) => {
      const dispatches = [...code.matchAll(new RegExp(`type:\\s*'${type}'([^}]*)\\}`, 'g'))]
      for (const [, rest] of dispatches) {
        expect(rest).toContain('queue: renderedQueue')
      }
    },
  )

  it('never re-derives an array at a dispatch site', () => {
    expect(code).not.toMatch(/queue:\s*assembleQueue\(/)
    expect(code).not.toMatch(/queue:\s*renderedQueue\.slice\(/)
    expect(code).not.toMatch(/queue:\s*\[/)
  })
})

describe('a play is a play — §2.2', () => {
  // The meter used to be re-armed in the play-link handler alone, so an
  // autoplayed track could never reach the 30 s threshold and never counted.
  // Moving it to the shared start path is the whole fix; keeping it there is
  // what this asserts.
  it('re-arms the play meter in exactly one place', () => {
    expect(count(/playMeter\.reset\(\)/g)).toBe(1)
  })

  it('re-arms it in startCurrent — the path EVERY advance takes', () => {
    const fn = code.slice(code.indexOf('async function startCurrent'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('playMeter.reset()')
  })
})

describe('the replace prompt', () => {
  // §1.5: confirm() blocks, so it must run before the transport is claimed
  // and before any fetch — a cancel has to leave the state byte-for-byte
  // unchanged. Textual order in the handler is the only check available
  // here, and it is a real one: `apply` is what mutates the store.
  it('asks before it applies, in both replacing handlers', () => {
    const guards = [...code.matchAll(/requiresClearConfirm\(/g)].map((m) => m.index ?? 0)
    expect(guards.length).toBe(2)
    for (const at of guards) {
      const after = code.slice(at)
      const toApply = after.indexOf('apply(event)')
      const toConfirm = after.indexOf('window.confirm(')
      expect(toConfirm).toBeGreaterThan(-1)
      expect(toApply).toBeGreaterThan(toConfirm)
    }
  })

  it('uses the native confirm, never an inline handler attribute', () => {
    // Cloudflare's API WAF challenges a Worker upload whose bundle contains
    // an inline handler; the deploy POST 403s with an HTML challenge page.
    expect(code).toContain('window.confirm(')
    expect(code).not.toMatch(/\bonclick\s*=/)
  })
})

describe('the crate route projects once, and only on the server', () => {
  // The bug this prevents, found by driving the real drawer: the route runs
  // `toCrateTrack` server-side, so the wire shape is already a QueueRowData —
  // `{file_id, artist, title, ...}`. site.ts ran the projection a SECOND time
  // over those rows, read `display_title` off an object carrying `title`, and
  // queued six crate entries with blank names. No exception, no failing test:
  // just a drawer full of empty rows.
  it('never imports the projection into the client', () => {
    expect(code).not.toMatch(/import\s*\{[^}]*\btoCrateTrack\b[^}]*\}/)
    expect(code).not.toMatch(/\btoCrateTrack\s*\(/)
  })

  it('fetches the crate exactly once per crate, cached across clicks', () => {
    const fn = code.slice(code.indexOf('function loadCrateTracks'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('crateTracksCache.get(crateId)')
    expect(body).toContain('crateTracksCache.set(crateId')
    // A rejected promise must not stay cached, or one dropped connection
    // makes the button dead for the life of the document.
    expect(body).toContain('crateTracksCache.delete(crateId)')
  })
})

describe('Media Session is decoration, never a dependency', () => {
  it('never touches navigator.mediaSession without a feature check', () => {
    // Absent in some older WebKit contexts. Every read goes through the two
    // guarded accessors; a bare `navigator.mediaSession.` anywhere else would
    // throw on those browsers and take the transport with it.
    const reads = [...code.matchAll(/navigator[^\n]*\.mediaSession/g)]
    expect(reads.length).toBe(2)
    for (const [text] of reads) expect(text).toContain('as MediaNavigator')
  })

  it('unsets previoustrack explicitly rather than leaving it unmentioned', () => {
    // There is no PREV event in v1. A null handler is what greys the button
    // out; omitting the call would leave whatever a previous page registered.
    expect(code).toMatch(/set\('previoustrack',\s*null\)/)
  })

  it('wraps every setActionHandler call, which throws on an unknown action', () => {
    const direct = [...code.matchAll(/\.setActionHandler\(/g)]
    expect(direct.length).toBe(1) // the one inside the guarded `set` helper
  })
})

describe('UX.9 resume restores layer 1 and hydrates nothing', () => {
  const restore = (() => {
    const at = code.indexOf('function restoreQueue')
    return code.slice(at, code.indexOf('\n}', at) + 2)
  })()

  it('assembles the restored queue with an EMPTY tail', () => {
    // §5: the auto tail is not persisted and not recomputed at page load. A
    // 14-day-old harmonic tail is stale, and recomputing it on first paint
    // would put a pool_list call in front of every returning member.
    expect(restore).toContain('assembleQueue(restored, [])')
  })

  it('issues no regeneration of its own', () => {
    expect(restore).not.toContain('hydrateTail')
    expect(restore).not.toContain('regenerate(')
  })

  it('never claims the transport — a click must still beat a restore', () => {
    expect(restore).not.toContain('currentFileId =')
  })

  it('defers instead, and every §5 trigger spends the same flag', () => {
    expect(restore).toContain('queueNeedsHydration = needsHydration')
    // Definition + drawer opened + startCurrent. The `play` EVENT is the third
    // trigger and is registered by reference (`'play', hydrateIfDeferred`), so
    // it is asserted separately below rather than counted here.
    expect(count(/hydrateIfDeferred\(\)/g)).toBe(3)
  })

  it('spends it on the `play` EVENT too, not just on the paths that cause one', () => {
    // A RESUMED track is started by pressing ▶ on something already loaded, so
    // `startCurrent` never runs and the other trigger never fires. Without this
    // listener a returning member with an autoplay method gets no layer 2 at
    // all, and the track they pressed play on is the last one that plays.
    expect(code).toMatch(/addEventListener\('play',\s*hydrateIfDeferred\)/)
  })
})

describe('the resumed track becomes the engine\'s current — the reported bug', () => {
  // Three symptoms, one fact: `current` was null while <audio> held a track.
  // The drawer said "Nothing playing." over audible audio, `ended` reduced to
  // nothing so autoplay never advanced, and every skip path was guarded on
  // `current` and inert. The restore path is the only place in the client that
  // puts a track into the transport without telling the engine.
  const restorePlayer = (() => {
    const at = code.indexOf('async function restorePlayer')
    return code.slice(at, code.indexOf('\nvoid restorePlayer', at))
  })()

  it('dispatches RESTORE_CURRENT from the restore path', () => {
    expect(restorePlayer).toMatch(/type:\s*'RESTORE_CURRENT'/)
  })

  it('does it AFTER the claim re-check — a click still beats a restore', () => {
    const recheck = restorePlayer.lastIndexOf('if (currentFileId !== null) return')
    const dispatch = restorePlayer.indexOf("type: 'RESTORE_CURRENT'")
    expect(recheck).toBeGreaterThan(-1)
    expect(dispatch).toBeGreaterThan(recheck)
  })

  it('hydrates nothing — a restore is neither of §5\'s two triggers', () => {
    // The zero-requests-at-load invariant covers this path exactly as it covers
    // restoreQueue: `apply`'s second argument is what keeps the regeneration off
    // a returning member's first paint.
    expect(restorePlayer).toMatch(/apply\(\{\s*type:\s*'RESTORE_CURRENT'[\s\S]*?\},\s*false\)/)
    expect(restorePlayer).not.toContain('hydrateTail')
  })

  it('still routes through the one reducer call', () => {
    // Asserted globally above; restated here because the temptation on a
    // restore path is to set the store directly and skip the engine.
    expect(restorePlayer).not.toContain('setState(')
  })
})

describe('SKIP has exactly one dispatch site', () => {
  // The ⏭ button and the lock screen's next control are two surfaces for one
  // behaviour. Two dispatch sites is how they drift — and the lock-screen one
  // was already carrying a `current === null` guard that made it inert on a
  // resumed session, which is precisely the kind of divergence that hides in a
  // duplicated handler.
  it('dispatches SKIP from one place only', () => {
    expect(count(/type:\s*'SKIP'/g)).toBe(1)
  })

  it('and that place is skipToNext', () => {
    const fn = code.slice(code.indexOf('function skipToNext'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain("handleAdvance({ type: 'SKIP', queue: renderedQueue })")
  })

  it('is what the media session calls, by reference rather than by copy', () => {
    expect(code).toMatch(/set\('nexttrack',\s*skipToNext\)/)
  })

  it('is what the on-page ⏭ button calls', () => {
    expect(code).toMatch(/nextBtn\.addEventListener\('click',\s*skipToNext\)/)
  })

  it('unhides that button, which ships `hidden` for the no-JS case', () => {
    expect(code).toMatch(/nextBtn\.hidden\s*=\s*false/)
  })
})

describe('the player bar\'s ♥ and title link', () => {
  // Both controls are written by site.ts and neither can be unit-tested: the
  // module touches `document` at load. The three DECISIONS were extracted to
  // track-format.ts and are tested there; what is left is wiring, and the
  // wiring has two failure modes worth a source scan.

  it('adds no like logic of its own — one delegation, one toggleLike call', () => {
    // The bar reuses the row's contract exactly (form.likeform >
    // button.likebtn[data-file-id] > .likeglyph + .likecount). A second
    // toggleLike call site would mean the bar grew a private code path, and
    // the two would drift on rollback, on error reporting, or on both.
    expect(count(/toggleLike\(/g)).toBe(1)
    expect(count(/form\.likeform/g)).toBe(1)
  })

  it('writes the bar\'s ♥ from exactly two places, and names them', () => {
    // A track START (the server's answer, arriving on the /source response)
    // and the queue running dry. Everything else — the optimistic flip, the
    // rollback, the server confirmation — belongs to the shared delegation,
    // which reaches this button through the same selector it uses for the
    // rows. A third caller is how the bar starts disagreeing with itself.
    expect(count(/setPlayerLike\(/g)).toBe(4) // definition + start + exhausted + restore
    const start = code.slice(code.indexOf('async function startCurrent'))
    expect(start.slice(0, start.indexOf('\n}') + 2)).toContain('setPlayerLike(')
  })

  it('routes every status message through setStatus, never a raw textContent', () => {
    // #player-label holds the title link now. `label.textContent = …`
    // DETACHES that anchor, so a stray write outside the two helpers would
    // silently delete the link and never put it back. The helpers are the
    // only place that may touch it.
    const helpers = code.slice(code.indexOf('function setStatus'), code.indexOf('function setPlayerLike'))
    const strays = [...code.matchAll(/label\.textContent\s*=/g)]
      .filter((m) => (m.index ?? 0) < code.indexOf('function setStatus')
        || (m.index ?? 0) > code.indexOf('function setPlayerLike'))
    expect(helpers).toContain('label.textContent')
    expect(strays).toEqual([])
  })

  it('never renders a dead link — an href and the unhide happen together', () => {
    const fn = code.slice(code.indexOf('function setNowPlaying'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    // The null-id branch returns BEFORE either, leaving plain text.
    expect(body.indexOf('link.href')).toBeLessThan(body.indexOf('link.hidden = false'))
    expect(body).toContain('fileId === null')
  })
})

describe('the resumed track\'s like state costs no request', () => {
  const restorePlayer = (() => {
    const at = code.indexOf('async function restorePlayer')
    return code.slice(at, code.indexOf('\nvoid restorePlayer', at))
  })()

  it('reads the ♥ off the /source response the restore already made', () => {
    // §1.6's zero-requests-at-load invariant, applied to a new field rather
    // than relaxed for it. This path has always fetched /source at load —
    // `audio.preload` is "none", so the clock and scrubber need a real src
    // and an explicit load() to show anything. The like columns ride along
    // on that response; a fetch of their own here would be the regression.
    expect(restorePlayer).toContain('setPlayerLike(')
    // ONE fetch on this path, the same one it always made.
    expect([...restorePlayer.matchAll(/fetch\(/g)].length).toBe(1)
    expect(restorePlayer).toContain('/source')
  })

  it('invents no endpoint of its own to ask "is this liked"', () => {
    // The whole design in one line: pool_get already returns like_count and
    // liked_by_me on the row /source presigns from, so the answer rides on a
    // response the client was making anyway. A GET for like state — here or
    // anywhere in the client — is the thing this feature exists not to do.
    // POSTing to /like is the toggle, and is expected.
    const gets = [...code.matchAll(/fetch\(`\/api\/track\/\$\{[^}]+\}\/(\w+)`/g)].map((m) => m[1])
    expect(gets).not.toContain('likes')
    expect(gets).not.toContain('like')
  })
})

describe('the default method costs nothing', () => {
  // §1.6: a member who never opens the drawer must issue zero queue-related
  // requests. The engine short-circuits before the port for `off`, so the
  // only way to break this from here is to call the candidate fetch directly.
  it('reaches the candidate source only through the injected port', () => {
    expect(count(/fetchCandidates\(/g)).toBe(1)
    const fn = code.slice(code.indexOf('const candidatePort'))
    expect(fn.slice(0, fn.indexOf('\n}') + 2)).toContain('fetchCandidates(')
  })

  it('passes that port to regenerate rather than a second implementation', () => {
    expect(code).toMatch(/regenerate\(getState\(\),\s*candidatePort\)/)
  })
})

describe('a row is the play control — the whole row, not a glyph', () => {
  // OWNER, 2026-08-06: "list rows lose the play button — whole-row tap
  // plays, matching the queue drawer's grammar." The drawer has worked
  // that way since M6b (`.queuerow-play` spans the row); the pool table,
  // the feed and the crate page each shipped a 14x18px glyph instead.
  //
  // THE SELECTOR CONTRACT DID NOT MOVE, and that is what these assert.
  // The play link still carries every attribute site.ts scrapes to build
  // a queue (survive-list #7); the row merely gained a way to reach it.
  // A rework that moved those attributes onto the row would have rewritten
  // scrapeRows, playLinkFor and scrapeOne — three functions whose failure
  // mode is a queue of nameless entries, which the crate route has already
  // paid for once.
  it('still resolves the play link by its own class and data attribute', () => {
    expect(code).toContain('a.play[data-track-id]')
  })

  it('resolves a tap anywhere in the row to that same link', () => {
    const at = code.indexOf('function playLinkFromTap')
    expect(at, 'the resolution lives in one named function').toBeGreaterThan(-1)
    const fn = code.slice(at, code.indexOf('\n}', at) + 2)
    expect(fn).toContain('a.play[data-track-id]')
    expect(fn).toContain('data-play-row')
  })

  it('lets an inner control win its own tap', () => {
    // The heart, the queue-add, the three-dot, the title and artist links,
    // the download link, the crate picker. Without this the row would
    // swallow every one of them and a member could never open a track
    // page from a list.
    const at = code.indexOf('const ROW_TAP_EXEMPT')
    expect(at, 'the exempt list is one named constant').toBeGreaterThan(-1)
    const line = code.slice(at, code.indexOf('\n', at))
    for (const tag of ['a', 'button', 'input', 'select', 'label', 'summary']) {
      expect(line).toMatch(new RegExp(`(^|[^-\\w])${tag}([^-\\w]|$)`))
    }
  })
})
