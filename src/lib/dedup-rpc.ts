// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The four dedup RPCs, bound to whichever Worker's `rpc()` helper is
 * calling them.
 *
 * Both Workers already have a plain-fetch PostgREST helper with their own
 * error shape — workers/analysis/src/supabase.ts raises PostgrestError with
 * a SQLSTATE the consumer branches on, workers/maintenance/src/index.ts
 * throws a plain Error. Neither should grow a second HTTP client, and the
 * argument names and encodings below should not be written twice. So this
 * module takes the helper as an argument and owns nothing but the call
 * shapes.
 */
import type { CandidateRow, DedupDeps, ProbeFingerprint, ResolveResult, ScoredCandidate } from './dedup'

/** Whatever the calling Worker uses to POST /rest/v1/rpc/<fn>. */
export type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<T>

/** dedup_config.candidate_limit for the shipped algo_version. Passed rather
 *  than read, because dedup_candidates() clamps it anyway and one extra
 *  round trip per file to learn a number the SQL already defaults to would
 *  be a round trip spent on nothing. */
export const DEFAULT_CANDIDATE_LIMIT = 25

/**
 * 64 hex characters -> the `\x…` literal Postgres' bytea input function
 * accepts.
 *
 * PostgREST hands a JSON string to the parameter's input function verbatim,
 * and bytea_in reads bare hex as ESCAPE format — `abcd` would decode to the
 * four ASCII bytes 'a','b','c','d', not to two bytes. So the prefix is not
 * cosmetic: without it layer 0 would silently compare the wrong 32 bytes
 * and never match.
 *
 * Anything that is not exactly 64 lower-case hex characters returns null.
 * The container sends '' when it failed before hashing, and an empty bytea
 * in a UNIQUE column is the collision migration 19 exists to avoid.
 */
export function hexToBytea(hex: string | null | undefined): string | null {
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return null
  return `\\x${hex}`
}

export function makeDedupDeps(
  rpc: Rpc, candidateLimit = DEFAULT_CANDIDATE_LIMIT,
): DedupDeps {
  return {
    async probeFingerprint(fileId: string): Promise<ProbeFingerprint | null> {
      // `returns table` over PostgREST is an array, and an empty one is the
      // normal answer for a file whose analysis produced no fingerprint.
      const rows = await rpc<ProbeFingerprint[]>('dedup_probe', { p_file_id: fileId })
      return rows.length > 0 ? rows[0] : null
    },

    candidates(fileId: string, contentSha256: string | null): Promise<CandidateRow[]> {
      return rpc<CandidateRow[]>('dedup_candidates', {
        p_file_id: fileId,
        p_limit: candidateLimit,
        // THE THIRD ARGUMENT IS THE WHOLE POINT OF LAYER 0. files.
        // content_sha256 is UNIQUE and analysis_persist() leaves the SECOND
        // of two byte-identical files NULL rather than raising 23505, so no
        // two rows ever both hold the digest and a self-join finds nothing.
        // The digest has to arrive from the container's response.
        p_content_sha256: hexToBytea(contentSha256),
      })
    },

    resolve(
      fileId: string, scored: ScoredCandidate[], algo: string,
    ): Promise<ResolveResult> {
      return rpc<ResolveResult>('dedup_resolve', {
        p_file_id: fileId, p_scored: scored, p_algo: algo,
      })
    },
  }
}

export interface PendingRow {
  file_id: string
  algo_version: string
}

/** Files that finished analysis, have a usable fingerprint, and never got a
 *  track. The backstop's work list. Capped at 200 by the SQL. */
export function dedupPending(rpc: Rpc, limit: number): Promise<PendingRow[]> {
  return rpc<PendingRow[]>('dedup_pending', { p_limit: limit })
}

/** Mint one track per stored file that has none AND that the matcher can
 *  never match (no fingerprint). Returns how many it made, so a caller can
 *  loop until it returns 0.
 *
 *  Since migration 34 it no longer seeds MATCHABLE files. It used to, and
 *  because a seeded file has a track_id it then fell out of the old
 *  dedup_pending() for ever — the backstop erasing its own work list every
 *  hour for any backlog past the Worker's 300-file cap. 690 production
 *  files were stranded unexamined that way. */
export function dedupSeedTracks(rpc: Rpc, limit: number): Promise<number> {
  return rpc<number>('dedup_seed_tracks', { p_limit: limit })
}

/**
 * Stamp files.dedup_probed_at — "the matcher has examined these".
 *
 * CALLED AFTER ANY runDedup() THAT DID NOT THROW, including one that
 * returned ok:false. An ok:false is a completed examination (no
 * fingerprint, nothing to compare) and re-probing it every hour for ever
 * would block the page behind it — dedup_pending() has to terminate. A
 * THROWN effect is deliberately not marked: a database that was down has
 * not examined anything, and that file must stay queued.
 */
export function dedupMarkProbed(rpc: Rpc, fileIds: string[]): Promise<number> {
  return rpc<number>('dedup_mark_probed', { p_file_ids: fileIds })
}
