-- supabase/migrations/20260729130600_16_file_tags.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M3 pool-UX Task 5 -- owner's verbatim ask: "give the uploader an ability
-- to add tags... at any point of time for all the tracks that he's
-- uploaded."
--
-- file_tags is a new table, closed ACL, reachable only through the two
-- SECURITY DEFINER functions below (tag_add/tag_remove) and through
-- pool_tracks -- the exact same shape as track_stats (migration 15b).
--
-- Ownership is checked IN THE BODY of both functions
-- (files.uploaded_by = auth.uid()), never trusted from RLS -- same
-- discipline as ingest_mark_uploading/ingest_finalize/ingest_fail
-- (migration 07). Editable at ANY file state: unlike the ingest RPCs there
-- is no state-machine check at all beyond "the file exists and belongs to
-- the caller" -- the owner's ask has no "only after it's stored" clause.
--
-- tag_key = trimmed, casefolded, whitespace-collapsed form of tag_display.
-- It lives ONLY in SQL (the primary key, the dedupe, the cap count and the
-- search predicate all key on it) -- there is no TypeScript mirror of this
-- derivation. The plain <form> POST that adds a tag sends the raw display
-- string and Postgres is the only place that ever computes tag_key.
--
-- pool_list/pool_get are DROPped and recreated, not CREATE OR REPLACEd --
-- see migration 15b's header for why (42P13, "cannot change return type of
-- existing function"). pool_tracks grows a `tags` column via CREATE OR
-- REPLACE VIEW, same as 15b did for download_count/upload_count.
--
-- CARRY TO M4 (must appear in its plan PR): the merge operation must union
-- tags onto the surviving identity, inside the same reversible merge event
-- as the download_count/upload_count carry from migration 15b.
-- CARRY TO M8: this is exactly the source='user_tag' tier of the genre
-- design (PRD §9.1) -- the normalisation pipeline consumes tag_key through
-- the synonym table. Do NOT pre-normalise into the controlled vocabulary
-- here; that is M8's job.
-- ============================================================

-- ---- the table ----
create table public.file_tags (
  file_id     uuid not null references public.files(id) on delete cascade,
  tag_display text not null,
  tag_key     text not null,
  created_by  uuid not null references public.members(user_id),
  created_at  timestamptz not null default now(),
  primary key (file_id, tag_key)
);
alter table public.file_tags enable row level security;

-- Supports both the exists() search predicate in pool_list below and any
-- future "browse by tag" feature. The primary key already covers "all tags
-- for one file" (file_id leads); this covers the reverse direction.
create index file_tags_tag_key_idx on public.file_tags (tag_key);

comment on table public.file_tags is
  'One row per (file, tag_key). tag_key is the trimmed, casefolded,
   whitespace-collapsed form of tag_display -- see tag_add(). Reachable
   only through tag_add()/tag_remove() (both SECURITY DEFINER) and through
   pool_tracks (owner-bypass view) -- the same closed, definer-function-only
   shape as track_stats (migration 15b) and allowlist. No role ever gets a
   direct grant here -- see migration 10''s F3 for why REVOKE FIRST matters:
   hosted Supabase''s default privileges would otherwise hand
   anon/authenticated full read/write on this table the instant it exists.
   CARRY TO M4: merge unions tags onto the surviving identity, the same
   event-recorded, reversible treatment as counts and claims. CARRY TO M8:
   this is the source=''user_tag'' tier of the genre design (PRD §9.1) --
   do not pre-normalise tag_key into the controlled vocabulary here.';

revoke all on public.file_tags from public, anon, authenticated;
grant select, insert, update, delete on public.file_tags to service_role;

