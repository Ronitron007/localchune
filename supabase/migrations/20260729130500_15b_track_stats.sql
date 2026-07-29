-- supabase/migrations/20260729130500_15b_track_stats.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M3 pool-UX Task 4 -- owner's verbatim ask: "maintain a download count and
-- an upload count for each track ID, which is agnostic of the format...
-- only related to the track ID or the fingerprint."
--
-- Two different mechanisms for two different numbers:
--
-- 1. download_count is a NEW counter (nothing else could tell you this) --
--    track_stats below, bumped by bump_download() on every signed-GET.
-- 2. upload_count is NOT a new counter. file_claims (migration 06) already
--    records "who contributed this file", one row per member, including the
--    original uploader's own claim written by ingest_finalize() -- adding a
--    second number here would be a second source of truth for the same
--    fact. It is exposed below as a live count(*), never stored.
--
-- FORMAT-AGNOSTIC BY DESIGN, NOT YET BY DATA: both key on file_id today
-- because the canonical track identity (files.track_id) does not exist
-- until M4. CARRY TO M4: the merge operation must fold download_count (sum)
-- and claims onto the surviving identity, inside the same reversible merge
-- event -- counts belong to the track, not the encode. Recorded in the plan
-- (docs/superpowers/plans/2026-07-29-07-pool-ux.md, Task 4) as the thing
-- M4's own plan PR must carry forward.
--
-- Migrations 11 (pool_view) and 12 (pool_rpc) are already applied on
-- hosted and must never be edited -- see migration 10's numbering-note
-- precedent for the same rule. pool_tracks is CREATE OR REPLACEd here
-- (Postgres allows a view's column list to grow via CREATE OR REPLACE VIEW,
-- checked empirically against local Postgres before relying on it).
--
-- pool_list/pool_get do NOT get the same treatment: CREATE OR REPLACE
-- FUNCTION on a RETURNS TABLE(...) function refuses ANY change to the
-- column list, including a pure append -- "cannot change return type of
-- existing function" (42P13), checked empirically the same way. Both are
-- therefore DROPped and recreated here instead. Neither is referenced by
-- any other database object (both are leaf RPC endpoints PostgREST calls
-- directly), so the drop is safe -- no cascade.
-- ============================================================

-- ---- the new counter ----
create table public.track_stats (
  file_id        uuid primary key references public.files(id) on delete cascade,
  download_count bigint not null default 0
);
alter table public.track_stats enable row level security;

comment on table public.track_stats is
  'One row per file_id, created on first download. Reached only through
   bump_download() (security definer, owned by postgres, so it needs no ACL
   grant of its own) and through pool_tracks (owner-bypass view). No role
   ever gets a direct grant here -- same "closed, definer-function-only"
   shape as allowlist. See migration 10''s F3 for why REVOKE FIRST matters:
   hosted Supabase''s default privileges would otherwise hand
   anon/authenticated full read/write on this table the instant it exists.';

revoke all on public.track_stats from public, anon, authenticated;
grant select, insert, update, delete on public.track_stats to service_role;

-- ============================================================
-- bump_download() -- upsert-increment, called fire-and-forget by the
-- download route AFTER the signed URL is minted. Deliberately a COUNTER,
-- not idempotent: two downloads of the same track by the same member are
-- two downloads, and calling this twice for one file must read back 2, not
-- 1. No ownership check -- ANY active member's download counts, by design
-- (the owner's verbatim ask has no "only the uploader's downloads count"
-- clause). The one gate that exists is visibility: a member must not be
-- able to inflate the counter on a file that never made it into a
-- pool-visible state (a failed upload, a quarantined fake) by guessing its
-- uuid, so the state check reuses pool_visible_states() -- the exact set
-- migration 06 already uses for the pool's own RLS policy and for
-- pool_list()'s WHERE clause -- rather than inventing a second rule.
-- ============================================================
create or replace function public.bump_download(p_file uuid)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_state text;
  v_count bigint;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select f.state into v_state from public.files f where f.id = p_file;
  if v_state is null or not (v_state = any (public.pool_visible_states())) then
    raise exception 'file % is not pool-visible', p_file using errcode = 'P0002';
  end if;

  insert into public.track_stats (file_id, download_count)
  values (p_file, 1)
  on conflict (file_id) do update
    set download_count = public.track_stats.download_count + 1
  returning download_count into v_count;

  return v_count;
