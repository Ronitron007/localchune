## Deploy

- Production URL: `https://localchune.butternutcrack.com`
- Deploy with `npm run deploy` (`astro build && wrangler deploy`).
- CI deploy: `gh workflow run deploy.yml --ref <branch>` (workflow_dispatch
  only). It builds with repo secrets, deploys, then fails unless
  `/api/build-info` serves the deployed sha. The migrations-first rule
  applies to this path too. After any deploy, `curl
  https://localchune.butternutcrack.com/api/build-info` answers "is the
  commit I pushed the one running?" — a merge is NOT a deploy, and prod
  once sat a full day behind main with nothing red anywhere. No lock spans
  the two deploy paths: a laptop deploy superseded a CI deploy mid-run on
  2026-07-31. Last deploy wins; check build-info when paths could race.
- If a deploy gets a 403 HTML challenge page on POST
  `.../workers/scripts/localchune/versions` from every network and auth,
  while other scripts upload fine: that is stuck server-side state on the
  script object (seen 2026-07-29, ~8 h). One `npx wrangler versions upload`
  through the alternate path cleared it, and deploys worked immediately
  after. Probe that first. Do not chase IP, token-scope, or bundle-size
  theories — all three were falsified that day.
- `wrangler.jsonc` routes the Worker via the custom-domain form (`custom_domain: true`)
  on the `butternutcrack.com` zone — Cloudflare provisions DNS and the cert.
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are Worker secrets
  (`wrangler secret put`), sourced from `.env`.
- `SUPABASE_SERVICE_KEY` and `SUPABASE_DB_PASSWORD` stay CLI-only in
  `.secrets.env` and must never be set as secrets on the **app** Worker
  (`localchune`) — it has no code path that reads them, so a copy there is
  pure attack surface. There are exactly two exceptions, and both are
  route-less Workers with `workers_dev: false`, their own secret store, and
  no user session to bind a cookie client to:
  - `localchune-maintenance` (`workers/maintenance/wrangler.jsonc`) — runs
    the stale-upload sweeper and the stuck-job cron.
  - `localchune-analysis` (`workers/analysis/wrangler.jsonc`) — the queue
    consumer writes `audio_analysis` through `analysis_persist()`.

  Neither key may ever appear in `.env`: `astro build` copies `.env` into
  `dist/server/.dev.vars`.
- **`SUPABASE_SERVICE_KEY` in `.secrets.env` is the dashboard's MASKED
  value**, not a key: `sb_secret_okMx0` followed by 26 U+00B7 middle dots.
  It has never authenticated. The deployed analysis Worker carries the
  project's **legacy `service_role` JWT** instead, read straight out of
  `npx supabase projects api-keys` and piped into `wrangler secret put`.
  The Management API returns the new-format secret key masked too, so the
  full value exists only in the Supabase dashboard. To move to the
  new-format key, reveal it there, fix `.secrets.env`, and run:
  ```
  grep '^SUPABASE_SERVICE_KEY=' .secrets.env | cut -d= -f2- \
    | npx wrangler secret put SUPABASE_SERVICE_KEY -c workers/analysis/wrangler.jsonc
  ```
- Each Worker deploys separately. `npm run deploy` deploys the app Worker
  only; `npm run deploy:maintenance` and `npm run deploy:analysis` the other
  two.
- Pool-ux and later: apply migrations BEFORE `npm run deploy` — the claim
  gate fails open (username undefined) on the old schema, and `/welcome`
  would 500 without `username_set()`.

### Hosted Supabase grants every table to `anon` and `authenticated`

A hosted project ships an `ALTER DEFAULT PRIVILEGES` that grants `anon`,
`authenticated` and `service_role` **all** privileges (`arwdDxtm`) on every
new table in `public`. A local `supabase start` does not. Compare
`pg_class.relacl` on both to see it.

The consequence is important. A `grant select ... to authenticated` line in
a migration is a **no-op in production** — the role already had everything —
so RLS becomes the only thing between a member and an `UPDATE`. RLS does
hold that line, because no policy in this project is permissive for insert,
update or delete. But the migration does not say what it means.

Migration 09 therefore **revokes first, then grants**. Do the same in every
new migration, and prove it with a pgTAP `throws_ok(..., '42501', ...)` on
an INSERT as `authenticated`.

Migration 10 closed the remaining open ACLs: `files`, `upload_batches`,
`file_claims`, `ingest_jobs` (migration 06) and `allowlist`, `credit_grants`,
`members` (migrations 01/01b) — all seven tables in the project, done. Any
**new** table added after migration 10 starts from the same open hosted
default and needs the same revoke-first treatment on day one, not as a
follow-up.

## Queues

`localchune-analyze` carries `{file_id, r2_key, analysis_version}` from the
app Worker to the analysis Worker. `localchune-analyze-dlq` catches a
message that failed five attempts.

- Producer: `/api/upload/complete`, after `ingest_finalize` commits. The send
  never throws — the bytes are already verified.
- Consumer: `localchune-analysis`, `max_batch_size: 1`. A batch retry
  re-delivers the whole batch, and each message costs ~45 vCPU-s.
- `files.state` is the system of record, never the queue. The maintenance
  Worker re-enqueues anything stale in `received` or `analysing` at :31 past
  the hour.
- Wrangler has no send command. To enqueue by hand, POST to
  `/accounts/<account>/queues/<queue_id>/messages` with the OAuth token from
  `wrangler whoami`, or deploy the maintenance Worker and let the cron do it.
- `localchune-analyze-dlq` has its own consumer on the analysis Worker
  (`workers/analysis/wrangler.jsonc`, `handleDeadLetter` in
  `src/consumer.ts`): a dead-lettered message calls `analysis_fail()` and
  acks. Confirm it is live with `wrangler queues info localchune-analyze-dlq`
  → `Consumers: 1`.
- **A deploy that touches the container image rolls out gradually, not
  atomically.** `wrangler deploy` on `workers/analysis` defaults to a
  `[10,100]` rollout — the old image keeps serving some fraction of traffic
  for **minutes** after the deploy reports SUCCESS. Poll
  `npx wrangler containers info <image>` (or the dashboard) to confirm the
  rollout actually completed before assuming a container-level fix is live,
  or pass `--containers-rollout=immediate` to skip the gradual rollout
  entirely. TS-only edits (no Dockerfile change) do not rebuild the image,
  so this only applies when `worker/Dockerfile` or its build context changed.
- `max_instances` (workers/analysis/wrangler.jsonc, container config)
  **errors when exceeded — it does not queue the excess**, and it is **not
  enforced in local dev**, so `wrangler dev` will never reproduce that
  failure. It only shows up against the real platform under real load.

### Maintenance Worker — what it is and how to deploy it

`localchune-maintenance` is a second Worker with **no routes**, so nothing on
the internet can reach it. It exists only to run two scheduled jobs:

| Cron | Job | What it does |
|---|---|---|
| `17 * * * *` (hourly) | **sweeper** | Finds uploads stuck in `pending`/`uploading` for over 24 h, marks them `abandoned`, aborts their multipart upload and deletes the partial object. **Abandoned multipart uploads bill for real** — this is the money job. |
| `31 * * * *` (hourly) | **stuck-job requeue** | Sends `localchune-analyze` a message for every file that has sat in `received` or `analysing` for over an hour. It filters `state_changed_at`, never `created_at`. This is what makes the analysis pipeline self-healing after a dead-letter or a dropped send. |
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