-- ============================================================
-- tag_add() -- insert one tag, uploader-only, cap-enforced. ON CONFLICT DO
-- NOTHING makes a repeat add of the same tag_key a silent no-op rather than
-- an error -- "Deep House" then "deep house" collide on the key and the
-- second call changes nothing, including the display casing (first write
-- wins). The 20-tag cap is checked only when the incoming key is NOT
-- already present, so re-adding an existing tag while already at the cap
-- is never itself a violation.
-- ============================================================
create or replace function public.tag_add(p_file uuid, p_tag text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_display text;
  v_key     text;
  v_exists  boolean;
  v_count   int;
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f
                  where f.id = p_file and f.uploaded_by = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Collapse every run of whitespace (leading, trailing or internal) to a
  -- single space, then trim what that leaves at the ends.
  v_display := btrim(regexp_replace(coalesce(p_tag, ''), '\s+', ' ', 'g'));
  if v_display = '' then
    raise exception 'tag must not be empty' using errcode = '22023';
  end if;
  if length(v_display) > 32 then
    raise exception 'tag must be at most 32 characters' using errcode = '22023';
  end if;
  v_key := lower(v_display);

  select exists (select 1 from public.file_tags t
                  where t.file_id = p_file and t.tag_key = v_key)
    into v_exists;

  if not v_exists then
    select count(*) into v_count from public.file_tags t where t.file_id = p_file;
    if v_count >= 20 then
      raise exception 'a file may carry at most 20 tags' using errcode = '22023';
    end if;
  end if;

  insert into public.file_tags (file_id, tag_display, tag_key, created_by)
  values (p_file, v_display, v_key, auth.uid())
  on conflict (file_id, tag_key) do nothing;
end $$;

revoke execute on function public.tag_add(uuid, text) from public, anon;
grant  execute on function public.tag_add(uuid, text) to authenticated;

comment on function public.tag_add(uuid, text) is
  'Adds one tag to a file, uploader-only (checked in-body via
   files.uploaded_by = auth.uid(), never trusted from RLS). tag_key is the
   trimmed, casefolded, whitespace-collapsed form of tag_display -- "Deep
   House" and "deep house" collide on the same key and the SECOND insert is
   a silent no-op (ON CONFLICT DO NOTHING), not an error, so a double
   submit from two tabs is harmless and the first casing wins. Caps: 32
   chars, 20 tags/file, both raised as 22023 with a plain-language message.
   Editable at ANY file state -- no state check beyond the file existing
   and belonging to the caller.';

-- ============================================================
-- tag_remove() -- delete by tag_key, uploader-only. A key that is not
-- present is a silent no-op: deletion is idempotent by nature and a
-- double-submitted remove must not be an error.
-- ============================================================
create or replace function public.tag_remove(p_file uuid, p_tag_key text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f
                  where f.id = p_file and f.uploaded_by = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_key := lower(btrim(regexp_replace(coalesce(p_tag_key, ''), '\s+', ' ', 'g')));
  delete from public.file_tags t where t.file_id = p_file and t.tag_key = v_key;
end $$;

revoke execute on function public.tag_remove(uuid, text) from public, anon;
grant  execute on function public.tag_remove(uuid, text) to authenticated;

comment on function public.tag_remove(uuid, text) is
  'Removes one tag by its tag_key, uploader-only (same in-body ownership
   check as tag_add). A key that does not exist is a silent no-op, not an
   error.';

-- ============================================================
-- pool_tracks -- add `tags`, a scalar subquery like upload_count (a LEFT
-- JOIN would multiply every other column by the tag count -- the exact
-- hazard upload_count's own comment already documents). Ordered by
-- created_at so chips read in the order the uploader added them, tag_key
-- as a stable tiebreak for tags added in the same transaction.
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
  -- ---- Task 5 addition, appended so pool_list/pool_get can each keep the
  -- rest of their column order unchanged. ----
  coalesce(
    (select array_agg(ft.tag_display order by ft.created_at, ft.tag_key)
       from public.file_tags ft where ft.file_id = f.id),
    '{}'::text[])                            as tags
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
   functions pool_list/pool_get/pool_uploaders. Do NOT grant this to
   authenticated: it runs as its owner and bypasses RLS. download_count and
   upload_count added by migration 15b; tags added by migration 16 -- see
   that migration for the format-agnostic/M8-normalisation carries.';

-- ============================================================
-- pool_list -- adds `tags` (appended after download_count, the previous
-- last column) and extends the `q` search to match a file's tag_key.
-- DROP + CREATE, not CREATE OR REPLACE -- see the file header.
--
-- The tag predicate reuses v_q, already built as an ESCAPEd LIKE pattern
-- for the ilike columns above it -- lower() on that pattern is safe because
-- the escape character itself is case-invariant, and it is what lets a
-- plain `like` (rather than `ilike`) match tag_key, which is already
-- casefolded at write time.
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
  download_count    bigint,
  tags              text[]
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
            or t.original_filename ilike v_q escape '\'
            or exists (select 1 from public.file_tags ft
                        where ft.file_id = t.file_id
                          and ft.tag_key like lower(v_q) escape '\'))
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
         b.download_count,
         b.tags
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
   (sort key, file_id) -- never OFFSET. Migration 16 appended `tags` (for
   the pool row chips) and extended `q` to also match a file''s tag_key;
   every earlier column and sort is unchanged.';

-- ============================================================
-- pool_get -- adds `tags` (appended after upload_count, the previous last
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
  'One track, everything about it. Migration 15b appended download_count
   and upload_count; migration 16 appended tags. Every earlier column is
   unchanged.';
