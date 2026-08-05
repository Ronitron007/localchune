// src/lib/upload-progress.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * UX.12's arithmetic, with no DOM, no Solid and no engine in scope.
 *
 * Once the upload engine became a module singleton (upload-engine.ts) the
 * same numbers had to render in TWO places at once — the full queue on
 * /upload and the mini chip on every other page. Two independently-derived
 * copies of "how far along is this batch" is precisely how the
 * beforeunload/ClientRouter asymmetry that nav-guard.ts once existed to fix
 * came to exist. So the arithmetic lives here, is pure, and both viewports
 * call it.
 *
 * Pure also means testable in node without jsdom, which is the point: the
 * chip's visibility rules are the part most likely to be got subtly wrong
 * (a chip that never hides, or one that hides while bytes are still moving)
 * and the part least likely to be caught by eye.
 */

export type RowStatus =
  | 'checking' | 'skipped' | 'queued' | 'uploading'
  | 'done' | 'already' | 'failed' | 'cancelled'

/** The only three fields the aggregation reads off a queue row. */
export interface ProgressRow {
  status: RowStatus
  size: number
  loaded: number
}

export interface UploadAggregate {
  /** Rows that are not `skipped` — the denominator the user sees. */
  total: number
  /** `done` + `already`. */
  finished: number
  /** `failed` + `cancelled`. Both are retryable from /upload. */
  failed: number
  /** `queued` + `checking` — accepted, not yet transferring. */
  pending: number
  /** `uploading` — bytes actually moving right now. */
  inFlight: number
  sentBytes: number
  totalBytes: number
  /** 0-100, integer, BYTE-weighted (not file-weighted). */
  percent: number
}

/**
 * `skipped` rows are excluded from every count and from both byte totals.
 * A file rejected by preflight or the head-check never had bytes to send,
 * so counting it would permanently cap the batch below 100% and make a
 * finished batch look stuck — the same reason the /upload progress bar has
 * always filtered them out.
 */
export function aggregateUploads(rows: readonly ProgressRow[]): UploadAggregate {
  let total = 0
  let finished = 0
  let failed = 0
  let pending = 0
  let inFlight = 0
  let sentBytes = 0
  let totalBytes = 0

  for (const row of rows) {
    if (row.status === 'skipped') continue
    total += 1
    totalBytes += row.size
    sentBytes += row.loaded
    switch (row.status) {
      case 'done':
      case 'already':
        finished += 1
        break
      case 'failed':
      case 'cancelled':
        failed += 1
        break
      case 'uploading':
        inFlight += 1
        break
      default:
        pending += 1
    }
  }

  const percent = totalBytes === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((sentBytes / totalBytes) * 100)))

  return { total, finished, failed, pending, inFlight, sentBytes, totalBytes, percent }
}

/**
 * `idle` is "there is nothing to say", not "nothing has ever happened":
 * an empty queue and a queue whose every row was skipped both land here.
 */
export type ChipPhase = 'idle' | 'active' | 'done' | 'failed'

/**
 * Order matters. `active` outranks `failed` because a batch with three dead
 * files and sixty live ones is still a batch in progress — showing
 * "3 failed" while bytes are moving would read as "it stopped".
 */
export function chipPhase(agg: UploadAggregate): ChipPhase {
  if (agg.total === 0) return 'idle'
  if (agg.pending + agg.inFlight > 0) return 'active'
  if (agg.failed > 0) return 'failed'
  if (agg.finished > 0) return 'done'
  return 'idle'
}

/** The pill's whole text. "▲" is the upload glyph; "·" separates the two facts. */
export function chipText(agg: UploadAggregate, phase: ChipPhase = chipPhase(agg)): string {
  switch (phase) {
    case 'active':
      return `▲ ${agg.finished}/${agg.total} · ${agg.percent}%`
    case 'failed':
      return `▲ ${agg.failed} failed`
    case 'done':
      return '▲ done'
    default:
      return ''
  }
}

/** How long "▲ done" lingers before the chip hides itself. */
export const DONE_LINGER_MS = 6_000

/** /upload renders the real queue, so the chip would be a worse duplicate of it. */
export function isUploadPage(pathname: string): boolean {
  return pathname === '/upload' || pathname.startsWith('/upload?') || pathname.startsWith('/upload#')
}

/**
 * What a screen reader should be TOLD, as opposed to what it can go and read.
 *
 * The chip's own text changes several times a second while bytes move. Put
 * that in an aria-live region and a screen reader narrates a percentage
 * counter over the top of whatever the member is actually doing, on every
 * page in the app. So the visible pill is not a live region at all, and this
 * is: it returns '' for `active`, which is the continuous state, and speaks
 * only on the two DISCRETE transitions worth interrupting for.
 *
 * That is the same split the player bar already makes — `#player-label`
 * (track changed: discrete, aria-live) versus `#player-time` (the clock:
 * continuous, silent).
 */
export function chipAnnouncement(agg: UploadAggregate, phase: ChipPhase = chipPhase(agg)): string {
  switch (phase) {
    case 'done':
      return `Uploads finished — ${agg.finished} file${agg.finished === 1 ? '' : 's'}.`
    case 'failed':
      return `${agg.failed} upload${agg.failed === 1 ? '' : 's'} failed.`
    default:
      return ''
  }
}

export interface ChipVisibility {
  phase: ChipPhase
  pathname: string
  /** ms since `phase` last stopped being `active`. Ignored unless `done`. */
  sinceSettledMs: number
}

/**
 * `failed` is deliberately PERSISTENT where `done` is not. A finished batch
 * is information — it expires. A failed file is a task, and the chip is the
 * only thing on any other page that says so; hiding it after six seconds
 * would mean the one state worth interrupting for is the one state most
 * easily missed. It clears the moment the user acts on it, because acting
 * on it means going to /upload, where the chip is hidden anyway and the
 * retry controls are.
 */
export function chipVisible({ phase, pathname, sinceSettledMs }: ChipVisibility): boolean {
  if (isUploadPage(pathname)) return false
  switch (phase) {
    case 'active':
    case 'failed':
      return true
    case 'done':
      return sinceSettledMs < DONE_LINGER_MS
    default:
      return false
  }
}
