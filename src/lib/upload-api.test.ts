// src/lib/upload-api.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_PART_URLS_PER_CALL, isUuid, readJsonBody, parseBatchBody, parsePresignBody,
  parsePartsBody, parseCompleteBody, parseAbortBody, parseFileIdParam,
  rpcError, loadOwnedJob,
} from './upload-api'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const ME = '99999999-9999-9999-9999-999999999999'

const json = (body: unknown) =>
  new Request('http://localhost:4321/api/upload/presign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** Records every .eq() so a test can assert the ownership filters exist. */
function fakeClient(rows: Record<string, unknown>) {
  const seen: { table: string; filters: [string, unknown][] }[] = []
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = []
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return q },
        maybeSingle: async () => {
          seen.push({ table, filters })
          return { data: rows[table] ?? null, error: null }
        },
      }
      return q
    },
  }
  return { client: client as unknown as SupabaseClient, seen }
}

describe('isUuid', () => {
  it('accepts a uuid', () => { expect(isUuid(U1)).toBe(true) })
  it('rejects anything else', () => {
    expect(isUuid('../../etc/passwd')).toBe(false)
    expect(isUuid(42)).toBe(false)
  })
})

describe('readJsonBody', () => {
  it('returns the object', async () => {
    expect(await readJsonBody(json({ a: 1 }))).toEqual({ a: 1 })
  })
  it('returns {} for a body that is not JSON', async () => {
    expect(await readJsonBody(json('not json'))).toEqual({})
  })
  it('returns {} for a JSON array — the parsers expect named fields', async () => {
    expect(await readJsonBody(json([1, 2]))).toEqual({})
  })
})

describe('parseBatchBody', () => {
  it('defaults the label to null', () => {
    expect(parseBatchBody({})).toEqual({ ok: true, value: { label: null } })
  })
  it('trims, and an all-whitespace label becomes null', () => {
    expect(parseBatchBody({ label: '  july promos  ' })).toEqual({ ok: true, value: { label: 'july promos' } })
    expect(parseBatchBody({ label: '   ' })).toEqual({ ok: true, value: { label: null } })
  })
  it('rejects an over-long label', () => {
    expect(parseBatchBody({ label: 'x'.repeat(121) }).ok).toBe(false)
  })
})

describe('parsePresignBody', () => {
  const good = {
    batch_id: U1, file_id: U2, filename: 'a.flac',
    byte_size: 40_000_000, client_duration_ms: 372_000,
  }
  it('accepts a well-formed body', () => {
    expect(parsePresignBody(good)).toEqual({
      ok: true,
      value: { batchId: U1, fileId: U2, filename: 'a.flac', byteSize: 40_000_000, clientDurationMs: 372_000 },
    })
  })
  it('accepts a null duration — a header-less VBR mp3 is not a rejection', () => {
    expect(parsePresignBody({ ...good, client_duration_ms: null }).ok).toBe(true)
  })
  it('rejects a non-uuid file_id', () => {
    expect(parsePresignBody({ ...good, file_id: 'nope' }).ok).toBe(false)
  })
  it('rejects an empty filename', () => {
    expect(parsePresignBody({ ...good, filename: '' }).ok).toBe(false)
  })
  it('rejects a zero or negative byte_size', () => {
    expect(parsePresignBody({ ...good, byte_size: 0 }).ok).toBe(false)
    expect(parsePresignBody({ ...good, byte_size: -1 }).ok).toBe(false)
  })
  it('rejects a fractional byte_size', () => {
    expect(parsePresignBody({ ...good, byte_size: 1.5 }).ok).toBe(false)
  })
})

describe('parsePartsBody', () => {
  it('accepts an inclusive 1-based range', () => {
    expect(parsePartsBody({ file_id: U1, from: 1, to: 4 }))
      .toEqual({ ok: true, value: { fileId: U1, from: 1, to: 4 } })
  })
  it('rejects part 0 — S3 part numbers are 1-based', () => {
    expect(parsePartsBody({ file_id: U1, from: 0, to: 4 }).ok).toBe(false)
  })
  it('rejects a reversed range', () => {
    expect(parsePartsBody({ file_id: U1, from: 5, to: 4 }).ok).toBe(false)
  })
  it('caps how many URLs one call can mint', () => {
    expect(parsePartsBody({ file_id: U1, from: 1, to: MAX_PART_URLS_PER_CALL }).ok).toBe(true)
    expect(parsePartsBody({ file_id: U1, from: 1, to: MAX_PART_URLS_PER_CALL + 1 }).ok).toBe(false)
  })
  it('rejects a non-uuid file_id', () => {
    expect(parsePartsBody({ file_id: 'x', from: 1, to: 2 }).ok).toBe(false)
  })
})

