// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { AwsClient } from 'aws4fetch'
import { deletablePendingObjects, reconcile, type DbFile, type R2ObjectRow } from './reconcile'

/**
 * The maintenance Worker. Two crons, no fetch handler, no route, no
 * workers.dev URL.
 *
 * This is the ONE place in the project where a Supabase service_role key is
 * legitimate. The sweeper runs at :17 past every hour with no user session,
 * so there is no cookie-bound client to act as -- and ingest_abandon_stale()
 * is granted to service_role and to nobody else, precisely so it can only be
 * called from here.
 *
 * `env` arrives as the second argument to scheduled(). It is the same object
 * `import { env } from "cloudflare:workers"` returns and is populated by
 * `wrangler secret put` identically; the argument form is used because the
 * handler receives it already typed as Env and nothing captures it in a
 * module global. There is no import.meta.env here at all -- wrangler bundles
 * this file with esbuild, not Vite, so the app's PUBLIC_ prefix rules do not
 * apply and every value below comes from the binding or the secret store.
 */
export interface Env {
  AUDIO: R2Bucket
  R2_BUCKET: string
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
  RECONCILE_DELETE_ORPHANS: string
  /** Belt-and-braces for Critical #1: delete a terminal row's surviving
   *  object when its state is failed or abandoned — never a rejected_
   *  state or quarantined; see reconcile.ts's STATES_SAFE_TO_AUTO_DELETE.
   *  Off by default for the same reason RECONCILE_DELETE_ORPHANS is: a
   *  human should see the first report or two before a cron starts
   *  erasing evidence. */
  RECONCILE_DELETE_PENDING: string
  /** Optional override, for manual verification runs only. e.g. "5 minutes". */
  SWEEP_OLDER_THAN?: string
}

// Must equal triggers.crons in wrangler.jsonc, character for character.
const CRON_SWEEP = '17 * * * *'
const CRON_RECONCILE = '40 4 * * *'

/** Every object ingest_begin() ever mints lives under this prefix. */
const KEY_PREFIX = 'audio/'

/** ingest_abandon_stale() returns at most 500 rows per call. */
const SWEEP_PAGE = 500
const SWEEP_MAX_PAGES = 10

/** PostgREST page size for the reconcile's keyset walk. */
const PGRST_PAGE = 1000

interface StaleRow {
  file_id: string
  r2_key: string
  upload_id: string | null
}

function supabaseHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'content-type': 'application/json',
  }
}

/**
 * PostgREST RPC. Deliberately plain fetch rather than @supabase/supabase-js
 * or the app's serverClient(): there is no cookie session to bind to, and
 * importing the app's client here would make it look like there are two
 * server clients in the project. There are not. This is a different Worker.
 */
