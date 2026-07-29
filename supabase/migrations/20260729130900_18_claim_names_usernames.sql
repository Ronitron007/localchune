-- supabase/migrations/20260729130900_18_claim_names_usernames.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M3 pool-UX Task 8, fold-in from Task 7's review -- pool_get()'s
-- claim_names lateral was written before migration 17 (usernames) existed
-- and still hard-codes `split_part(m2.email, '@', 1)`. Migration 17 already
-- swapped the SAME fallback for uploader_name (via pool_tracks); this
-- migration is the one spot the review found still showing an email local
-- part once a contributor has claimed a username.
--
-- CREATE OR REPLACE FUNCTION, not DROP + CREATE: only the claim_names
-- expression inside the body changes -- the RETURNS TABLE column list is
-- byte-for-byte the one migration 16 last established (file_tags' `tags`
-- column was the last append), so this is not the 42P13 "cannot change
-- return type of existing function" case migrations 15b/16/17 document.
-- Every other column and the visibility WHERE clause are unchanged.
-- ============================================================
create or replace function public.pool_get(p_file_id uuid)
returns table (
  file_id           uuid,
  track_id          uuid,
  uploaded_by       uuid,
  uploader_name     text,
  original_filename text,
  r2_key            text,
  display_artist    text,
  display_title     text,
  container         text,
  byte_size         bigint,
  state             text,
  duration_ms       int,
  bpm               real,
  ibi_std_ms        real,
  beat_count        int,
  key_camelot       text,
  key_open          text,
  key_musical       text,
  key_strength      real,
  key_alt_profiles  jsonb,
  integrated_lufs   real,
  lra_lu            real,
  true_peak_dbtp    real,
  replaygain_db     real,
  clipped_pct       real,
  quality_tier      smallint,
  quality_score     real,
  lossy_ancestor    text,
  meas_cutoff_hz    int,
  preview_key       text,
  peaks_key         text,
  artwork_key       text,
  thumb_key         text,
  raw_tags          jsonb,
  analysis_version  text,
  analyzed_at       timestamptz,
  batch_id          uuid,
  batch_label       text,
  claim_names       text[],
  created_at        timestamptz,
  download_count    bigint,
  upload_count      int,
  tags              text[]
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select t.file_id, t.track_id, t.uploaded_by, t.uploader_name,
         t.original_filename, t.r2_key, t.display_artist, t.display_title,
         t.container, t.byte_size, t.state, t.duration_ms,
         t.bpm, t.ibi_std_ms, t.beat_count,
         t.key_camelot, t.key_open, t.key_musical, t.key_strength, t.key_alt_profiles,
         t.integrated_lufs, t.lra_lu, t.true_peak_dbtp, t.replaygain_db, t.clipped_pct,
         t.quality_tier, t.quality_score, t.lossy_ancestor, t.meas_cutoff_hz,
         t.preview_key, t.peaks_key, t.artwork_key, t.thumb_key,
         t.raw_tags, t.analysis_version, t.analyzed_at,
         t.batch_id, ub.label, cl.claim_names, t.created_at,
         t.download_count, t.upload_count, t.tags
    from public.pool_tracks t
    left join public.upload_batches ub on ub.id = t.batch_id
    cross join lateral (
      -- The fix: prefer the claimant's claimed username, exactly the
      -- fallback expression migration 17 already uses for uploader_name
      -- (via pool_tracks). Order by email is unchanged -- it is a stable
      -- tiebreak key independent of what the name displays as.
      select coalesce(
               array_agg(coalesce(m2.username, split_part(m2.email, '@', 1))
                         order by m2.email),
               '{}'::text[]) as claim_names
        from public.file_claims c
        join public.members m2 on m2.user_id = c.user_id
       where c.file_id = t.file_id
    ) cl
   where t.file_id = p_file_id
     and ( t.state = any (public.pool_visible_states())
           or t.uploaded_by = (select auth.uid())
           or public.is_owner() );
end $$;

revoke execute on function public.pool_get(uuid) from public, anon;
grant  execute on function public.pool_get(uuid) to authenticated;

comment on function public.pool_get(uuid) is
  'One track, everything about it. Migration 15b appended download_count
   and upload_count; migration 16 appended tags. Migration 18 swapped
   claim_names to prefer each contributor''s claimed username, falling back
   to the email local part exactly as uploader_name already does (migration
   17) -- every column and the visibility WHERE clause are otherwise
   unchanged from migration 16.';
