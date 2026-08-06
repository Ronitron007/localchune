// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// The server-side OAuth start (perf task 2.3). The route is mocked at the
// supabase.server boundary, which is the honest seam: everything below it
// is @supabase/ssr's, and everything above it is the four decisions this
// route actually makes — the provider, the exact redirect_to, the 302, and
// what happens when the provider is misconfigured.
//
// The FIFTH thing it must do is not visible in a status code: keep PKCE
// alive. `skipBrowserRedirect` is what makes signInWithOAuth write the
// `-code-verifier` cookie through the server client's adapter without
// trying to touch `window`; without it the call would either throw on the
// server or hand back a URL with no verifier stored, and
// auth/callback.ts's exchangeCodeForSession() would fail on every sign-in.
// That is asserted below by argument, because there is no other way to see
// it from outside.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signInWithOAuth = vi.fn()
const serverClient = vi.fn()

vi.mock('../../lib/supabase.server', () => ({
  serverClient: (...args: unknown[]) => {
    serverClient(...args)
    const written = args[2] as ((h: Record<string, string>) => void) | undefined
    // Stand in for @supabase/ssr writing the code-verifier cookie: the real
    // adapter calls this back with its no-store headers whenever it does.
    written?.({ 'cache-control': 'private, no-cache, no-store, max-age=0' })
    return { auth: { signInWithOAuth } }
  },
  withAuthCookieHeaders: (response: Response, headers: Record<string, string> | undefined) => {
    if (headers) for (const [k, v] of Object.entries(headers)) response.headers.set(k, v)
    return response
  },
}))

const { GET } = await import('./start')

/** Astro's own `redirect` helper, near enough for a route that only ever
 *  redirects: a Response with a Location and no body. */
const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } })

function call(origin = 'https://localchune.butternutcrack.com'): Promise<Response> {
  const url = new URL(`${origin}/auth/start`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GET as any)({
    cookies: {},
    request: new Request(url),
    redirect,
    url,
  }) as Promise<Response>
}

beforeEach(() => {
  signInWithOAuth.mockReset()
  serverClient.mockReset()
})

describe('GET /auth/start', () => {
  it('302s to the URL Supabase hands back', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: 'https://p.supabase.co/auth/v1/authorize?x=1' }, error: null })
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://p.supabase.co/auth/v1/authorize?x=1')
  })

  it('asks for google, and for the exact production callback', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: 'https://p/authorize' }, error: null })
    await call()
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'https://localchune.butternutcrack.com/auth/callback',
        skipBrowserRedirect: true,
      },
    })
  })

  it('follows the request origin, so localhost still signs in', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: 'https://p/authorize' }, error: null })
    await call('http://localhost:4321')
    expect(signInWithOAuth.mock.calls[0][0].options.redirectTo)
      .toBe('http://localhost:4321/auth/callback')
  })

  it('carries the no-store headers the cookie write demands', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: 'https://p/authorize' }, error: null })
    const res = await call()
    // A response that sets a session-bearing cookie must never be cached by
    // an intermediary — supabase.server.ts states the rule and this route
    // is a new place it has to hold.
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('names no secret in the Location — the anon key is not one, and is not there either', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: 'https://p/authorize?provider=google' }, error: null })
    const res = await call()
    expect(res.headers.get('location')).not.toMatch(/service_role|apikey=|secret/i)
  })

  it('sends a misconfigured provider back to /login with something to read', async () => {
    signInWithOAuth.mockResolvedValue({ data: null, error: { message: 'provider is not enabled' } })
    const res = await call()
    expect(res.headers.get('location'))
      .toBe('/login?error_description=provider%20is%20not%20enabled')
  })

  it('treats a missing URL as a failure rather than redirecting to nowhere', async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: null })
    const res = await call()
    expect(res.headers.get('location')).toMatch(/^\/login\?error_description=/)
  })
})
