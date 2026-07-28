// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NO_DATA_FOUND, PostgrestError, analysisBegin, analysisPersist, analysisStuck, rpc,
} from './supabase'

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_KEY: 'sb_secret_test',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(res: Response) {
  const spy = vi.fn().mockResolvedValue(res)
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('rpc', () => {
  it('posts args to /rest/v1/rpc/<fn> with the service key in both headers', async () => {
    const spy = stubFetch(Response.json('analysing'))

    await expect(analysisBegin(ENV, 'file-1')).resolves.toBe('analysing')

    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/analysis_begin')
    expect(init.method).toBe('POST')
    // PostgREST authenticates on `apikey`; `authorization` is what selects
    // the role. Sending only one of them silently downgrades to anon.
    const headers = init.headers as Record<string, string>
    expect(headers.apikey).toBe('sb_secret_test')
    expect(headers.authorization).toBe('Bearer sb_secret_test')
    expect(JSON.parse(init.body as string)).toEqual({ p_file_id: 'file-1' })
  })

  it('sends the whole AnalyzeResponse as one jsonb argument', async () => {
    const spy = stubFetch(Response.json('stored'))
    const result = { file_id: 'f', ok: true, beats: { bpm: 128 } }

    await analysisPersist(ENV, result)

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ p_result: result })
  })

  it('passes the interval and limit through to analysis_stuck', async () => {
    const spy = stubFetch(Response.json([]))

    await analysisStuck(ENV, '1 hour', 100)

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string))
      .toEqual({ p_older_than: '1 hour', p_limit: 100 })
  })

  it('surfaces the SQLSTATE so the consumer can tell P0002 from a bad minute', async () => {
    stubFetch(Response.json(
      { code: NO_DATA_FOUND, message: 'unknown file 123' }, { status: 404 }))

    const err = await analysisBegin(ENV, 'file-1').catch((e) => e)
    expect(err).toBeInstanceOf(PostgrestError)
    expect((err as PostgrestError).code).toBe(NO_DATA_FOUND)
    expect((err as PostgrestError).status).toBe(404)
  })

  it('says out loud that a 401 is the key, not a hiccup', async () => {
    // Retrying a rejected key just burns the retry budget of every message
    // in the queue. The log line has to name the cause.
    stubFetch(new Response('{"message":"Invalid API key"}', { status: 401 }))

    const err = await analysisBegin(ENV, 'file-1').catch((e) => e)
    expect((err as PostgrestError).status).toBe(401)
    expect((err as PostgrestError).message).toContain('SUPABASE_SERVICE_KEY was rejected')
  })

  it('leaves code null when the body is not JSON — that failure is in front of PostgREST', async () => {
    stubFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    const err = await analysisBegin(ENV, 'file-1').catch((e) => e)
    expect((err as PostgrestError).code).toBeNull()
    expect((err as PostgrestError).status).toBe(502)
  })

  it('fails before the fetch when the secrets are not set', async () => {
    const spy = stubFetch(Response.json('analysing'))

    await expect(rpc({ SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' }, 'analysis_begin', {}))
      .rejects.toThrow(/wrangler secret put/)
    expect(spy).not.toHaveBeenCalled()
  })
})
