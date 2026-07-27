## Supabase

- Changes to `auth`/`supabase/config.toml` (e.g. auth hooks) require `npx supabase stop && npx supabase start` to take effect. `npx supabase db reset` only restarts containers — it does NOT reload GoTrue's auth config.

### `supabase config push` clobbers anything not in config.toml

config.toml is **authoritative** for a linked project — undeclared settings are
reset to defaults on push. We are forced to push it because the
`before_user_created` auth hook is registered there, and that hook is the
platform's entire security boundary.

Consequence: **every auth provider must be declared in config.toml.** Google is,
with `env()` substitution for its credentials. `site_url` is also `env()`-substituted
(`SUPABASE_AUTH_SITE_URL`) — unset, the push writes an empty site_url and every
production sign-in redirect falls back to it instead of the real domain. Before
any `config push`, export:

```
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET
SUPABASE_AUTH_SITE_URL
```

If the Google vars are unset, the push writes empty credentials and locks everyone out.
Verify after every push:

```
curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON" | jq .external.google
```

The app itself never needs these — Supabase does the OAuth code exchange
server-side. Only the CLI needs them, only at push time.
