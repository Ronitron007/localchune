-- supabase/migrations/20260729131000_19_likes_plays.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M6a Task 1 -- likes and play events, the substrate for M6a's "signal"
-- surfaces (like button, play meter) and for M6c's "hot this week" ranking.
--
-- Two different shapes for two different questions:
--
-- 1. likes answers "does THIS member like THIS file, right now" -- a
--    membership fact, not a log. One row per (file, member), toggled by
--    deleting-if-present / inserting-if-absent (see toggle_like below), so
--    "liked" is exactly "a row exists" -- no separate boolean to drift out
--    of sync with the row's presence.
-- 2. play_events answers "how many times, and WHEN" -- an append-only log,
--    the same shape file_claims/track_stats' download side already uses a
--    counter for, but a counter is wrong here: M6c's "hot this week" needs
--    to filter played_at into a rolling window, which a single integer
--    cannot reconstruct. bump_play() therefore inserts, never upserts.
--
-- Anonymity: neither table grants anon/authenticated anything at all --
-- the same closed, definer-function-only shape as track_stats (migration
-- 15b), file_tags (migration 16) and allowlist. REVOKE FIRST matters here
-- exactly as migration 10's F3 explains: hosted Supabase's default
-- privileges would otherwise hand anon/authenticated full read/write on
-- these tables the instant they exist.
--
-- pool_tracks (CREATE OR REPLACE VIEW, append-only -- see migration 15b's
-- header for why that works for a view but not for a RETURNS TABLE
-- function) grows five columns: like_count, liked_by_me, play_count,
-- sk_likes, sk_plays. Both counts come from a LEFT JOIN LATERAL count(*)
-- aggregate, NOT a plain join -- likes and play_events both carry more than
-- one row per file_id, so a plain join would multiply every other column
-- in the view by the like/play count, the exact claim-multiplication hazard
-- migration 15b's upload_count comment documents for file_claims. sk_likes/
-- sk_plays follow sk_downloads' fixed-width, C-collated, subtract-from-a-
-- constant encoding exactly, and are internal to pool_tracks/pool_list's
-- sort CTE only -- like sk_downloads, they are never themselves returned by
-- pool_list or pool_get.
--
-- pool_list/pool_get: DROP + CREATE, not CREATE OR REPLACE -- migration
-- 15b's header explains why (42P13, "cannot change return type of existing
-- function"). Both RETURNS TABLEs grow like_count, liked_by_me, play_count,
-- appended after the previous last column (tags, migration 16). pool_list
-- also grows two new p_sort values, 'likes_desc' -> sk_likes and
-- 'plays_desc' -> sk_plays, following the 'downloads_desc' -> sk_downloads
-- arm's exact composite-cursor shape (sort key, then file_id tiebreak).
--
-- CARRY TO M4: the merge operation must fold likes and play_events onto the
-- surviving track identity inside the same reversible merge event as
-- download_count/upload_count (migration 15b) and tags (migration 16) --
-- likes need de-duplication by (member, surviving file) since a member may
-- have liked both sides of the merge; play_events is a plain UNION, no
-- dedupe needed (each row is one play, not a membership fact).
-- ============================================================

-- ---- likes: one row per (file, member); presence IS "liked" ----
create table public.likes (
  file_id    uuid not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.members(user_id) on delete cascade,
  created_at timestamptz not null default now(),   -- "liked this week" (M6c)
  primary key (file_id, user_id)
);
alter table public.likes enable row level security;

comment on table public.likes is
  'One row per (file_id, user_id) -- presence of the row IS "liked", so
   there is no separate boolean to drift out of sync. Reached only through
   toggle_like() (security definer, owned by postgres, so it needs no ACL
   grant of its own) and through pool_tracks (owner-bypass view). No role
   ever gets a direct grant here -- same "closed, definer-function-only"
   shape as track_stats/file_tags/allowlist. See migration 10''s F3 for why
   REVOKE FIRST matters: hosted Supabase''s default privileges would
   otherwise hand anon/authenticated full read/write the instant it exists.
   CARRY TO M4: merge must de-duplicate by (member, surviving file) -- a
   member may have liked both sides.';

