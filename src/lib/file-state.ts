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

/**
 * A failure this uploader can fix by dropping the file again.
 *
 * 'deleted' is deliberately NOT here. It is not a failure and there is
 * nothing to retry — the member asked for it, and offering "try again"
 * beside it would read as an invitation to undo something that cannot be
 * undone. Dropping the same file again is an ordinary new upload, which
 * the dropzone already handles.
 */
export const RETRYABLE_STATES = new Set(['failed', 'abandoned'])

export const FAILURE_EXPLAIN: Record<string, string> = {
  failed: 'The upload did not finish.',
  abandoned: 'This upload sat unfinished for a day and was cleaned up.',
  rejected_duration: 'Longer than the 15-minute limit.',
  rejected_redundant: 'The pool already has this recording at equal or better quality.',
  quarantined: 'Held back: the file is not what its container claims to be.',
  // Migration 33. NOT a failure, and the wording says so: this is the one
  // terminal state the member chose. my_files() keeps returning the row on
  // purpose (it is the only surface that still shows it) so /uploads can
  // account for a file that used to be in the pool and no longer is —
  // silently dropping it would look like data loss.
  deleted: 'You deleted this upload. The file is gone for everyone.',
}

/** The short label for any state this app can show — terminal or not. */
export function stateLabel(state: string): string {
  return NON_TERMINAL_LABEL[state] ?? FAILURE_EXPLAIN[state] ?? state
}

/**
 * ingest_jobs.last_error, translated for members.
 *
 * The incident that forced this: 29 preallocated-but-incomplete FLACs
 * sailed through preflight, uploaded in full, and died in the analysis
 * container. /uploads then showed the owner the raw failure —
 * `CalledProcessError: ffprobe … Invalid data found when processing input`
 * — and the owner could not tell whose fault it was. A raw traceback names
 * the tool, never the cause, and reads as "the site is broken" when the
 * truth was "your file is broken".
 *
 * So: members see one plain sentence from this mapper; the verbatim string
 * moves into a title tooltip (uploads.astro, track/[id].astro) where it
 * stays available for debugging without being the message. Patterns are
 * matched against what actually writes last_error today — worker/app/
 * main.py's `{type(e).__name__}: {e} | stderr: …` strings, consumer.ts's
 * fixed dead-letter reason, and complete.ts's own `complete: …` sentences.
 * Order matters: "Invalid data found" is ffmpeg-family stderr and is the
 * diagnosis, so it wins over which binary happened to surface it.
 */
export function explainLastError(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const t = raw.trim()
  if (t === '') return null
  const has = (needle: string) => t.toLowerCase().includes(needle)
  if (has('invalid data found')) return 'The audio file is corrupt or incomplete.'
  if (has('calledprocesserror') && has('ffprobe')) return 'The audio file is corrupt or incomplete.'
  if (has('calledprocesserror') && has('fpcalc')) {
    return 'The audio could not be fingerprinted — the file may be damaged.'
  }
  if (has('jsondecodeerror')) {
    return 'Analysis hit a tag-parsing fault. The team knows; the file will be retried.'
  }
  if (has('dead-lettered after 5 attempts')) return 'Analysis failed after several attempts.'
  // complete.ts's own upload-phase reasons ("no object at the key",
  // "size mismatch — declared X, object Y"): these are not analysis
  // failures, and saying "Analysis failed." for them would be a lie.
  if (t.startsWith('complete: ')) return 'The upload never fully arrived in storage.'
  // abort.ts records the client's own transfer failure (uploader.ts's
  // TransferError messages) as the reason. Also upload-phase, also never
  // "Analysis failed." — the markers below are that module's closed set.
  if (
    has('r2 returned') || has('network error') || has('timed out') ||
    has('presigned') || has('resum') || has('this upload expired') || has('cors')
  ) {
    return 'The upload was interrupted.'
  }
  // Never the raw text. A member cannot act on a traceback, and the
  // verbatim string is one hover away in the tooltip.
  return 'Analysis failed.'
}

/**
 * Mirrors SQL `pool_visible_states()` (migration 06) exactly: the states in
 * which a file's ORIGINAL object is guaranteed to still be in R2.
 * `bump_download()` (migration 15b) already refuses (P0002) outside this
 * set — the download/source routes check it too, BEFORE presigning, so a
 * request this route would reject never reaches R2 to 302 into a raw
 * NoSuchKey page, and never reaches bump_download to have its refusal
 * silently swallowed inside `waitUntil`.
 */
export const POOL_VISIBLE_STATES = new Set(['received', 'analysing', 'stored', 'needs_review'])
