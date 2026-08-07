// src/pages/api/crate/[id]/download.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'
import { getObjectStream, r2ErrorResponse } from '../../../../lib/r2'
import { dbErrorResponse, isUuid, jsonError, rpcError } from '../../../../lib/upload-api'
import {
  archiveDisposition, MISSING_MANIFEST_NAME, missingManifest, planCrateZip,
  type CrateZipEntry, type CrateZipRow,
} from '../../../../lib/crate-zip'
import { zipStream, type ZipEntrySource } from '../../../../lib/zip'

/**
 * "Download the whole crate as a folder."
 *
 * A browser cannot be handed a folder, so it is handed the one thing that
 * unpacks INTO a folder: a ZIP named after the crate, holding the crate's
 * tracks in crate order. That is the honest translation of the ask, and it
 * needs no client software.
 *
 * THE ARCHIVE IS BUILT WHILE IT IS SENT. Nothing is staged in R2 and
 * nothing is buffered in the Worker — `zipStream` pulls one object at a
 * time and the bytes go straight to the socket, so the response starts in
 * milliseconds and a 6 GiB crate costs the same memory as a 6 MB one. This
 * is the one route that carries file bytes instead of signing a URL and
 * stepping aside (see getObjectStream's comment): a single response built
 * from many objects cannot be expressed as a redirect.
 *
 * NO CONTENT-LENGTH, DELIBERATELY. The exact length IS computable for a
 * store-method archive — but only if every declared byte_size matches R2
 * exactly and no object turns out to be missing, and neither is knowable
 * without HEADing all of them first. A Content-Length that proves wrong
 * mid-transfer is a corrupt download; a chunked response merely costs the
 * browser its percentage, and it still shows bytes and cancel.
 *
 * AUTHORIZATION IS crate_get's, NOT A NEW POLICY. Owner always, plus
 * anyone for a public crate — the rule migration 27 wrote and every other
 * crate surface already obeys. This route invents nothing: 42501 from the
 * RPC and a crate absent from crate_list() both become the SAME 404, so a
 * probing visitor cannot tell "no such crate" from "exists, not yours".
 * crate_get also filters to pool_visible_states(), which is what keeps a
 * tombstoned (migration 33) or quarantined file out of the archive without
 * this file knowing those rules exist.
 */

/** A one-shot stream over bytes already in memory (the manifest entry). */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Opens each planned entry against R2, in order, as the writer asks for it.
 *
 * A track whose object cannot be read is SKIPPED and recorded, never
 * fatal — one reclaimed object must not cost the user the other
 * twenty-four. The record becomes a text entry at the end of the archive,
 * which is the only place a note survives the download. This is safe
 * because the miss is detected BEFORE the entry's local header is written:
 * once bytes are flowing, a failure has no recovery and `zipChunks` errors
 * the stream instead, so the browser reports a failed download rather than
 * saving a silently corrupt archive.
 */
async function* crateSources(
  entries: CrateZipEntry[],
  missing: { name: string; reason: string }[],
): AsyncGenerator<ZipEntrySource> {
  for (const entry of entries) {
    let object: { body: ReadableStream<Uint8Array>; size: number } | null = null
    try {
      object = await getObjectStream(entry.r2Key)
    } catch (e) {
      console.error('crate download: could not open', entry.r2Key, e instanceof Error ? e.message : String(e))
      missing.push({ name: entry.name, reason: 'storage did not answer for this file' })
      continue
    }
    if (!object) {
      missing.push({ name: entry.name, reason: 'the audio is no longer in storage' })
      continue
    }
    yield { name: entry.name, size: object.size, body: object.body }
  }

  if (missing.length > 0) {
    const note = new TextEncoder().encode(missingManifest(missing))
    yield { name: MISSING_MANIFEST_NAME, size: note.length, body: bytesStream(note) }
  }
}

export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.member) return jsonError(401, 'unauthenticated', 'sign in again')
  const id = params.id
  if (!isUuid(id)) return jsonError(400, 'bad_request', 'not a crate id')

  // The same pair /crate/[id].astro calls, for the same reason: crate_get
  // carries the tracks but no crate metadata, and the archive is named
  // after the crate. One round trip, not two stages.
  let rows: CrateZipRow[]
  let crateName: string
  try {
    const rpc = locals.supabase.rpc.bind(locals.supabase)
    const [list, get] = await Promise.all([
      rpc('crate_list'),
      rpc('crate_get', { p_crate: id }),
    ])
    if (get.error) {
      if (get.error.code === '42501') return jsonError(404, 'not_found', 'no such crate')
      return rpcError(get.error)
    }
    if (list.error) {
      if (list.error.code === '42501') return jsonError(404, 'not_found', 'no such crate')
      return rpcError(list.error)
    }
    const meta = ((list.data ?? []) as { id: string; name: string }[]).find((c) => c.id === id)
    if (!meta) return jsonError(404, 'not_found', 'no such crate')
    crateName = meta.name
    rows = (get.data ?? []) as CrateZipRow[]
  } catch (e) {
    return dbErrorResponse(e instanceof Error ? e.message : String(e))
  }

  const plan = planCrateZip(rows, crateName)
  if (!plan.ok) {
    // 409 for "there is nothing to send", 413 for "this is more than one
    // download may carry" — the second is a size answer and deserves to
    // read as one.
    return jsonError(plan.code === 'empty_crate' ? 409 : 413, plan.code, plan.message)
  }

  // Counted at SERVE time, not at completion, exactly as the single-track
  // route counts when it mints the signed URL. A download that the browser
  // cancels at 99% is still a track that left the pool, and neither route
  // can observe the difference anyway. One RPC with an array rather than N
  // round trips (migration 36); waitUntil so a stats failure can never
  // delay the first byte of the archive.
  const bump = locals.supabase
    .rpc('bump_downloads', { p_files: plan.entries.map((e) => e.fileId) })
    .then(
      ({ error }: { error: { message: string } | null }) => {
        if (error) console.error('bump_downloads failed:', error.message)
      },
      (e: unknown) => {
        console.error('bump_downloads failed:', e instanceof Error ? e.message : String(e))
      },
    ) as Promise<unknown>
  locals.cfContext?.waitUntil(bump)

  try {
    const missing: { name: string; reason: string }[] = []
    return new Response(zipStream(crateSources(plan.entries, missing)), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': archiveDisposition(plan.archiveName),
        // A crate's contents are visibility-dependent per member and change
        // the moment the owner reorders it. Never a shared cache.
        'cache-control': 'private, no-store',
        // Nothing downstream may sniff or re-encode an archive mid-flight.
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (e) {
    return r2ErrorResponse(e)
  }
}
