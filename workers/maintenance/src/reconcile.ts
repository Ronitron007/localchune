// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/** A row of public.files, as PostgREST returns it. */
export interface DbFile {
  r2_key: string
  state: string
  byte_size: number
}

/** One object from R2Bucket.list(). */
export interface R2ObjectRow {
  key: string
  size: number
}

export interface Drift {
  /** The row says the object is in the bucket. It is not. Accounting lies. */
  missingObjects: { key: string; state: string }[]
  /** The object is there but a different size than files.byte_size. */
  sizeMismatches: { key: string; expected: number; actual: number }[]
  /** An object in the bucket that no row knows about. Billed, unreferenced. */
  orphanObjects: { key: string; size: number }[]
  /** A terminal row whose object has not been deleted yet. Expected, briefly. */
  pendingDeletion: { key: string; state: string }[]
}

/**
 * The states in which an object is expected to exist. Must stay identical to
 * public.states_holding_bytes() in migration 06 -- if the two drift, the
 * nightly job starts reporting healthy files as missing.
 */
export const STATES_HOLDING_BYTES: readonly string[] = [
  'received',
  'analysing',
  'stored',
  'needs_review',
]

/** States in which the object may or may not exist yet. Not our problem. */
export const STATES_IN_FLIGHT: readonly string[] = ['pending', 'uploading']

/**
 * Terminal states whose surviving object is safe for THIS job to delete on
 * its own say-so, if the operator opts in (index.ts's RECONCILE_DELETE_PENDING).
 *
 * `failed` and `abandoned` are both states in which no route or RPC in this
 * milestone will ever again mint a write capability for the key — see
 * ingest_finalize()'s source-state check. `rejected_duration`,
 * `rejected_redundant` and `quarantined` are deliberately excluded: those
 * are M3-owned states where a human — not a cron — decides what happens to
 * the object (e.g. keeping a quarantined file as evidence).
 */
export const STATES_SAFE_TO_AUTO_DELETE: readonly string[] = ['failed', 'abandoned']

/**
 * Compare the table against the bucket. Pure: no I/O, no clock, no env.
 *
 * files.r2_key is UNIQUE, so a key maps to at most one row and the two maps
 * below cannot collide.
 */
export function reconcile(rows: DbFile[], objects: R2ObjectRow[]): Drift {
  const byKey = new Map<string, R2ObjectRow>()
  for (const o of objects) byKey.set(o.key, o)

  const known = new Set<string>()
  const drift: Drift = {
    missingObjects: [],
    sizeMismatches: [],
    orphanObjects: [],
    pendingDeletion: [],
  }

  for (const r of rows) {
    known.add(r.r2_key)
    const found = byKey.get(r.r2_key)

    if (STATES_IN_FLIGHT.includes(r.state)) continue

    if (STATES_HOLDING_BYTES.includes(r.state)) {
      if (!found) {
        drift.missingObjects.push({ key: r.r2_key, state: r.state })
      } else if (found.size !== r.byte_size) {
        drift.sizeMismatches.push({
          key: r.r2_key,
          expected: r.byte_size,
          actual: found.size,
        })
      }
      continue
    }

    // Terminal: failed, abandoned, rejected_*, quarantined. The object
    // should be gone. If it is still there, say so -- but this is not
    // corruption, it is a delete that has not happened yet.
    if (found) drift.pendingDeletion.push({ key: r.r2_key, state: r.state })
  }

  for (const o of objects) {
    if (!known.has(o.key)) drift.orphanObjects.push({ key: o.key, size: o.size })
  }

  return drift
}

/**
 * The subset of `drift.pendingDeletion` this job is allowed to delete
 * automatically. Pure and separate from `reconcile()` so it stays testable
 * without an env or a binding — index.ts calls this and then decides,
 * behind its own flag, whether to actually issue the deletes.
 */
export function deletablePendingObjects(drift: Drift): { key: string; state: string }[] {
  return drift.pendingDeletion.filter((p) => STATES_SAFE_TO_AUTO_DELETE.includes(p.state))
}