async function rpc<T>(env: Env, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: supabaseHeaders(env),
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    // PGRST202 here means the schema cache has not picked the function up:
    // run `notify pgrst, 'reload schema';` against the database.
    throw new Error(`rpc ${fn}: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

function s3(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3',
  })
}

/**
 * AbortMultipartUpload. Done over the S3 API rather than the R2 binding
 * because the S3 API is what created the upload (Task 5), so the UploadId
 * needs no provenance assumptions.
 *
 * The key needs no percent-encoding -- ingest_begin() mints it from uuid
 * hex, '-', '/' and a lowercase extension. The UploadId does: it is opaque
 * base64-ish text that can contain '+', '/' and '='. aws4fetch signs the URL
 * exactly as given, so the encoding here and the canonical request agree.
 */
async function abortMultipart(env: Env, key: string, uploadId: string): Promise<void> {
  const url =
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/` +
    `${env.R2_BUCKET}/${key}?uploadId=${encodeURIComponent(uploadId)}`
  const res = await s3(env).fetch(url, { method: 'DELETE' })
  // 404 means R2 already aborted it -- the Task 1 lifecycle rule, or a
  // previous run of this sweeper. That is success, not failure.
  if (!res.ok && res.status !== 404) {
    throw new Error(`abort ${key}: ${res.status} ${await res.text()}`)
  }
}

/** The one production bucket name. Matches wrangler.jsonc's top-level
 *  `vars.R2_BUCKET` — env.dev overrides it to `localchune-audio-dev`. */
const PRODUCTION_BUCKET = 'localchune-audio'

/**
 * The stale-upload sweeper.
 *
 * ingest_abandon_stale() marks the rows 'abandoned' BEFORE returning them,
 * and that ordering is what makes the delete below safe: ingest_finalize()
 * only accepts 'uploading' or 'received' as a source state, so once a row is
 * abandoned no browser can ever bring it back to 'received' and claim the
 * object we are about to remove.
 *
 * Both R2 calls run for every swept row:
 *   - abort, if there is an UploadId. Abandoned multipart uploads BILL for
 *     their stored parts. R2's default auto-abort is 7 days; the Task 1
 *     lifecycle rule cuts it to 1; this ends it within the hour.
 *   - delete, always. A single PUT is atomic, so a stalled small upload
 *     usually leaves nothing -- but a PUT that succeeded seconds before the
 *     tab closed leaves a complete object whose row will never be finalised.
 *     DeleteObject on a key that does not exist is a no-op, so the
 *     unconditional call costs one free request and closes that leak.
 *
 * Exported for a unit test on the production-bucket guard only (Important
 * #1) — everything past that guard needs a real Supabase/R2 round trip and
 * stays covered by the manual verification run instead.
 */
export async function sweep(env: Env): Promise<void> {
  // SWEEP_OLDER_THAN exists ONLY for a manual verification run (shorten the
  // threshold, watch a handful of rows get swept). Important #1: with no
  // env.dev block, `wrangler dev` used to default straight to the
  // production bucket and the production Supabase project, so a "quick 5
  // minute test" would mark every row genuinely mid-upload as abandoned and
  // delete its object. Refuse outright rather than trust the caller to
  // remember `--env dev`.
  if (env.SWEEP_OLDER_THAN && env.R2_BUCKET === PRODUCTION_BUCKET) {
    throw new Error(
      `refusing to run: SWEEP_OLDER_THAN="${env.SWEEP_OLDER_THAN}" is set (a manual-` +
        `verification override) but R2_BUCKET is "${PRODUCTION_BUCKET}" (production). ` +
        'Run with --env dev against localchune-audio-dev instead.',
    )
  }

  const args: Record<string, unknown> = {}
  // Default is interval '24 hours', from the function signature. Only a
  // manual verification run overrides it.
  if (env.SWEEP_OLDER_THAN) args.p_older_than = env.SWEEP_OLDER_THAN

  let swept = 0
  let aborted = 0
  let deleted = 0
  let failed = 0

  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const stale = await rpc<StaleRow[]>(env, 'ingest_abandon_stale', args)
    if (stale.length === 0) break

    for (const row of stale) {
      swept++
      try {
        if (row.upload_id) {
          await abortMultipart(env, row.r2_key, row.upload_id)
          aborted++
        }
        await env.AUDIO.delete(row.r2_key)
        deleted++
      } catch (err) {
        // The row stays 'abandoned'. The lifecycle rule is the backstop and
        // tonight's reconcile will report whatever is left over.
        failed++
        console.error(`sweep: ${row.file_id} ${row.r2_key}: ${String(err)}`)
      }
    }

    if (stale.length < SWEEP_PAGE) break
  }

  console.log(
    `sweep: swept=${swept} aborted=${aborted} deleted=${deleted} failed=${failed}`,
  )
}

/**
 * Read every files row, keyset-paginated on the unique r2_key. Keyset rather
 * than offset because an offset walk over a table that is being written to
 * skips rows.
 */