describe('parseCompleteBody', () => {
  it('treats an absent parts list as "ask R2 what landed"', () => {
    expect(parseCompleteBody({ file_id: U1 })).toEqual({ ok: true, value: { fileId: U1, parts: null } })
  })
  it('accepts a parts list', () => {
    expect(parseCompleteBody({ file_id: U1, parts: [{ part_number: 1, etag: '"abc"' }] }))
      .toEqual({ ok: true, value: { fileId: U1, parts: [{ partNumber: 1, etag: '"abc"' }] } })
  })
  it('rejects a part number outside 1..10000', () => {
    expect(parseCompleteBody({ file_id: U1, parts: [{ part_number: 0, etag: 'a' }] }).ok).toBe(false)
    expect(parseCompleteBody({ file_id: U1, parts: [{ part_number: 10_001, etag: 'a' }] }).ok).toBe(false)
  })
  it('rejects parts that is not an array', () => {
    expect(parseCompleteBody({ file_id: U1, parts: 'all of them' }).ok).toBe(false)
  })
})

describe('parseAbortBody', () => {
  it('supplies a default reason', () => {
    expect(parseAbortBody({ file_id: U1 })).toEqual({
      ok: true, value: { fileId: U1, reason: 'aborted by the client' },
    })
  })
  it('truncates a long reason to what ingest_jobs.last_error keeps', () => {
    const v = parseAbortBody({ file_id: U1, reason: 'x'.repeat(900) })
    expect(v.ok && v.value.reason.length).toBe(500)
  })
})

describe('parseFileIdParam', () => {
  it('reads file_id from the query string', () => {
    expect(parseFileIdParam(new URL(`http://localhost:4321/api/upload/resume?file_id=${U1}`)))
      .toEqual({ ok: true, value: U1 })
  })
  it('rejects a missing file_id', () => {
    expect(parseFileIdParam(new URL('http://localhost:4321/api/upload/resume')).ok).toBe(false)
  })
})

describe('rpcError', () => {
  it('maps 42501 to 403 forbidden', async () => {
    const res = rpcError({ code: '42501', message: 'forbidden' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'forbidden' })
  })
  it('maps P0001 — the illegal-transition raise — to 409', () => {
    expect(rpcError({ code: 'P0001', message: 'illegal transition' }).status).toBe(409)
  })
  it('maps anything unrecognised to 500', () => {
    expect(rpcError({ code: 'XX000', message: 'boom' }).status).toBe(500)
  })
})

describe('loadOwnedJob', () => {
  const job = { file_id: U1, multipart: true, part_size: 16_777_216, part_count: 3, upload_id: 'UP1' }
  const file = { id: U1, r2_key: `audio/${ME}/${U1}.flac`, state: 'uploading', container: 'flac', byte_size: 50_000_000 }

  it('filters ingest_jobs on user_id AND files on uploaded_by', async () => {
    // Not decoration. Task 2's files policy is pool-wide readable and BOTH
    // policies have an is_owner() branch, so without these filters an owner
    // could presign a PUT against another member's key.
    const { client, seen } = fakeClient({ ingest_jobs: job, files: file })
    await loadOwnedJob(client, U1, ME)
    expect(seen).toEqual([
      { table: 'ingest_jobs', filters: [['file_id', U1], ['user_id', ME]] },
      { table: 'files', filters: [['id', U1], ['uploaded_by', ME]] },
    ])
  })
  it('returns null when the job is not the caller\'s', async () => {
    const { client } = fakeClient({ ingest_jobs: null, files: file })
    expect(await loadOwnedJob(client, U1, ME)).toBeNull()
  })
  it('returns the merged row', async () => {
    const { client } = fakeClient({ ingest_jobs: job, files: file })
    expect(await loadOwnedJob(client, U1, ME)).toEqual({
      fileId: U1, r2Key: `audio/${ME}/${U1}.flac`, state: 'uploading', container: 'flac',
      byteSize: 50_000_000, multipart: true, partSize: 16_777_216, partCount: 3, uploadId: 'UP1',
    })
  })
})
