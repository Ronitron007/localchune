// src/pages/api/welcome.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import type { APIRoute } from 'astro'

const MAX_ECHOED_VALUE_LENGTH = 100

/**
 * The claim flow's only mutation. A plain <form method="post"> from
 * /welcome, brutalist idiom — no island, no JSON. username_set() (migration
 * 17) does every real check IN THE DATABASE (format, reserved list,
 * set-once, uniqueness) with its own distinct message; this route's only
 * jobs are reading the form and turning a DB error into a redirect
 * /welcome can re-render inline — the same query-param pattern /login
 * already uses for error_description.
 *
 * No island means no JSON error contract is needed here, unlike every
 * /api/track or /api/upload route — there is no client-side fetch() to
 * parse a body, only a full-page form submit.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  // No JSON here on purpose (see the file header) — a signed-out visitor
  // posting this form by hand gets sent back to /login, the same place the
  // middleware itself would have sent a page load.
  if (!locals.member) return redirect('/login', 303)

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return redirect(`/welcome?error=${encodeURIComponent('malformed form body')}`, 303)
  }

  const raw = form.get('username')
  // Echoed back into the input's value on failure so a typo does not force
  // a full retype — capped well above the 20-char ceiling so a hand-edited
  // giant value cannot bloat the redirect URL.
  const value = typeof raw === 'string' ? raw.slice(0, MAX_ECHOED_VALUE_LENGTH) : ''

  const { error } = await locals.supabase.rpc('username_set', { p_username: value })
  if (error) {
    const qs = new URLSearchParams({ error: error.message, value })
    return redirect(`/welcome?${qs.toString()}`, 303)
  }

  // M6c Task 2: "/" is the home feed (src/pages/index.astro); the pool
  // table moved to /pool (src/pages/pool.astro). A freshly-claimed member
  // lands on the feed rather than the raw table.
  return redirect('/', 303)
}
