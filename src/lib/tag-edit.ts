// src/lib/tag-edit.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE TAG EDITOR'S RULES, mirrored from `tag_add` (migration 16) so the
// optimistic chip and the row the server actually writes are the same
// thing.
//
// Optimistic UI is a PROMISE ABOUT THE SERVER'S ANSWER. Paint a chip that
// says "Peak  Time" when the server will store "Peak Time", or paint a
// 21st chip the server will refuse, and the page tells the member
// something untrue and then silently corrects itself — which is worse than
// a page reload, because a reload is at least honest.
//
// So every rule below is `tag_add`'s, restated:
//
//   display   btrim(regexp_replace(tag, '\s+', ' ', 'g'))
//   empty     22023 'tag must not be empty'
//   length    > 32 -> 22023 'tag must be at most 32 characters'
//   key       lower(display)
//   dedupe    on conflict (file_id, tag_key) do nothing — a repeat is a
//             NO-OP, not an error
//   cap       20, and counted ONLY when the key is new (so re-adding an
//             existing tag on a full file still succeeds)
//
// No DOM and no fetch: src/scripts/site.ts owns the delegation and the
// chip, org-api.ts owns the request. Same split as crate-picker.ts.

/** `tag_add`'s own limit, and the `maxlength` on the page's input. */
export const TAG_MAX_LEN = 32

/** `tag_add`'s per-file cap. */
export const TAG_CAP = 20

/**
 * Postgres's `btrim(regexp_replace(p_tag, '\s+', ' ', 'g'))`, in JS.
 *
 * `\s` in both engines covers space, tab, newline, CR and form feed; the
 * JS class also covers Unicode spaces, which is a SUPERSET and therefore
 * safe in exactly one direction — this may normalise a U+00A0 that
 * Postgres would keep, so the optimistic chip could differ from the stored
 * display text for a tag typed with a non-breaking space. The server's
 * answer wins on the next page load, and no request is lost. The
 * alternative (matching Postgres's ASCII-only class exactly) would leave a
 * pasted non-breaking space in the chip, which looks like a rendering
 * fault to the one member who does it.
 */
export function normalizeTag(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * `lower(v_display)`. Postgres's `lower()` is collation-aware and JS's
 * `toLowerCase()` is Unicode default-case-folding — they agree on ASCII
 * and on every case this app has seen. The key is used HERE only to
 * decide whether a chip already exists, so a disagreement costs a
 * redundant request that `on conflict do nothing` absorbs, never a wrong
 * write.
 */
export function tagKey(display: string): string {
  return display.toLowerCase()
}

export type TagAddPlan =
  /** Paint a new chip, then POST. */
  | { ok: true; action: 'add'; display: string; key: string }
  /** Already on the file: POST nothing, say so. `tag_add` would no-op. */
  | { ok: true; action: 'duplicate'; display: string; key: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'cap' }

/**
 * What the client should do with what a member typed, decided before
 * anything is painted or sent.
 *
 * `existing` is the tags already on the file, in display form — which is
 * what the DOM has. Keys are derived here rather than asked for, so the
 * caller cannot pass a list keyed by a different rule.
 *
 * ORDER MATTERS AND MIRRORS THE RPC: empty, then length, then duplicate,
 * then the cap. The cap is checked LAST and only for a NEW key, because
 * `tag_add` counts rows only when the key is new — so re-adding an
 * existing tag to a file that already holds 20 succeeds, and a client that
 * checked the cap first would refuse a request the server would have
 * accepted.
 */
export function planTagAdd(raw: string, existing: readonly string[]): TagAddPlan {
  const display = normalizeTag(raw)
  if (display === '') return { ok: false, reason: 'empty' }
  if (display.length > TAG_MAX_LEN) return { ok: false, reason: 'too-long' }

  const key = tagKey(display)
  const keys = new Set(existing.map((t) => tagKey(normalizeTag(t))))
  if (keys.has(key)) return { ok: true, action: 'duplicate', display, key }
  if (keys.size >= TAG_CAP) return { ok: false, reason: 'cap' }
  return { ok: true, action: 'add', display, key }
}

/** What the status region says. One place, so the three refusals read alike. */
export function tagRefusalMessage(reason: 'empty' | 'too-long' | 'cap'): string {
  switch (reason) {
    case 'empty':
      return 'Type a tag first.'
    case 'too-long':
      return `A tag is at most ${TAG_MAX_LEN} characters.`
    case 'cap':
      return `A track can carry ${TAG_CAP} tags. Remove one first.`
  }
}

export const tagAddedMessage = (display: string): string => `added ${display}`
export const tagDuplicateMessage = (display: string): string => `${display} is already on this track`
export const tagRemovedMessage = (display: string): string => `removed ${display}`
export const tagAddFailedMessage = (display: string): string => `Could not add ${display}.`
export const tagRemoveFailedMessage = (display: string): string => `Could not remove ${display}.`
