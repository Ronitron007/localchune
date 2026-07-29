-- supabase/migrations/20260729130700_16b_failed_visible_to_uploader.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- Cross-task finding (Important): a `failed` file is unreachable by
-- ANYONE, including the person who uploaded it.
--
-- The chain:
--   1. analysis_fail() (migration 09) never writes an audio_analysis row --
--      there is nothing to persist about a file that could not be
--      analysed. It only flips files.state to 'failed'.
--   2. pool_tracks (migration 11, INNER JOINed to audio_analysis) therefore
--      never contains a failed file's row AT ALL -- not "hidden", not
--      "filtered", just absent from the view's output entirely.
--   3. pool_get() (migration 12) reads FROM pool_tracks. Its own-file-any-
--      state clause (`t.uploaded_by = auth.uid() or ...`) is correct and
--      exists exactly to let an uploader see their own failed/pending/
--      quarantined files -- but it can only return a row pool_tracks
--      already produced. Zero rows in, zero rows out, regardless of the
--      WHERE clause.
--   4. /track/[id].astro treats an empty pool_get() result as 404 (correct
--      general policy: unify "not yours" and "does not exist"). So a
--      failed file 404s for its own uploader.
--   5. /uploads.astro (migration 15a) already lists the failed row with its
--      last_error, but only links to /track/[id] when state = 'stored' --
--      it was written knowing the link would 404 for anything else.
--
-- The fix is entirely in the view: switch the audio_analysis join from
-- INNER to LEFT. Everything downstream (pool_get's visibility clause,
-- pool_list's `state = 'stored'` filter) already does the right thing once
-- the row exists to test.
--
-- ---- Why no other column expression needs to change ----
-- In SQL, `a.<column>` for an unmatched LEFT JOIN row is indistinguishable
-- from `a.<column>` on a MATCHED row whose column happens to be NULL --
-- and the latter was already possible before this migration (bpm can fail
-- to detect, key can fail to detect, quality_tier is nullable by its own
-- CHECK constraint). Every derived/sort-key expression below was therefore
-- ALREADY written to treat `a.<column> is null` as a first-class case, not
-- an error condition:
--   * duration_ms   -- coalesce(a.duration_ms, f.duration_ms)
--   * beat_count    -- coalesce(array_length(a.beat_grid, 1), 0)
--   * sk_bpm        -- explicit `a.bpm is null` branch -> sentinel '99999999'
--   * sk_key        -- camelot_sort's CASE on a.key_camelot ~ regex is NULL-
--                       safe (NULL !~ pattern is NULL, i.e. not true, so the
--                       ELSE 999 branch runs) -> sentinel padded '999'
--   * sk_artist     -- coalesce(d.display_artist, '~'); display_artist()
--                       itself already tolerates a NULL raw_tags argument
--                       (tag_value() returns NULL for a NULL tags jsonb)
--   * sk_duration   -- same coalesce chain as duration_ms, sentinel
--                       '99999999' when nothing is known
--   * sk_tier       -- coalesce(a.quality_tier, 0); tier is checked between
--                       1 and 5, so 9 - 0 = '9' already sorts worse than
--                       every real tier's 9 - tier ('4'..'8')
-- No new NULL case is introduced by this migration; the join type change
-- only makes the pre-existing NULL-handling paths reachable for a file
-- that has no audio_analysis row at all, instead of only for a file whose
-- row has some NULL columns. download_count/upload_count/tags (migrations
-- 15b/16) are independent of `a` entirely (left join / scalar subqueries
-- against track_stats and file_claims/file_tags) and are unaffected.
--
-- ---- Why pool_list/pool_get do NOT need DROP + CREATE ----
-- CREATE OR REPLACE VIEW only requires the output column list (names,
-- order, types) to stay the same; it does not care how a column is
-- computed. This view's SELECT list is byte-for-byte unchanged from
-- migration 16 -- only the JOIN keyword changed -- so CREATE OR REPLACE
-- VIEW applies cleanly. pool_list()/pool_get()/pool_uploaders() read the
-- exact same columns from pool_tracks as before, so their RETURNS TABLE
-- signatures are untouched and neither needs the DROP + CREATE dance
-- migrations 15b/16 required for an actual column-set change (42P13).
--
-- ---- Visibility is not widened for anyone but the uploader ----
-- pool_list() filters `t.state = 'stored'` -- a failed row still never
-- reaches it, LEFT JOIN or not. pool_get()'s gate is unchanged:
-- `t.state = any(pool_visible_states()) or t.uploaded_by = auth.uid() or
-- is_owner()` -- 'failed' is not in pool_visible_states(), so a non-
-- uploading member still gets zero rows for someone else's failed file.
-- What changes is only that the uploader-owns-it branch of that OR now has
-- a row to actually return. Proven in supabase/tests/pool_view.sql and
-- supabase/tests/pool_list.sql.
-- ============================================================
create or replace view public.pool_tracks as
select
  f.id                                       as file_id,
  f.track_id,
  f.batch_id,
  f.uploaded_by,
  split_part(m.email, '@', 1)                as uploader_name,
  f.original_filename,
  f.r2_key,
  f.container,
  f.byte_size,
  f.created_at,
  f.state,
  coalesce(a.duration_ms, f.duration_ms)     as duration_ms,
  a.bpm,
  a.ibi_std_ms,
  a.key_camelot,
  a.key_open,
  a.key_musical,
  a.key_strength,
  a.key_alt_profiles,
  a.integrated_lufs,
  a.lra_lu,
  a.true_peak_dbtp,
  a.replaygain_db,
  a.clipped_pct,
  a.quality_tier,
  a.quality_score,
  a.lossy_ancestor,
  a.meas_cutoff_hz,
  a.preview_key,
  a.peaks_key,
  a.artwork_key,
  a.thumb_key,
  a.raw_tags,
  a.analysis_version,
  a.analyzed_at,
  coalesce(array_length(a.beat_grid, 1), 0)  as beat_count,
  d.camelot_sort,
  d.display_artist,
  d.display_title,
  ((lpad((99999999999999::bigint
          - (extract(epoch from f.created_at) * 1000)::bigint)::text, 14, '0')
   ) collate "C")                            as sk_added,
  ((case when a.bpm is null or a.bpm <= 0 then '99999999'
         else lpad(((a.bpm * 100)::int)::text, 8, '0') end) collate "C")
                                             as sk_bpm,
  ((lpad(d.camelot_sort::text, 3, '0')) collate "C")
                                             as sk_key,
  ((lower(coalesce(d.display_artist, '~'))) collate "C")
                                             as sk_artist,
  ((case when coalesce(a.duration_ms, f.duration_ms, 0) <= 0 then '99999999'
         else lpad(coalesce(a.duration_ms, f.duration_ms)::text, 8, '0') end) collate "C")
                                             as sk_duration,
  (((9 - coalesce(a.quality_tier, 0))::text) collate "C")
                                             as sk_tier,
  coalesce(ts.download_count, 0)             as download_count,
  (select count(*)::int from public.file_claims c where c.file_id = f.id)
                                             as upload_count,
  ((lpad((999999999999::bigint - coalesce(ts.download_count, 0))::text, 12, '0')
   ) collate "C")                            as sk_downloads,
  coalesce(
    (select array_agg(ft.tag_display order by ft.created_at, ft.tag_key)
       from public.file_tags ft where ft.file_id = f.id),
    '{}'::text[])                            as tags
from public.files f
-- LEFT, not JOIN: analysis_fail() (migration 09) never writes a row, so a
-- failed file has no audio_analysis partner. An INNER join here made a
-- failed file invisible to pool_get() even for its own uploader -- see
-- this file's header.
left join public.audio_analysis a      on a.file_id = f.id
join public.members m                  on m.user_id  = f.uploaded_by
left join public.track_stats ts        on ts.file_id = f.id
cross join lateral (
  select
    case when a.key_camelot ~ '^([1-9]|1[0-2])[AB]$'
         then (left(a.key_camelot, length(a.key_camelot) - 1)::int) * 10
              + (case when right(a.key_camelot, 1) = 'B' then 1 else 0 end)
         else 999 end                                        as camelot_sort,
    public.display_artist(a.raw_tags, f.original_filename)    as display_artist,
    public.display_title (a.raw_tags, f.original_filename)    as display_title
) d;

revoke all on public.pool_tracks from public, anon, authenticated;

comment on view public.pool_tracks is
  'Ungranted composition unit. Reachable only from the SECURITY DEFINER
   functions pool_list/pool_get/pool_uploaders. Do NOT grant this to
   authenticated: it runs as its owner and bypasses RLS. download_count and
   upload_count added by migration 15b; tags added by migration 16.
   Migration 16b switched the audio_analysis join from INNER to LEFT so a
   `failed` file (analysis_fail() never writes an audio_analysis row) is
   still a row here -- with every analysis-derived column NULL -- instead
   of being silently absent. pool_get()''s own-uploader-any-state clause is
   what actually gates who can see it; this view only makes the row exist
   to gate.';
