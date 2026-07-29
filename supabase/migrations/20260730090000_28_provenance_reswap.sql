-- supabase/migrations/20260730090000_28_provenance_reswap.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- Repairs a parallel-branch collision. Migration 20 (150000_provenance,
-- UX.10) swapped `raw_tags jsonb` for `provenance jsonb` in pool_get —
-- closing the raw-tags leak (embedded tags carry buyer-identity atoms:
-- apID/account_id, ownr, xid). Migrations 26/27 (M6a, developed in
-- parallel before 20 existed in that branch's tree) recreated pool_get
-- from the pre-20 definition and gave crate_get the same column list —
-- silently REOPENING the leak and dropping the provenance column the
-- deployed app reads.
--
-- This migration re-applies migration 20's swap on top of 26/27: both
-- functions keep their full 26/27 column lists, with `raw_tags jsonb`
-- replaced by `provenance jsonb` at the same position, projected through
-- provenance_from_tags() (migration 20; definer-reachable only). Nothing
-- else changes. DROP + CREATE per the 42P13 rule (15b precedent).
-- ============================================================

drop function if exists public.pool_get(uuid);

create function public.pool_get(p_file_id uuid)
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
  provenance        jsonb,
  analysis_version  text,
  analyzed_at       timestamptz,
  batch_id          uuid,
  batch_label       text,
  claim_names       text[],
  created_at        timestamptz,
  download_count    bigint,
  upload_count      int,
  tags              text[],
  like_count        int,
  liked_by_me       boolean,
  play_count        int
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
         public.provenance_from_tags(t.raw_tags), t.analysis_version, t.analyzed_at,
         t.batch_id, ub.label, cl.claim_names, t.created_at,
         t.download_count, t.upload_count, t.tags,
         t.like_count, t.liked_by_me, t.play_count
    from public.pool_tracks t
    left join public.upload_batches ub on ub.id = t.batch_id
    cross join lateral (
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
  'One row for the track page. Migration 26''s column list with migration
   20''s raw_tags->provenance swap re-applied (migration 28): raw embedded
   tags never leave the database; provenance_from_tags() projects the six
   allowlisted values.';

drop function if exists public.crate_get(uuid);

create function public.crate_get(p_crate uuid)
returns table (
  "position"        int,
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
  provenance        jsonb,
  analysis_version  text,
  analyzed_at       timestamptz,
  batch_id          uuid,
  batch_label       text,
  claim_names       text[],
  created_at        timestamptz,
  download_count    bigint,
  upload_count      int,
  tags              text[],
  like_count        int,
  liked_by_me       boolean,
  play_count        int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.crates cr
     where cr.id = p_crate
       and (cr.owner_id = auth.uid() or cr.is_public)
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select ci.position,
         t.file_id, t.track_id, t.uploaded_by, t.uploader_name,
         t.original_filename, t.r2_key, t.display_artist, t.display_title,
         t.container, t.byte_size, t.state, t.duration_ms,
         t.bpm, t.ibi_std_ms, t.beat_count,
         t.key_camelot, t.key_open, t.key_musical, t.key_strength, t.key_alt_profiles,
         t.integrated_lufs, t.lra_lu, t.true_peak_dbtp, t.replaygain_db, t.clipped_pct,
         t.quality_tier, t.quality_score, t.lossy_ancestor, t.meas_cutoff_hz,
         t.preview_key, t.peaks_key, t.artwork_key, t.thumb_key,
         public.provenance_from_tags(t.raw_tags), t.analysis_version, t.analyzed_at,
         t.batch_id, ub.label, cl.claim_names, t.created_at,
         t.download_count, t.upload_count, t.tags,
         t.like_count, t.liked_by_me, t.play_count
    from public.crate_items ci
    join public.pool_tracks t on t.file_id = ci.file_id
    left join public.upload_batches ub on ub.id = t.batch_id
    cross join lateral (
      select coalesce(
               array_agg(coalesce(m2.username, split_part(m2.email, '@', 1))
                         order by m2.email),
               '{}'::text[]) as claim_names
        from public.file_claims c
        join public.members m2 on m2.user_id = c.user_id
       where c.file_id = t.file_id
    ) cl
   where ci.crate_id = p_crate
     and t.state = any (public.pool_visible_states())
   order by ci.position;
end $$;

revoke execute on function public.crate_get(uuid) from public, anon;
grant  execute on function public.crate_get(uuid) to authenticated;

comment on function public.crate_get(uuid) is
  'A crate''s items, ordered by position: `position` followed by pool_get''s
   entire column list (migration 28 parity — provenance, never raw_tags).
   42501 unless the caller owns the crate or it is public. Filters to
   pool_visible_states(), the same gate pool_get applies.';
