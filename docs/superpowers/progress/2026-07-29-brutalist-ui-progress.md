# Brutalist pool UI — progress

Branch: `rohan/brutalist-ui-design-091da9` (worktree). Rebased onto
`rohan/m3-analysis` @ `f49121f`. Stopped on user request before push/PR.

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

## Verification done

- `npm run check` — 0 errors (1 pre-existing hint in upload-journal.ts).
- `npm test` — 297/297.
- `npx supabase test db` — 181/181 across 14 files (incl. M3's analysis.sql).
- `worker` pytest — 93/93 (bench fixtures symlinked from the main checkout —
  `worker/bench/fixtures/*.wav` are gitignored 61 MB files).
- `npm run build` — clean.
- Signed-in HTTP checks against `npm run dev` + local Supabase (before the
  shared DB was reset by the other session): 100 SSR rows in view-source;
  only router+site scripts; one `<audio>`; empty-thumb boxes; `q=`,
  `bpm 86–86` ±half/double, `12B` harmonic wraparound, `sort=bpm_asc`,
  keyset `cursor=` page 2 (100+20 rows), empty-state messages, `—`/"no beat
  detected", detail page (chips, abstain-neutral tooltip, play link, zero
  islands), art route JSON 404 `no_art`, source/download JSON error shapes.
  `/api/build-info` answers signed out; `/` 302s to /login signed out.

## Not done yet

1. **Push + PR** — not pushed. When resuming: `git push -u origin
   rohan/brutalist-ui-design-091da9 && gh pr create --base rohan/m3-analysis …`
   (base m3-analysis, not main, or the PR shows all of M1–M3).
2. **Browser visual checklist** (plan Task 10 Step 7): dark-mode inversion,
   player bar visuals, playback-across-navigation click-through, and anything
   needing real R2 objects (streaming, downloads, thumbs as pixels). Local R2
   env vars are not set in dev, so source/download 502 locally — expected.
3. **Deploy** (plan Task 10 Step 8): `npx supabase db push && npm run deploy` —
   deliberately left for a human.
4. Spec's unresolved questions 1–3 (dark-mode-in-v1, colour thumbs, 64px
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
