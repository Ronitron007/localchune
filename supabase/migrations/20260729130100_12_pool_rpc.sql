-- supabase/migrations/20260729130100_12_pool_rpc.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- The one list endpoint, server-side in full.
--
-- SECURITY DEFINER because it reads public.pool_tracks, which bypasses RLS
-- (see migration 11). The gate is therefore the first statement in the body
-- plus `t.state = 'stored'` -- there is no second path in.
--
-- Numeric parameters are int / double precision rather than smallint / real
-- on purpose: PostgREST hands over JSON numbers, and int4 -> int2 is an
-- ASSIGNMENT cast, not an implicit one, so a smallint parameter makes
-- pool_list(p_tier_min => 4) fail function resolution outright.
--
-- Every reference inside the body is table-qualified. In a plpgsql
-- `returns table`, the output columns are variables, so a bare `bpm` would
-- be ambiguous against pool_tracks.bpm and raise 42702 at RUNTIME. Migration
-- 08 hit exactly this and renamed its outputs; qualification is the other
-- half of the same discipline.
-- ============================================================
create or replace function public.pool_list(
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
  row_cursor        text
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

  if v_sort not in ('added_desc','bpm_asc','key_asc','artist_asc','duration_asc','tier_desc') then
    raise exception 'unknown sort %', p_sort using errcode = '22023';
  end if;

  if p_key is not null and btrim(p_key) <> '' then
    if upper(btrim(p_key)) !~ '^([1-9]|1[0-2])[AB]$' then
      raise exception 'invalid camelot key %', p_key using errcode = '22023';
    end if;
    -- The harmonic expansion is computed HERE, not in the browser: a client
    -- that sends four keys instead of one is a client that can be wrong
    -- about the wraparound, and 12 <-> 1 is exactly where implementations
    -- get it wrong.
    v_keys := case when coalesce(p_harmonic, false)
                   then public.camelot_neighbours(p_key)
                   else array[upper(btrim(p_key))] end;
  end if;

  if p_q is not null and btrim(p_q) <> '' then
    -- Escape the LIKE metacharacters, backslash FIRST or the escapes get
    -- re-escaped. Someone searching for '100%' must not match every row.
    v_q := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if p_bpm_min is not null or p_bpm_max is not null then
    -- +/-3%, applied ONCE to the query bounds rather than per candidate.
    v_lo := coalesce(p_bpm_min, 0)    * 0.97;
    v_hi := coalesce(p_bpm_max, 1000) * 1.03;
  end if;

  if p_cursor is not null and length(p_cursor) > 36 then
    -- The uuid is always the last 36 characters, so the cursor needs no
    -- separator and no artist name can corrupt it.
    v_cid := right(p_cursor, 36)::uuid;
    v_ck  := left(p_cursor, length(p_cursor) - 36);
  end if;

  return query
  with base as (
    select t.*,
           (case v_sort
              when 'bpm_asc'      then t.sk_bpm
              when 'key_asc'      then t.sk_key
              when 'artist_asc'   then t.sk_artist
              when 'duration_asc' then t.sk_duration
              when 'tier_desc'    then t.sk_tier
              else                     t.sk_added
            end) as sk
      from public.pool_tracks t
     where t.state = 'stored'
       and (v_q is null
            or t.display_artist    ilike v_q escape '\'
            or t.display_title     ilike v_q escape '\'
            or t.original_filename ilike v_q escape '\')
       -- Half/double time. A 174 DnB track IS an 87 track to a DJ, and the
       -- pool is unusable without this. PRD 7 calls the octave problem a UX
       -- decision rather than a bug; this is the decision.
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
         (b.sk || b.file_id::text)
    from base b
   -- Keyset, never OFFSET: an upload landing mid-scroll would shift every
   -- later page by one row and silently hide a track. `collate "C"` on v_ck
   -- is required -- b.sk carries a declared C collation and the variable
   -- does not, and two differing implicit collations raise 42P22.
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

-- ============================================================
-- One track, everything about it. Wider than pool_list because the detail
-- page shows the forensics, and because the signed-GET routes in M5 Task 7
-- need the artifact key names server-side.
--
-- Visibility is the same rule migration 06 wrote for files: a pool-visible
-- state for everyone, anything else only for its uploader and the owner.
-- This is deliberately wider than pool_list's `state = 'stored'`, so a
-- member can open a track that is still being analysed and watch it finish.
-- ============================================================
create or replace function public.pool_get(p_file_id uuid)
returns table (
  file_id           uuid,
  track_id          uuid,
  uploaded_by       uuid,
  uploader_name     text,
  original_filename text,
  -- The object key, so the signed-GET routes in M5 Task 7 do not have to
  -- re-derive it. Reconstructing 'audio/<uid>/<file_id>.<container>' in
  -- TypeScript would fork the key-minting rule migration 07 deliberately
  -- centralised in ingest_begin(), and it would be wrong for any file whose
  -- stored container differs from its extension. The key carries no secret:
  -- without a signature it opens nothing.
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
  created_at        timestamptz
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
         t.batch_id, ub.label, cl.claim_names, t.created_at
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

-- ============================================================
-- The UploaderFilter's options, with counts. Output is member_id, NOT
-- user_id: in a plpgsql `returns table` an output named user_id is
-- ambiguous against members.user_id and file_claims.user_id inside the body
-- and raises 42702 at runtime. Migration 08 documents the same trap.
-- ============================================================
create or replace function public.pool_uploaders()
returns table (member_id uuid, uploader_name text, track_count int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select t.uploaded_by, t.uploader_name, count(*)::int
    from public.pool_tracks t
   where t.state = 'stored'
   group by t.uploaded_by, t.uploader_name
   order by t.uploader_name;
end $$;

revoke execute on function public.pool_uploaders() from public, anon;
grant  execute on function public.pool_uploaders() to authenticated;

comment on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int) is
  'The one list endpoint. Every filter is server-side. Paging is keyset on
   (sort key, file_id) -- never OFFSET, which would shift every later page
   when an upload lands mid-scroll. row_cursor of the last row returned is
   the p_cursor of the next call.';
