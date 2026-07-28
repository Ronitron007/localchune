## Deploy

- Production URL: `https://localchune.butternutcrack.com`
- Deploy with `npm run deploy` (`astro build && wrangler deploy`).
- `wrangler.jsonc` routes the Worker via the custom-domain form (`custom_domain: true`)
  on the `butternutcrack.com` zone — Cloudflare provisions DNS and the cert.
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are Worker secrets
  (`wrangler secret put`), sourced from `.env`.
- `SUPABASE_SERVICE_KEY` and `SUPABASE_DB_PASSWORD` stay CLI-only in
  `.secrets.env` and must never be set as secrets on the **app** Worker
  (`localchune`) — it has no code path that reads them, so a copy there is
  pure attack surface. The one exception is the route-less maintenance
  Worker (`localchune-maintenance`, `workers/maintenance/wrangler.jsonc`),
  which has its own secret store and needs `SUPABASE_SERVICE_KEY` to run the
  stale-upload sweeper with no user session. Neither key may ever appear in
  `.env`: `astro build` copies `.env` into `dist/server/.dev.vars`.
- The maintenance Worker deploys separately: `npm run deploy:maintenance`.
  `npm run deploy` deploys the app Worker only.

### Maintenance Worker — what it is and how to deploy it

`localchune-maintenance` is a second Worker with **no routes**, so nothing on
the internet can reach it. It exists only to run two scheduled jobs:

| Cron | Job | What it does |
|---|---|---|
| `17 * * * *` (hourly) | **sweeper** | Finds uploads stuck in `pending`/`uploading` for over 24 h, marks them `abandoned`, aborts their multipart upload and deletes the partial object. **Abandoned multipart uploads bill for real** — this is the money job. |
| `40 4 * * *` (nightly) | **reconcile** | Compares what is in R2 against what the database says. Reports drift in both directions: an object with no row, and a row with no object. |

It needs its own secrets — a separate store from the app Worker. Set all five
against **its** config file, not the app's:

```
npx wrangler secret put SUPABASE_URL          -c workers/maintenance/wrangler.jsonc
npx wrangler secret put SUPABASE_SERVICE_KEY  -c workers/maintenance/wrangler.jsonc
npx wrangler secret put R2_ACCOUNT_ID         -c workers/maintenance/wrangler.jsonc
npx wrangler secret put R2_ACCESS_KEY_ID      -c workers/maintenance/wrangler.jsonc
npx wrangler secret put R2_SECRET_ACCESS_KEY  -c workers/maintenance/wrangler.jsonc
```

Then `npm run deploy:maintenance`, and watch the first run with
`npx wrangler tail localchune-maintenance --format pretty`.

**Never set `SWEEP_OLDER_THAN` against production.** It exists for manual
verification and shortens the 24 h window; pointed at production it would mark
every in-flight upload abandoned and delete it. `sweep()` refuses to run when
that variable is set and the bucket is `localchune-audio`, but do not rely on
the guard — use `--env dev`.
- The Supabase redirect allow-list (`additional_redirect_urls` in
  `supabase/config.toml`) must contain the production callback
  `https://localchune.butternutcrack.com/auth/callback`, or sign-in silently
  falls back to `site_url`.

## R2 bucket config

Neither of these is deploy-time config — nothing in `wrangler deploy` applies
them. They live in the repo only so they can be replayed and diffed; the
owner runs the commands by hand against the real buckets.

- CORS (`r2-cors.dev.json` / `r2-cors.prod.json`, one rule set per bucket —
  the allowed origin differs):
  ```
  npx wrangler r2 bucket cors set localchune-audio      --file r2-cors.prod.json
  npx wrangler r2 bucket cors set localchune-audio-dev  --file r2-cors.dev.json
  npx wrangler r2 bucket cors list localchune-audio
  npx wrangler r2 bucket cors list localchune-audio-dev
  ```
- Lifecycle (`r2-lifecycle.json` — one file for both buckets, the 1-day
  `AbortIncompleteMultipartUpload` backstop is identical either way; see the
  maintenance Worker's hourly sweeper for the primary mechanism):
  ```
  npx wrangler r2 bucket lifecycle set localchune-audio      --file r2-lifecycle.json
  npx wrangler r2 bucket lifecycle set localchune-audio-dev  --file r2-lifecycle.json
  npx wrangler r2 bucket lifecycle list localchune-audio
  ```
  Expected: one rule, `abortMultipartUploadsTransition` after 1 day, on
  every prefix.

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
