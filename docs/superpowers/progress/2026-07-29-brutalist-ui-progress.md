# Brutalist pool UI — progress

Branch: `rohan/brutalist-ui-design-091da9` (worktree). Rebased onto
`rohan/m3-analysis` @ `85adb19` (the M3 final-review fix batch). Pushed;
PR not opened yet.

Plan: [`../plans/2026-07-29-06-brutalist-ui.md`](../plans/2026-07-29-06-brutalist-ui.md)
(includes the post-rebase amendment note). Spec:
[`../specs/2026-07-29-ui-brutalist-design.md`](../specs/2026-07-29-ui-brutalist-design.md).

## Status: all 10 plan tasks implemented, reviewed, committed

Each task ran as: fresh implementer subagent → independent reviewer subagent
(spec + quality verdicts). All 10 approved. Subagent briefs/reports live in
`.superpowers/sdd/` (gitignored scratch).

| Task | What | Commit |
|---|---|---|
| 1 | migration 09 (audio_analysis DDL) | superseded by M3's own 09 during rebase — dropped |
| 2 | `src/lib/track-format.ts` + tests | `feat(pool): camelot maths, bpm and quality formatting` |
| 3 | pool_tracks view + pgTAP (17) | `feat(pool): pool_tracks view, tag/filename display fallback…` |
| 4 | pool_list/pool_get/pool_uploaders + pgTAP (20) | `feat(pool): pool_list/pool_get/pool_uploaders…` |
| 5 | `src/lib/pool-api.ts` (+poolHref, no JSON route) | `feat(pool): url<->query contract and link builder…` |
| 6 | Shell, `global.css`, `site.ts`, ClientRouter, native player | `feat(shell): brutalist chrome, client router, persisted native player` |
| 7 | server-rendered pool page, 7 `.astro` templates, zero islands | `feat(pool): server-rendered table, get-form filters…` |
| 8 | `/api/track/:id/{source,download,art}` + r2 presignGet | `feat(pool): signed-get source/download/art routes…` |
| 9 | worker `make_thumb` 64px + DO drain + types | `feat(worker): 64px thumb.jpg beside artwork.jpg…` |
| 10 | track detail, upload ticker, migration for upload_batch_status | `feat(pool): track detail page, upload state ticker, failure rows` |
| — | post-rebase integration (see below) | `chore(pool): renumber m5 migrations after m3 task 9, persist thumb_key` |

## Mid-flight rebase (important)

While this branch was executing, the m3 session landed M3 Task 9 on
`rohan/m3-analysis`: its own richer `20260728110000_09_analysis.sql`
(fingerprints, `analysis_persist()` et al.), `20260729120000_10_close_acls.sql`,
its own r2 signed-GET support, and a queue consumer. This branch rebased onto
it. Resolutions:

- **migration 09**: M3's wins; this branch's minimal copy dropped.
- **M5 migrations renumbered** (as M3's 09 instructs): pool_view → `20260729130000_11`,
  pool_rpc → `20260729130100_12`, upload_status → `20260729130200_13`.
  Comment references in SQL + `src/` updated.
- **new `20260729130300_14_analysis_persist_thumb.sql`**: `analysis_persist()`
  re-created verbatim from 09 + the `thumb_key` write (3 lines). Smoke-tested:
  persist with a thumb_key payload stores it.
- **r2.ts**: kept M3's `readObjectUrl` + stricter `DERIVED_KEY_RE`; extended
  `presignGet` with response-header overrides (`contentDisposition`,
  `contentType`, `cacheControl`) and exported `GET_TTL_SECONDS` — the
  download/art routes need both.
- **tags.py / test_tags.py**: kept M3's over-cap hardening AND `make_thumb`.
- **workers/analysis**: `thumb_key` re-applied to M3's new `types.ts` +
  `index.ts` artifact-drain list (kind `'thumb'`).

## Second rebase — onto `85adb19`

M3 then landed four more commits: `739befa` (migration
`20260729120000_10_close_acls.sql` — revoke-first ACL closure on seven
tables, plus a 10-minute busy lease in `analysis_begin()`), `1fc488c` (DLQ
consumer + busy retry), `f52dd89` and `85adb19` (docs). This branch rebased
onto `85adb19`. `git rebase` reported no conflict on any of the 12 commits.

### Migration audit

- **Order.** No filename or timestamp collision. `…120000_10` sorts before
  `…130000_11`, and `supabase db reset` applies 09 → 10 → 11 → 12 → 13 → 14
  in that order.
- **Migration 14 is still correct.** Migration 10 re-creates
  `analysis_begin()` only. It does not touch `analysis_persist()`, and M3's
  edit to migration 09 in that batch is comment-only. A diff of 09's
  `analysis_persist()` body against 14's shows exactly the three intended
  `thumb_key` lines and nothing else, so 14 resurrects no older body. 14
  does not mention `analysis_begin` at all, so 10's busy lease survives.
  Confirmed in the live local DB after the reset:
  `pg_get_functiondef` for `analysis_begin` contains `busy`, and for
  `analysis_persist` contains `thumb_key`.
- **ACLs.** The pool path is unaffected by migration 10. `pool_tracks` is
  granted to no role, and `pool_list` / `pool_get` / `pool_uploaders` /
  `upload_batch_status` are all `security definer`, so they read the
  narrowed tables as the view owner. The only direct-table reads the UI
  makes as `authenticated` are `files` and `ingest_jobs`
  (`src/lib/upload-api.ts`); migration 10 re-grants `select` on both.
  `pg_class.relacl` after the reset shows `authenticated=r` on `files`,
  `ingest_jobs`, `upload_batches`, `file_claims`, `members`,
  `credit_grants`, `audio_analysis`, and no `authenticated` entry at all on
  `allowlist` or `pool_tracks`. No pgTAP regressed.

### One integration defect found and fixed

`workers/analysis/src/consumer.test.ts` builds an `AnalyzeResponse` fixture.
M3's DLQ commit rewrote that file; this branch made `thumb_key` a required
field of `AnalyzeResponse`. The two together break `astro check` with
ts(2322). Fix: add `thumb_key: null` to the fixture. Vitest never caught it
because vitest does not type-check.

## Verification done (re-run in full after the second rebase)

- `npx supabase db reset && npx supabase test db` — **189/189** across 14
  files (181 + migration 10's 8).
- `npm test` — **303/303** across 20 files.
- `npm run check` — 0 errors, 0 warnings (1 pre-existing hint in
  upload-journal.ts).
- `npm run build` — clean.
- `worker` pytest — **91 passed, 2 deselected** (`-m "not integration"`).
  The worktree has no `worker/.venv`, so the run used the main checkout's
  interpreter: `/Users/rohanmalik/localchune/worker/.venv/bin/python -m
  pytest tests/ -q -m "not integration"` from the worktree's `worker/`.
  Bench fixtures are symlinked into the worktree from the main checkout —
  `worker/bench/fixtures/*.wav` are gitignored 61 MB files.
- Signed-in HTTP checks against `npm run dev` + local Supabase (before the
  shared DB was reset by the other session): 100 SSR rows in view-source;
  only router+site scripts; one `<audio>`; empty-thumb boxes; `q=`,
  `bpm 86–86` ±half/double, `12B` harmonic wraparound, `sort=bpm_asc`,
  keyset `cursor=` page 2 (100+20 rows), empty-state messages, `—`/"no beat
  detected", detail page (chips, abstain-neutral tooltip, play link, zero
  islands), art route JSON 404 `no_art`, source/download JSON error shapes.
  `/api/build-info` answers signed out; `/` 302s to /login signed out.

## Not done yet

1. **Browser visual checklist** (plan Task 10 Step 7): dark-mode inversion,
   player bar visuals, playback-across-navigation click-through, and anything
   needing real R2 objects (streaming, downloads, thumbs as pixels). Local R2
   env vars are not set in dev, so source/download 502 locally — expected.
   The signed-in HTTP checks above were not repeated after the second
   rebase; the automated gates were.
2. **Deploy** (plan Task 10 Step 8): `npx supabase db push && npm run deploy` —
   deliberately left for a human.
3. Spec's unresolved questions 1–3 (dark-mode-in-v1, colour thumbs, 64px
   format) — plan chose the spec defaults; confirm or amend.

## Local test-login harness (for resuming verification)

The login page is Google-OAuth-only and local GoTrue has email logins
disabled, so verification used a minted session: allowlist
`pooltester@example.com` → GoTrue admin API creates the user → insert an
`auth.sessions` row + matching `auth.refresh_tokens` row → HS256 JWT signed
with the local dev secret → `@supabase/ssr` `setSession()` emits the exact
`sb-127-auth-token` cookie (script: `.superpowers/sdd/mint-session.mjs`,
gitignored). Caveats: a bogus refresh token trips GoTrue reuse-detection and
kills the session — the refresh_tokens row must be real; the local DB is
shared with the m3 session and gets reset under you (the last seed attempt
returned 0 rows for exactly that reason — re-seed before resuming).
`.env` currently points at the LOCAL stack; hosted values preserved in
`.env.hosted.bak` (both gitignored).