revoke all on public.likes from public, anon, authenticated;
grant select, insert, update, delete on public.likes to service_role;

-- ---- play_events: append-only log, never a counter -- M6c needs the
-- timestamps to compute a rolling window, which a single integer cannot
-- reconstruct. ----
create table public.play_events (
  id        bigserial primary key,
  file_id   uuid not null references public.files(id) on delete cascade,
  user_id   uuid not null references public.members(user_id),
  played_at timestamptz not null default now()
);
alter table public.play_events enable row level security;

comment on table public.play_events is
  'Append-only log, one row per play -- deliberately NOT a counter, because
   M6c''s "hot this week" ranking needs played_at to filter a rolling
   window, which a single integer cannot reconstruct. Reached only through
   bump_play() (security definer) and through pool_tracks (owner-bypass
   view) -- same closed, definer-function-only shape as likes. No role ever
   gets a direct grant here. CARRY TO M4: merge is a plain UNION onto the
   surviving file_id -- no de-duplication needed, each row is one play.';

revoke all on public.play_events from public, anon, authenticated;
grant select, insert, update, delete on public.play_events to service_role;
create index play_events_file_idx on public.play_events (file_id);
create index play_events_window_idx on public.play_events (played_at);

-- ============================================================
-- toggle_like() -- delete-first toggle, following bump_download's exact
-- gate shape (active-member/owner check, then pool_visible_states() P0002
-- check). Delete-first (rather than a SELECT-then-branch) makes a single
-- retried call safe with no ON CONFLICT: if the DELETE removes a row, the
-- member had liked it and now doesn't; if it removes nothing, they hadn't
-- and now do. No ownership check beyond membership -- any active member may
-- like any pool-visible file, same "no uploader-only clause" shape as
-- bump_download.
-- ============================================================
create or replace function public.toggle_like(p_file uuid)
returns table (like_count bigint, liked boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_state text;
  v_count bigint;
  v_liked boolean;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select f.state into v_state from public.files f where f.id = p_file;
  if v_state is null or not (v_state = any (public.pool_visible_states())) then
    raise exception 'file % is not pool-visible', p_file using errcode = 'P0002';
  end if;

  delete from public.likes where file_id = p_file and user_id = auth.uid();
  if not found then
    insert into public.likes (file_id, user_id) values (p_file, auth.uid());
    v_liked := true;
  else
    v_liked := false;
  end if;

  select count(*) into v_count from public.likes where file_id = p_file;
  return query select v_count, v_liked;
end $$;

revoke execute on function public.toggle_like(uuid) from public, anon;
grant  execute on function public.toggle_like(uuid) to authenticated;

comment on function public.toggle_like(uuid) is
  'Delete-first toggle: if the caller already liked p_file the like is
   removed, otherwise it is added. Returns the count AFTER this call and
   whether the caller now likes it. Refuses (P0002) on any file whose state
   is not in pool_visible_states() -- same gate as bump_download. No
   ownership check otherwise: any active member may like any pool-visible
   file.';

-- ============================================================
-- bump_play() -- same gates as toggle_like/bump_download, then one INSERT
-- into play_events. A counter would be wrong here: M6c's "hot this week"
-- needs the timestamps, not just a total.
-- ============================================================
create or replace function public.bump_play(p_file uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_state text;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select f.state into v_state from public.files f where f.id = p_file;
  if v_state is null or not (v_state = any (public.pool_visible_states())) then
    raise exception 'file % is not pool-visible', p_file using errcode = 'P0002';
  end if;

  insert into public.play_events (file_id, user_id) values (p_file, auth.uid());
end $$;

revoke execute on function public.bump_play(uuid) from public, anon;
grant  execute on function public.bump_play(uuid) to authenticated;

comment on function public.bump_play(uuid) is
  'Inserts one play_events row for p_file. Deliberately not an
   upsert/counter -- M6c''s "hot this week" needs played_at, which a single
   integer cannot reconstruct. Same P0002/membership gates as toggle_like
   and bump_download.';

-- ============================================================
-- pool_tracks -- adds like_count, liked_by_me, play_count, sk_likes,
-- sk_plays, appended after sk_downloads/tags so pool_list/pool_get can each
-- keep the rest of their column order unchanged. Both counts come from a
-- LEFT JOIN LATERAL count(*) aggregate -- NOT a plain join, since likes and
-- play_events both carry more than one row per file_id and a plain join
-- would multiply every other column in the view by the like/play count
-- (the same hazard migration 15b's upload_count comment documents).
-- liked_by_me is a correlated EXISTS on auth.uid(), which resolves fine
-- inside the definer RPCs that are pool_tracks' only callers.
-- ============================================================
create or replace view public.pool_tracks as
select
  f.id                                       as file_id,
  f.track_id,
  f.batch_id,
  f.uploaded_by,
  coalesce(m.username, split_part(m.email, '@', 1))
                                              as uploader_name,
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
    '{}'::text[])                            as tags,
  -- ---- M6a Task 1 additions, appended so pool_list/pool_get can each keep
  -- the rest of their column order unchanged. ----
  coalesce(lk.like_count, 0)::int            as like_count,
  exists (select 1 from public.likes l
           where l.file_id = f.id and l.user_id = auth.uid())
                                             as liked_by_me,
  coalesce(pe.play_count, 0)::int            as play_count,
  ((lpad((999999999999::bigint - coalesce(lk.like_count, 0))::text, 12, '0')
   ) collate "C")                            as sk_likes,
  ((lpad((999999999999::bigint - coalesce(pe.play_count, 0))::text, 12, '0')
   ) collate "C")                            as sk_plays
from public.files f
-- LEFT, not JOIN: analysis_fail() (migration 09) never writes a row, so a
-- failed file has no audio_analysis partner -- see migration 16b.
left join public.audio_analysis a      on a.file_id = f.id
join public.members m                  on m.user_id  = f.uploaded_by
left join public.track_stats ts        on ts.file_id = f.id
left join lateral (
  select count(*)::int as like_count
    from public.likes lk2
   where lk2.file_id = f.id
) lk on true
left join lateral (
  select count(*)::int as play_count
    from public.play_events pe2
   where pe2.file_id = f.id
) pe on true
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
   upload_count added by migration 15b; tags added by migration 16; the
   audio_analysis LEFT JOIN by migration 16b; uploader_name''s
   members.username preference by migration 17. Migration 26 (M6a Task 1)
   appended like_count, liked_by_me, play_count, sk_likes, sk_plays, sourced
   from LEFT JOIN LATERAL count(*) aggregates -- never a plain join, since
   likes/play_events carry more than one row per file_id.';

-- ============================================================
-- pool_list -- adds like_count, liked_by_me, play_count (appended after
-- tags, the previous last column) and two new sort values, 'likes_desc' ->
-- sk_likes and 'plays_desc' -> sk_plays, following 'downloads_desc' ->
-- sk_downloads exactly. DROP + CREATE, not CREATE OR REPLACE -- see the
-- file header.
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
  tags              text[],
  like_count        int,
  liked_by_me       boolean,
  play_count        int
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
                     'tier_desc','downloads_desc','likes_desc','plays_desc') then
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
              when 'likes_desc'     then t.sk_likes
              when 'plays_desc'     then t.sk_plays
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
         b.tags,
         b.like_count,
         b.liked_by_me,
         b.play_count
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
   (sort key, file_id) -- never OFFSET. Migration 26 (M6a Task 1) appended
   like_count, liked_by_me, play_count and the ''likes_desc''/''plays_desc''
   sorts; every earlier column and sort is unchanged.';

-- ============================================================
-- pool_get -- adds like_count, liked_by_me, play_count (appended after
-- tags, the previous last column). DROP + CREATE, not CREATE OR REPLACE --
-- see the file header.
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
         t.raw_tags, t.analysis_version, t.analyzed_at,
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
  'One track, everything about it. Migration 15b appended download_count
   and upload_count; migration 16 appended tags; migration 18 swapped
   claim_names to prefer claimed usernames. Migration 26 (M6a Task 1)
   appended like_count, liked_by_me, play_count. Every earlier column and
   the visibility WHERE clause are unchanged.';
