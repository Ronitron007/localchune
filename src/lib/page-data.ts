// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// PERF TASK 2.1 — the chrome stops sitting on the critical path.
//
// THE SHAPE OF THE PROBLEM. Astro renders a page's frontmatter first and its
// components second, so an `await` inside AppNav or StorageChip cannot start
// until every `await` in the page above it has finished. Two of those
// components each made a round trip:
//
//   AppNav       review_pending_count()   a number in a badge, owner only
//   StorageChip  my_storage()             one line in the footer
//
// Neither is above the fold, and both are strictly AFTER the page's own
// data. On /pool that made five sequential stages — current_member,
// pool_list, pool_uploaders, review_pending_count, my_storage — at a
// measured 60–165 ms per Supabase round trip, i.e. 300–750 ms of server
// time on every view. And because the UI is server-rendered under
// ClientRouter, EVERY sort click, filter change, search keystroke and
// pagination click paid it again.
//
// THE FIX IS ORDERING, NOT CACHING. The middleware starts both calls before
// it hands off to the page, and the components await the promise instead of
// making the call. The requests are then in flight while the page fetches
// its own data, so the cost is max(page, chrome) rather than page + chrome.
// No result is cached, nothing is stale, and every error branch survives —
// which matters, because survive-list #16 is the rule that an outage must
// never render as "you have nothing".
//
// WHY NO 60-SECOND CACHE for the review badge, which the plan floated:
// `Astro.locals` is per-request, so a cache there expires instantly and
// buys nothing. The only place with a lifetime is a module-level variable
// in the Worker isolate, which is shared between DIFFERENT MEMBERS' requests
// — one owner's pending count served to whoever the isolate handles next.
// A count is cheap; that trade is not worth making.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Member } from './session'

/** my_storage()'s row shape (migration 08). */
export type StorageRow = { occupying_bytes: number; contributed_bytes: number }

/** Exactly the two fields the callers read off a supabase-js result. Not the
 *  library's own type, because these values are also produced by hand in the
 *  non-owner branch below, where no request is made at all. */
export type RpcResult<T> = { data: T | null; error: { message: string } | null }

export type ChromeData = {
  /** StorageChip's footer line. */
  storage: RpcResult<StorageRow[]>
  /** AppNav's pending-review badge. `data: 0, error: null` for a non-owner —
   *  the request is not made, because the function already returns 0 for
   *  them and a round trip to be told so is a round trip wasted. */
  reviewPending: RpcResult<number>
}

/**
 * Start both chrome calls. Does not await them; the caller holds the promise.
 *
 * `.rpc()` resolves to `{data, error}` rather than rejecting on a PostgREST
 * or HTTP failure, which is why `Promise.all` is safe here and why each
 * result still carries its own error for its own consumer to branch on. The
 * catch is belt and braces for a genuine throw (an aborted request), and it
 * degrades to the same shape rather than taking the page down: the nav is
 * not the place to report a database outage, and the footer line is not the
 * place to report one either.
 */
export function startChromeData(sb: SupabaseClient, member: Member): Promise<ChromeData> {
  const storage = sb.rpc('my_storage') as unknown as Promise<RpcResult<StorageRow[]>>
  const reviewPending: Promise<RpcResult<number>> =
    member.role === 'owner'
      ? (sb.rpc('review_pending_count') as unknown as Promise<RpcResult<number>>)
      : Promise.resolve({ data: 0, error: null })

  return Promise.all([storage, reviewPending]).then(
    ([s, r]) => ({ storage: s, reviewPending: r }),
    (err: unknown) => ({
      storage: { data: null, error: { message: String(err) } },
      reviewPending: { data: null, error: { message: String(err) } },
    }),
  )
}

/**
 * What the two components call. The middleware has normally already started
 * this, and awaiting a settled promise costs nothing.
 *
 * The fallback exists so a component can never be the reason a page throws:
 * if a future route renders the Shell without going through the middleware's
 * page branch, the call is simply made here instead, exactly as it was
 * before this task — slower, still correct. A missing member means no
 * session, which the middleware would have redirected; render nothing.
 */
export function chromeData(locals: App.Locals): Promise<ChromeData> {
  if (locals.chrome !== undefined) return locals.chrome
  if (locals.member === null) {
    return Promise.resolve({
      storage: { data: null, error: null },
      reviewPending: { data: 0, error: null },
    })
  }
  const started = startChromeData(locals.supabase, locals.member)
  locals.chrome = started
  return started
}