end $$;

revoke execute on function public.bump_download(uuid) from public, anon;
grant  execute on function public.bump_download(uuid) to authenticated;

comment on function public.bump_download(uuid) is
  'Upsert-increment. Returns the count AFTER this call. Refuses (P0002) on
   any file whose state is not in pool_visible_states() -- a hidden/failed
   upload cannot have its counter inflated by guessing a uuid. No ownership
   check otherwise: any active member''s download counts.';

-- ============================================================
-- pool_tracks -- add both counts. download_count is a real LEFT JOIN
-- (track_stats has no row until the first download, hence coalesce to 0).
-- upload_count is a scalar subquery, not a join: file_claims can carry
-- more than one row per file and a join would multiply every other column
-- in the view by the claim count, which is exactly the M4-storage-inflation
-- bug migration 08's storage_accounting.sql test exists to catch in the
-- adjacent problem. A subquery has no such hazard.
--
-- sk_downloads follows the same fixed-width, C-collated, subtract-from-a-
-- constant encoding as sk_added: a plain ascending scan of the string sorts
-- the highest download_count first. 12 nines comfortably outlives any
-- realistic count (a bigint could in principle exceed it; lpad on a
-- negative or over-width number would corrupt the sort, which is an
-- acceptable, extremely distant trade against matching the existing
-- pattern exactly).
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
  -- ---- Task 4 additions, appended so pool_list/pool_get can be
  -- CREATE OR REPLACEd rather than dropped (see the file header). ----
  coalesce(ts.download_count, 0)             as download_count,
  (select count(*)::int from public.file_claims c where c.file_id = f.id)
                                             as upload_count,
  ((lpad((999999999999::bigint - coalesce(ts.download_count, 0))::text, 12, '0')
   ) collate "C")                            as sk_downloads
from public.files f
join public.audio_analysis a           on a.file_id = f.id
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
   functions in migration 12 (pool_list, pool_get, pool_uploaders) and this
   migration''s CREATE OR REPLACEd versions of the same. Do NOT grant this
   to authenticated: it runs as its owner and bypasses RLS. download_count
   and upload_count added by migration 15b -- see that file for the
   format-agnostic carry to M4.';

-- ============================================================
-- pool_list -- adds download_count (the pool table's new "Downloads"
-- column) and the 'downloads_desc' sort, both appended after the existing
-- last column (row_cursor). DROP + CREATE, not CREATE OR REPLACE -- see the
-- file header. upload_count is NOT added here: the pool table only shows
-- downloads (plan Task 4, "Surface"); the detail page is where both counts
-- appear, via pool_get below.
-- ============================================================
drop function if exists public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int);

