// src/lib/file-state.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The one place `files.state` is translated into English. FileStateTicker
 * (the live poller on /upload) and /uploads (the permanent history) show
 * overlapping sets of the same states and must never drift into two
 * different vocabularies for the same value — a file that says "uploading"
 * on one page and something else on the other is a bug, not a style choice.
 *
 * No DOM, no fetch — safe to import from both a Solid island and an Astro
 * frontmatter.
 */

export const NON_TERMINAL_LABEL: Record<string, string> = {
  pending: 'waiting',
  uploading: 'uploading',
  received: 'uploaded — queued for analysis',
  analysing: 'being listened to…',
  stored: 'ready',
  needs_review: 'held for review',
}

export const TERMINAL_FAILED_STATES = new Set([
  'failed', 'abandoned', 'quarantined', 'rejected_duration', 'rejected_redundant',
])

/** A failure this uploader can fix by dropping the file again. */
export const RETRYABLE_STATES = new Set(['failed', 'abandoned'])

export const FAILURE_EXPLAIN: Record<string, string> = {
  failed: 'The upload did not finish.',
  abandoned: 'This upload sat unfinished for a day and was cleaned up.',
  rejected_duration: 'Longer than the 15-minute limit.',
  rejected_redundant: 'The pool already has this recording at equal or better quality.',
  quarantined: 'Held back: the file is not what its container claims to be.',
}

/** The short label for any state this app can show — terminal or not. */
export function stateLabel(state: string): string {
  return NON_TERMINAL_LABEL[state] ?? FAILURE_EXPLAIN[state] ?? state
}
