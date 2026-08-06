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

  it('defers instead, and both §5 triggers spend the same flag', () => {
    expect(restore).toContain('queueNeedsHydration = needsHydration')
    // drawer opened, and playback started.
    expect(count(/hydrateIfDeferred\(\)/g)).toBe(3) // definition + two triggers
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