create function public.pool_list(
  p_q           text             default null,
  p_bpm_min     double precision default null,
  p_bpm_max     double precision default null,
  p_half_double boolean          default false,
  p_key         text             default null,
  p_harmonic    boolean          default false,
  p_tier_min    int              default null,
  p_uploader    uuid             default null,
  p_sort        text             default 'added_desc',
  p_cursor      text             default null,
  p_limit       int              default 100
)
returns table (
  file_id           uuid,
  track_id          uuid,
  uploaded_by       uuid,
  uploader_name     text,
  original_filename text,
  display_artist    text,
  display_title     text,
  container         text,
  byte_size         bigint,
  duration_ms       int,
  bpm               real,
  ibi_std_ms        real,
  key_camelot       text,
  key_open          text,
  key_musical       text,
  camelot_sort      int,
  quality_tier      smallint,
  lossy_ancestor    text,
  meas_cutoff_hz    int,
  integrated_lufs   real,
  has_preview       boolean,
  has_peaks         boolean,
  has_thumb         boolean,
  created_at        timestamptz,
  row_cursor        text,
  download_count    bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sort  text := coalesce(nullif(btrim(p_sort), ''), 'added_desc');
  v_limit int  := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_q     text;
  v_lo    double precision;
  v_hi    double precision;
  v_keys  text[];
  v_ck    text;
  v_cid   uuid;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_sort not in ('added_desc','bpm_asc','key_asc','artist_asc','duration_asc',
                     'tier_desc','downloads_desc') then
    raise exception 'unknown sort %', p_sort using errcode = '22023';
  end if;

  if p_key is not null and btrim(p_key) <> '' then
    if upper(btrim(p_key)) !~ '^([1-9]|1[0-2])[AB]$' then
      raise exception 'invalid camelot key %', p_key using errcode = '22023';
    end if;
    v_keys := case when coalesce(p_harmonic, false)
                   then public.camelot_neighbours(p_key)
                   else array[upper(btrim(p_key))] end;
  end if;

  if p_q is not null and btrim(p_q) <> '' then
    v_q := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if p_bpm_min is not null or p_bpm_max is not null then
    v_lo := coalesce(p_bpm_min, 0)    * 0.97;
    v_hi := coalesce(p_bpm_max, 1000) * 1.03;
  end if;

  if p_cursor is not null and length(p_cursor) > 36 then
    v_cid := right(p_cursor, 36)::uuid;
    v_ck  := left(p_cursor, length(p_cursor) - 36);
  end if;

  return query
  with base as (
    select t.*,
           (case v_sort
              when 'bpm_asc'        then t.sk_bpm
              when 'key_asc'        then t.sk_key
              when 'artist_asc'     then t.sk_artist
              when 'duration_asc'   then t.sk_duration
              when 'tier_desc'      then t.sk_tier
              when 'downloads_desc' then t.sk_downloads
              else                       t.sk_added
            end) as sk
      from public.pool_tracks t
     where t.state = 'stored'
       and (v_q is null
            or t.display_artist    ilike v_q escape '\'
            or t.display_title     ilike v_q escape '\'
            or t.original_filename ilike v_q escape '\')
       and (v_lo is null
            or (t.bpm is not null and t.bpm > 0
                and ( (t.bpm between v_lo and v_hi)
                   or (coalesce(p_half_double, false) and (t.bpm * 2 between v_lo and v_hi))
                   or (coalesce(p_half_double, false) and (t.bpm / 2 between v_lo and v_hi)) )))
       and (v_keys is null or t.key_camelot = any (v_keys))
       and (p_tier_min is null or t.quality_tier >= p_tier_min)
       and (p_uploader is null or t.uploaded_by = p_uploader)
  )
  select b.file_id, b.track_id, b.uploaded_by, b.uploader_name,
         b.original_filename, b.display_artist, b.display_title,
         b.container, b.byte_size, b.duration_ms,
         b.bpm, b.ibi_std_ms,
         b.key_camelot, b.key_open, b.key_musical, b.camelot_sort,
         b.quality_tier, b.lossy_ancestor, b.meas_cutoff_hz, b.integrated_lufs,
         b.preview_key is not null, b.peaks_key is not null,
         b.thumb_key is not null,
         b.created_at,
         (b.sk || b.file_id::text),
         b.download_count
    from base b
   where v_ck is null or (b.sk, b.file_id) > (v_ck collate "C", v_cid)
   order by b.sk, b.file_id
   limit v_limit;
end $$;

revoke execute on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int) from public, anon;
grant execute on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int) to authenticated;

comment on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int) is
  'The one list endpoint. Every filter is server-side. Paging is keyset on
   (sort key, file_id) -- never OFFSET. Migration 15b appended download_count
   and the ''downloads_desc'' sort; every earlier column and sort is
   unchanged.';

-- ============================================================
-- pool_get -- both counts, appended after created_at (the previous last
-- column). DROP + CREATE, not CREATE OR REPLACE -- see the file header.
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
  raw_tags          jsonb,
  analysis_version  text,
  analyzed_at       timestamptz,
  batch_id          uuid,
  batch_label       text,
  claim_names       text[],
  created_at        timestamptz,
  download_count    bigint,
  upload_count      int
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
         t.download_count, t.upload_count
    from public.pool_tracks t
    left join public.upload_batches ub on ub.id = t.batch_id
    cross join lateral (
      select coalesce(
               array_agg(split_part(m2.email, '@', 1) order by m2.email),
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
  'One track, everything about it. Migration 15b appended download_count and
   upload_count after created_at; every earlier column is unchanged.';