async function selectFiles(env: Env): Promise<DbFile[]> {
  const out: DbFile[] = []
  let after = ''

  for (;;) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/files`)
    url.searchParams.set('select', 'r2_key,state,byte_size')
    url.searchParams.set('order', 'r2_key.asc')
    url.searchParams.set('limit', String(PGRST_PAGE))
    if (after) url.searchParams.set('r2_key', `gt.${after}`)

    const res = await fetch(url.toString(), { headers: supabaseHeaders(env) })
    if (!res.ok) throw new Error(`select files: ${res.status} ${await res.text()}`)

    // byte_size is bigint. PostgREST serialises it as a JSON number, which
    // is exact below 2^53 -- nine petabytes. Fine.
    const page = (await res.json()) as DbFile[]
    out.push(...page)
    if (page.length < PGRST_PAGE) return out
    after = page[page.length - 1].r2_key
  }
}

async function listBucket(env: Env): Promise<R2ObjectRow[]> {
  const out: R2ObjectRow[] = []
  let cursor: string | undefined

  for (;;) {
    const page = await env.AUDIO.list({ prefix: KEY_PREFIX, limit: 1000, cursor })
    for (const o of page.objects) out.push({ key: o.key, size: o.size })
    if (!page.truncated) return out
    cursor = page.cursor
  }
}

function sample<T>(items: T[], n = 20): string {
  return JSON.stringify(items.slice(0, n))
}

/**
 * The nightly reconcile.
 *
 * R2 exposes no per-prefix usage API, so the only way to know what is in the
 * bucket is to list it. What to do about each direction of drift:
 *
 *   missingObjects   -- a row claims bytes that are not there, so someone's
 *     occupancy number is a lie and, worse, M3 will fail to download the
 *     file. REPORTED, not repaired: repairing means a state transition, and
 *     the state machine has exactly one owner (migration 07). M3 should add
 *     `ingest_mark_missing(uuid) -> text`, service_role only, moving
 *     received/analysing/stored/needs_review -> failed, and this job should
 *     call it. Until then the log line is the alert.
 *
 *   sizeMismatches   -- the object exists at a different length than
 *     files.byte_size. finalize HEAD-verifies the size, so this should be
 *     impossible; if it appears, something overwrote an object. REPORTED,
 *     never auto-corrected -- silently trusting R2 would paper over the
 *     overwrite.
 *
 *   orphanObjects    -- bytes with no row. Cannot happen forwards: the row
 *     is created by ingest_begin() BEFORE the key is ever signed, so an
 *     object without a row means the row was deleted underneath it. Safe to
 *     delete, and billed until it is -- but deletion stays behind
 *     RECONCILE_DELETE_ORPHANS because in M2 nothing deletes files rows yet,
 *     so a non-zero count means something unexpected happened and a human
 *     should look before a cron erases the evidence. Flip the var to "true"
 *     when M4 owns deletion.
 *
 *   pendingDeletion  -- a terminal row (quarantined, rejected_*, failed,
 *     abandoned) whose object is still present. complete.ts and abort.ts
 *     reclaim failed|abandoned objects themselves on the request path (see
 *     r2.ts's deleteObjectQuietly), so most of these should never even reach
 *     here -- this is the safety net for whatever that delete missed.
 *     REPORTED always; auto-DELETED, but only the failed|abandoned subset,
 *     behind RECONCILE_DELETE_PENDING (see STATES_SAFE_TO_AUTO_DELETE).
 *     quarantined and rejected_* are M3-owned states and are never
 *     auto-deleted -- a count that stays high night after night there means
 *     M3's delete path is broken.
 */
async function reconcileBucket(env: Env): Promise<void> {
  const [rows, objects] = await Promise.all([selectFiles(env), listBucket(env)])
  const drift = reconcile(rows, objects)

  const bucketBytes = objects.reduce((n, o) => n + o.size, 0)
  console.log(
    `reconcile: rows=${rows.length} objects=${objects.length} bucket_bytes=${bucketBytes} ` +
      `missing=${drift.missingObjects.length} mismatch=${drift.sizeMismatches.length} ` +
      `orphan=${drift.orphanObjects.length} pending_delete=${drift.pendingDeletion.length}`,
  )

  // Log a bounded sample, never the whole list: 10k lines of console output
  // is a way to lose the one line that mattered.
  if (drift.missingObjects.length) console.error(`reconcile missing: ${sample(drift.missingObjects)}`)
  if (drift.sizeMismatches.length) console.error(`reconcile mismatch: ${sample(drift.sizeMismatches)}`)
  if (drift.orphanObjects.length) console.warn(`reconcile orphan: ${sample(drift.orphanObjects)}`)
  if (drift.pendingDeletion.length) console.log(`reconcile pending_delete: ${sample(drift.pendingDeletion)}`)

  // Wrangler vars are strings and "false" is truthy, hence the literal test.
  if (env.RECONCILE_DELETE_ORPHANS === 'true') {
    for (const o of drift.orphanObjects) {
      await env.AUDIO.delete(o.key)
      console.log(`reconcile: deleted orphan ${o.key} (${o.size} bytes)`)
    }
  }

  // Critical #1's belt-and-braces: complete.ts and abort.ts now reclaim a
  // doomed object themselves, on the request path. This is the second
  // chance for whatever they missed (the delete itself failed, or the row
  // went `failed`/`abandoned` some other way) — restricted to the two
  // states nothing else in this milestone can ever revive, never
  // rejected_*/quarantined (see STATES_SAFE_TO_AUTO_DELETE).
  if (env.RECONCILE_DELETE_PENDING === 'true') {
    for (const p of deletablePendingObjects(drift)) {
      await env.AUDIO.delete(p.key)
      console.log(`reconcile: deleted pending-deletion object ${p.key} (state=${p.state})`)
    }
  }
}

export default {
  async scheduled(controller, env, _ctx) {
    const started = Date.now()
    try {
      if (controller.cron === CRON_SWEEP) {
        await sweep(env)
      } else if (controller.cron === CRON_RECONCILE) {
        await reconcileBucket(env)
      } else {
        // wrangler.jsonc and this file have drifted. Run the sweeper: it is
        // the cheap, idempotent, time-sensitive one, and doing nothing would
        // let multipart uploads bill silently for a week.
        console.error(
          `unknown cron "${controller.cron}" — expected "${CRON_SWEEP}" or ` +
            `"${CRON_RECONCILE}"; running the sweeper`,
        )
        await sweep(env)
      }
      console.log(`cron "${controller.cron}" finished in ${Date.now() - started}ms`)
    } catch (err) {
      // Rethrow after logging so the invocation is recorded as failed. A
      // swallowed error here is a cron that reports success forever.
      console.error(`cron "${controller.cron}" failed: ${String(err)}`)
      throw err
    }
  },
} satisfies ExportedHandler<Env>
