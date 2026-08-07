// src/pages/api/track/[id]/delete.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'
import { deleteObjectQuietly } from '../../../../lib/r2'

/**
 * The uploader deletes their own upload. Permanently.
 *
 * WHY THIS PATH AND NOT /api/upload/<id>/delete. Every route under
 * /api/upload is a step of the INGEST pipeline and keys its file off the
 * request body, not the path; /api/track/[id]/* is the family of per-file
 * actions a member takes on a track that already exists (like, play, tags,
 * download, source, art), all keyed on a file id in the path, all reached
 * from the track page. This is one of those.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE ROUTE, and it is not the obvious
 * one:
 *
 *   1. read the content-type,
 *   2. call the RPC,
 *   3. delete the object,
 *   4. answer.
 *
 * Reading the content-type FIRST is the lesson CLAUDE.md records from the
 * /merges undo bug: when ClientRouter intercepts a POST it re-sends the
 * body as multipart/form-data, the urlencoded branch is missed, and the
 * router then gives up and NAVIGATES to the POST-only action URL — a 404
 * at an /api/... path, with the side effect already committed. That shape
 * ("it looks broken but it actually happened") is bad for an undo and
 * unacceptable for a permanent delete, so the branch is decided before
 * anything is destroyed. The form also carries `data-astro-reload`, which
 * is what stops the interception in the first place; this is the belt to
 * that brace, and src/lib/astro-forms.test.ts fails the build without it.
 *
 * THE OBJECT IS DELETED AFTER THE ROW IS TOMBSTONED, never before, and the
 * failure is swallowed rather than surfaced (`deleteObjectQuietly`). The
 * two stores cannot commit together, so one order has to be chosen and
 * this is the safe one:
 *
 *   - row first, object second: a crash in between leaves a tombstone whose
 *     object still exists. Nothing serves it (every read predicate excludes
 *     'deleted' — see migration 33's audit), it costs storage, and the
 *     nightly reconcile lists 'deleted' as safe to sweep, so it is cleaned
 *     up within a day with no human involved.
 *   - object first, row second: a crash in between leaves a LIVE row whose
 *     bytes are gone. The pool shows a track that 404s on play and on
 *     download, and nothing anywhere repairs it.
 *
 * So a failed object delete must not fail the request either: the member's
 * delete really did happen, the file really is unreachable, and answering
 * 500 would invite a retry that now hits "already deleted". The reconcile
 * finishes the job.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a track id')

  // Step 1 — decide the branch BEFORE anything is destroyed. See above.
  const contentType = request.headers.get('content-type') ?? ''
  const isForm = contentType.includes('application/x-www-form-urlencoded')

  // Step 2 — the RPC does the authorisation (uploader or is_owner()), the
  // state check, the tombstone, the preferred-file re-election and the
  // track fold, in one transaction under the same advisory lock a merge
  // takes. 42501/22023/P0001/P0002 map onto 403/422/409/404 through
  // rpcError's table, which already spells every code this RPC raises.
  let outcome: Record<string, unknown> | null = null
  try {
    const { data, error } = await locals.supabase.rpc('upload_delete', { p_file_id: id })
    if (error) return rpcError(error)
    outcome = (data ?? null) as Record<string, unknown> | null
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }
  if (!outcome) return jsonError(500, 'rpc_error', 'upload_delete returned nothing')

  // Step 3 — the bytes. r2_key comes back from the RPC precisely so this
  // route never has to read the row again to find it (and could not: the
  // row is already invisible to pool_get by now).
  const r2Key = typeof outcome.r2_key === 'string' ? outcome.r2_key : null
  if (r2Key) await deleteObjectQuietly(r2Key)
  else console.error(`upload_delete: no r2_key returned for ${id}; object not reclaimed`)

  // Step 4 — answer.
  if (isForm) {
    // /uploads, NOT back to the referer. The referer is the track page,
    // and /track/<id> now 404s for everyone including the person who just
    // pressed the button — pool_get excludes the tombstone unconditionally.
    // /uploads is the one surface that deliberately still shows the row,
    // labelled "deleted", so the member lands on proof that the thing they
    // asked for actually happened instead of on an error page.
    return redirect('/uploads', 303)
  }

  return Response.json(outcome, { headers: { 'cache-control': 'private, no-store' } })
}
