// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The four service_role RPCs from migration 09, over plain fetch.
 *
 * This is the SECOND legitimate holder of a Supabase service_role key in the
 * project, and it is the same exception as the first: like the maintenance
 * Worker, this one is route-less with `workers_dev: false`, is driven by a
 * queue rather than by a request, and therefore has no user session to bind
 * a cookie client to. `analysis_begin`, `analysis_persist`, `analysis_fail`
 * and `analysis_stuck` are granted to service_role and to nobody else,
 * precisely so they can only be called from here and from the maintenance
 * Worker's cron.
 *
 * Plain fetch rather than @supabase/supabase-js for the reason the
 * maintenance Worker gives: there is no session to manage, and importing the
 * app's serverClient() would suggest there is one server client in the
 * project when there are none — these are different Workers.
 */

export interface SupabaseEnv {
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
}

/**
 * A PostgREST error, with the two fields the consumer branches on.
 *
 * `code` is the Postgres SQLSTATE the function raised, which is what makes
 * the difference between "this file no longer exists, stop retrying" (P0002)
 * and "the database is having a bad minute, retry" (anything else).
 * PostgREST maps SQLSTATE to HTTP as well, but the mapping is lossy — 400
 * covers both a raise_exception and a malformed request — so the code is the
 * thing to test.
 */
export class PostgrestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'PostgrestError'
  }
}

/** SQLSTATE for "unknown file" — raised by analysis_begin and analysis_persist. */
export const NO_DATA_FOUND = 'P0002'
/** SQLSTATE for an illegal state transition — raised by ingest_set_state. */
export const ILLEGAL_TRANSITION = 'P0001'

export async function rpc<T>(
  env: SupabaseEnv,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new PostgrestError(
      `rpc ${fn}: SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set as secrets ` +
        'on this Worker (npx wrangler secret put NAME -c workers/analysis/wrangler.jsonc)',
      0, null,
    )
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  })

  if (res.ok) return (await res.json()) as T

  const body = await res.text()
  let code: string | null = null
  try {
    code = (JSON.parse(body) as { code?: string }).code ?? null
  } catch {
    // A non-JSON body means the failure came from in front of PostgREST —
    // the API gateway rejecting the key, or a proxy. Leave code null; the
    // caller will treat it as retryable, which is right for both.
  }

  // 401 is the one failure worth naming in the log. It is never transient
  // and never fixes itself: the key is wrong, revoked, or belongs to another
  // project, and every message in the queue will fail identically until a
  // human replaces it.
  const hint = res.status === 401
    ? ' — SUPABASE_SERVICE_KEY was rejected by the API gateway; it must be replaced, not retried'
    : ''
  throw new PostgrestError(`rpc ${fn}: ${res.status} ${body}${hint}`, res.status, code)
}

/**
 * Claim the file. Returns its state AFTER the call; only 'analysing' means
 * "carry on". See migration 09.
 */
export function analysisBegin(env: SupabaseEnv, fileId: string): Promise<string> {
  return rpc<string>(env, 'analysis_begin', { p_file_id: fileId })
}

/** Store the whole AnalyzeResponse. Idempotent on file_id. Returns 'stored'. */
export function analysisPersist(env: SupabaseEnv, result: unknown): Promise<string> {
  return rpc<string>(env, 'analysis_persist', { p_result: result })
}

/** Terminal failure. Returns 'failed'. */
export function analysisFail(env: SupabaseEnv, fileId: string, reason: string): Promise<string> {
  return rpc<string>(env, 'analysis_fail', { p_file_id: fileId, p_reason: reason })
}

export interface StuckRow {
  file_id: string
  r2_key: string
  state: string
}

/** Rows whose STATE went stale — state_changed_at, never created_at. */
export function analysisStuck(
  env: SupabaseEnv,
  olderThan: string,
  limit: number,
): Promise<StuckRow[]> {
  return rpc<StuckRow[]>(env, 'analysis_stuck', {
    p_older_than: olderThan,
    p_limit: limit,
  })
}
