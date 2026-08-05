-- supabase/migrations/20260805100000_31_feed.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M6c Task 1 -- the home feed's three RPCs, plus member_resolve for member
-- pages. Three definer functions, same gate/revoke/grant shell as every
-- other pool RPC (is_active_member() or is_owner(), 42501 otherwise).
--
-- feed_tracks(p_section, p_limit) returns pool_get's ENTIRE column list
-- (provenance, not raw_tags -- migration 28's swap), NOT `setof
-- public.pool_tracks`. pool_tracks is the raw composition unit: it still
-- carries raw_tags (the exact leak migration 28 closed for pool_get/
-- crate_get) and the internal sk_* sort-key/camelot_sort columns nothing
-- downstream should see. Returning it directly would reopen that leak and
-- hand the client implementation detail no other RPC exposes. Every row is
-- produced by joining a ranked file_id back through pool_get() itself, so
-- feed_tracks can never drift from what pool_get/crate_get already render
-- through TrackRow.astro -- the exact promise the brief's "same shape
-- pool_get returns" language makes, and crate_get's own column list (this
-- file's header, migration 27) already follows.
--
-- Visibility: 'stored', not pool_visible_states(). pool_visible_states()
-- (['received','analysing','stored','needs_review']) is what a file's OWN
-- uploader gets to see mid-pipeline (pool_get's fallback clause); the home
-- feed is a public discovery surface with no such uploader exception, so it
-- uses the same 'stored'-only filter pool_list() already applies to the
-- browse table. member_resolve's track_count follows the same rule --
-- the brief's own prose says "counts distinct STORED files", even though
-- its draft SQL said pool_visible_states().
--
-- Ranking aggregates by files.track_id, not file_id -- a merge (migration
-- 23) re-points every moved file's track_id at the survivor, so two files
-- that used to be separate identities pool their signal automatically the
-- moment they share a track, with no special-case merge-aware code here.
-- 'hot' = 7-day plays + 7-day likes, summed across every stored file on the
-- track; 'top' = all-time likes, same grouping. Both tie-break on the
-- group's summed download_count. One row per qualifying track: the track's
-- preferred_file_id when it is itself a stored pool row, else the track's
-- newest stored file -- so a merge never produces two feed rows for one
-- track, and never points at a file that is not actually visible.
--
-- members has no revoked_at (that column lives on allowlist, migration 01).
-- "active" is access_expires_at > now(), the same test is_active_member()
-- runs -- member_resolve applies it directly to the row being resolved
-- rather than to the caller, since a member whose access lapsed should not
-- have a live profile page. "joined_at" in the brief's draft is
-- members.created_at; there is no separate joined_at column.
--
-- member_resolve does the P0002 "no such member" check as an explicit
-- `if not exists (...)` BEFORE `return query`, not an `if not found` after
-- it. RETURN QUERY does set FOUND in modern Postgres, but making that the
-- single line standing between "no such member" and a silent empty result
-- is exactly the kind of assumption the task brief flagged for verification
-- -- an upfront exists-check needs no such trust and is proven directly by
-- pgTAP cases 11/12 either way.
-- ============================================================

-- ------------------------------------------------------------
-- feed_tracks -- 'fresh' (recently stored, newest first, one row per FILE
-- -- not track-aggregated, since recency is not a pooled signal), 'hot' and
-- 'top' (track-aggregated, one row per track). 22023 on any other section.
-- ------------------------------------------------------------
create or replace function public.feed_tracks(p_section text, p_limit int default 12)
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
declare
  v_limit int := least(greatest(coalesce(p_limit, 12), 1), 50);
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  if p_section = 'fresh' then
    return query
      select pg.* from (
        select t.file_id, t.created_at
          from public.pool_tracks t
         where t.state = 'stored'
           and t.created_at > now() - interval '7 days'
         order by t.created_at desc, t.file_id
         limit v_limit
      ) sel
      join lateral public.pool_get(sel.file_id) pg on true
     order by sel.created_at desc, sel.file_id;

  elsif p_section in ('hot', 'top') then
    return query
      with sig as (
        select f.track_id,
               -- score: 'hot' sums 7-day plays + 7-day likes across every
               -- stored file on the track; 'top' sums all-time likes only.
               coalesce(sum(
                 case when p_section = 'hot' then (
                   (select count(*) from public.play_events pe
                     where pe.file_id = f.id
                       and pe.played_at > now() - interval '7 days')
                 + (select count(*) from public.likes l
                     where l.file_id = f.id
                       and l.created_at > now() - interval '7 days')
                 ) else (
                   select count(*) from public.likes l where l.file_id = f.id
                 ) end
               ), 0) as score,
               -- tiebreak: summed all-time download_count across the group,
               -- same "pool the signal" rule as score itself.
               coalesce(sum(
                 coalesce((select ts.download_count from public.track_stats ts
                            where ts.file_id = f.id), 0)
               ), 0) as tiebreak
          from public.files f
         where f.state = 'stored' and f.track_id is not null
         group by f.track_id
      ),
      ranked as (
        select s.track_id, s.score, s.tiebreak from sig s where s.score > 0
      ),
      face as (
        -- One row per qualifying track: preferred_file_id when it is
        -- itself a stored pool row, else the track's newest stored file.
        select r.track_id, r.score, r.tiebreak,
               coalesce(
                 (select tr.preferred_file_id
                    from public.tracks tr
                    join public.files pf on pf.id = tr.preferred_file_id
                   where tr.id = r.track_id and pf.state = 'stored'),
                 (select f2.id from public.files f2
                   where f2.track_id = r.track_id and f2.state = 'stored'
                   order by f2.created_at desc, f2.id
                   limit 1)
               ) as file_id
          from ranked r
      ),
      sel as (
        select fc.file_id, fc.score, fc.tiebreak
          from face fc
         where fc.file_id is not null
         order by fc.score desc, fc.tiebreak desc, fc.file_id
         limit v_limit
      )
      select pg.* from sel
        join lateral public.pool_get(sel.file_id) pg on true
       order by sel.score desc, sel.tiebreak desc, sel.file_id;

  else
    raise exception 'unknown feed section %', p_section using errcode = '22023';
  end if;
end $$;

revoke execute on function public.feed_tracks(text, int) from public, anon;
grant  execute on function public.feed_tracks(text, int) to authenticated;

comment on function public.feed_tracks(text, int) is
  'Home feed. ''fresh'' -- stored last 7 days, newest first, one row per
   file. ''hot''/''top'' -- track-aggregated (7-day plays+likes / all-time
   likes), one row per track via preferred_file_id or the newest stored
   file, download_count-summed tiebreak. 22023 on any other section. Every
   row is pool_get(file_id) -- never raw pool_tracks -- so this can never
   leak raw_tags or expose pool_tracks'' internal sort-key columns.';

-- ------------------------------------------------------------
-- feed_new_crates -- public crates, newest-public-first. track_count/
-- total_duration_ms follow crate_list()'s exact lateral-aggregate shape
-- (pool_visible_states(), not 'stored' -- matching what crate_get itself
-- would actually show inside the crate, same as crate_list()).
-- ------------------------------------------------------------
create or replace function public.feed_new_crates(p_limit int default 8)
returns table (
  id                uuid,
  name              text,
  owner_name        text,
  track_count       bigint,
  total_duration_ms bigint,
  made_public_at    timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 8), 1), 50);
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  return query
    select c.id, c.name,
           coalesce(m.username, split_part(m.email, '@', 1)) as owner_name,
           coalesce(ci.track_count, 0)::bigint                as track_count,
           coalesce(ci.total_duration_ms, 0)::bigint           as total_duration_ms,
           c.made_public_at
      from public.crates c
      join public.members m on m.user_id = c.owner_id
      left join lateral (
        select count(*)::bigint as track_count,
               sum(coalesce(a.duration_ms, f.duration_ms, 0))::bigint as total_duration_ms
          from public.crate_items it
          join public.files f on f.id = it.file_id
          left join public.audio_analysis a on a.file_id = f.id
         where it.crate_id = c.id
           and f.state = any (public.pool_visible_states())
      ) ci on true
     where c.is_public
     order by c.made_public_at desc nulls last, c.id
     limit v_limit;
end $$;

revoke execute on function public.feed_new_crates(int) from public, anon;
grant  execute on function public.feed_new_crates(int) to authenticated;

comment on function public.feed_new_crates(int) is
  'Public crates, newest made_public_at first (never created_at -- that
   never changes). owner_name and the track_count/total_duration_ms
   lateral shape are copied verbatim from crate_list() (migration 27) so
   the two never disagree on what a crate card shows.';

-- ------------------------------------------------------------
-- member_resolve -- a member's public profile: joined_at (members.created_at)
-- and track_count (distinct stored files they claim, via file_claims).
-- P0002 for no such active member -- checked with an explicit exists-check
-- before RETURN QUERY, not an `if not found` after it.
-- ------------------------------------------------------------
create or replace function public.member_resolve(p_username text)
returns table (user_id uuid, username text, joined_at timestamptz, track_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.members m
     where m.username = p_username and m.access_expires_at > now()
  ) then
    raise exception 'no such member' using errcode = 'P0002';
  end if;

  return query
    select m.user_id, m.username, m.created_at,
           (select count(distinct fc.file_id) from public.file_claims fc
             join public.files f on f.id = fc.file_id
            where fc.user_id = m.user_id
              and f.state = 'stored') as track_count
      from public.members m
     where m.username = p_username
       and m.access_expires_at > now();
end $$;

revoke execute on function public.member_resolve(text) from public, anon;
grant  execute on function public.member_resolve(text) to authenticated;

comment on function public.member_resolve(text) is
  'A member''s public profile by username. track_count counts distinct
   STORED files they claim via file_claims -- not pool_visible_states(),
   matching the brief''s prose over its draft SQL. P0002 when no active
   (access_expires_at > now()) member holds that username -- members has no
   revoked_at column (that lives on allowlist); an access-expired member
   resolves the same as a nonexistent one.';
