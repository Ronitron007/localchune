-- supabase/migrations/20260807130000_35_crate_art.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- A CRATE LOOKS LIKE A CRATE -- owner, 2026-08-07: "crates should actually
-- look like crates... instead of a crate having an album art it has the
-- first tracks album art followed by other 2-3 tracks album art stacked
-- behind it".
--
-- To draw that stack a card needs the FIRST FEW ARTWORKED FILES in the
-- crate, in crate order. This migration adds one column to the two RPCs
-- that already feed crate cards -- crate_list() (migration 27, /crates and
-- /member/[username]) and feed_new_crates() (migration 31, the home feed's
-- "New public crates" section):
--
--   art_file_ids uuid[]   up to four file ids, position order, artworked
--                         files only. NEVER null -- an empty crate gets
--                         '{}' so a card branches on length, not on null.
--
-- WHY IDS AND NOT KEYS. Art is addressed by CONVENTION, not by a stored
-- pointer: `derived/<file_id>/thumb.jpg` / `thumb-2x.jpg` / `medium.jpg`
-- off the public art bucket (spec 2026-08-01-art-bucket-split, and
-- src/lib/track-format.ts's artUrl). audio_analysis.thumb_key is
-- 'thumb.jpg' on every row that has art, so the KEY carries no information
-- the id does not. Returning ids keeps this function out of the business
-- of building URLs, which is where every other art caller already keeps
-- it.
--
-- The filter is `thumb_key is not null`, which is the same "this file
-- actually has a cover" test pool_list()'s has_thumb encodes and
-- crate_get() exposes as thumb_key. A crate whose first three tracks have
-- no art gets the art of tracks four, five and six rather than three
-- placeholder tiles -- the stack is meant to look like records, and an
-- empty sleeve at the front of it is worse than a shorter stack.
--
-- FOUR, not three. The owner asked for "other 2-3 tracks" behind the
-- first, so four is the top of the range they named and the card decides
-- how many of them it draws. Deciding it here would put a visual constant
-- in Postgres.
--
-- WHY BOTH FUNCTIONS ARE DROPPED AND RECREATED. Postgres cannot change a
-- function's RETURNS TABLE with CREATE OR REPLACE (42P13), and adding a
-- column is changing it. Both bodies below are migration 27's and 31's,
-- extended -- not rewritten from a plan. The lateral track_count/
-- total_duration_ms aggregate, the pool_visible_states() filter, the
-- owner_name expression and the visibility predicate are byte-for-byte
-- what those migrations shipped, because the two functions have always
-- been required to agree about what a crate card shows and a retyped copy
-- is how they would stop.
--
-- GRANTS: revoke-first, as CLAUDE.md requires. A hosted project's
-- ALTER DEFAULT PRIVILEGES has already granted execute on every new
-- function to public; a bare `grant ... to authenticated` would be a
-- no-op that reads like a decision. Dropping and recreating re-arms that
-- default, so this is not belt-and-braces -- it is the only thing standing
-- between `anon` and both functions.
-- ============================================================

-- ------------------------------------------------------------
-- crate_list() -- migration 27's body, plus art_file_ids.
-- ------------------------------------------------------------
drop function if exists public.crate_list();

create or replace function public.crate_list()
returns table (
  id                uuid,
  name              text,
  owner_id          uuid,
  owner_name        text,
  is_mine           boolean,
  is_public         boolean,
  track_count       int,
  total_duration_ms bigint,
  updated_at        timestamptz,
  art_file_ids      uuid[]
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.id, c.name, c.owner_id,
         coalesce(m.username, split_part(m.email, '@', 1)) as owner_name,
         (c.owner_id = auth.uid())                          as is_mine,
         c.is_public,
         coalesce(ci.track_count, 0)::int                   as track_count,
         coalesce(ci.total_duration_ms, 0)::bigint           as total_duration_ms,
         c.updated_at,
         coalesce(art.file_ids, '{}'::uuid[])                as art_file_ids
    from public.crates c
    join public.members m on m.user_id = c.owner_id
    left join lateral (
      select count(*)::int as track_count,
             sum(coalesce(a.duration_ms, f.duration_ms, 0))::bigint as total_duration_ms
        from public.crate_items it
        join public.files f on f.id = it.file_id
        left join public.audio_analysis a on a.file_id = f.id
       where it.crate_id = c.id
         and f.state = any (public.pool_visible_states())
    ) ci on true
    left join lateral (
      -- The inner ordered LIMIT is what makes this cheap: four rows are
      -- collected per crate, then aggregated. array_agg over an ordered
      -- subquery, never `array_agg(... order by ...) limit 4`, which would
      -- aggregate the whole crate and then throw all but one row away.
      select array_agg(t.file_id) as file_ids
        from (
          select it.file_id
            from public.crate_items it
            join public.files f on f.id = it.file_id
            join public.audio_analysis a on a.file_id = f.id
           where it.crate_id = c.id
             and f.state = any (public.pool_visible_states())
             and a.thumb_key is not null
           order by it.position
           limit 4
        ) t
    ) art on true
   where c.owner_id = auth.uid() or c.is_public;
end $$;

revoke execute on function public.crate_list() from public, anon;
grant  execute on function public.crate_list() to authenticated;

comment on function public.crate_list() is
  'Every crate the caller owns, plus every public crate from any owner.
   is_mine flags the caller''s own rows; a private crate never appears for
   anyone else. track_count/total_duration_ms count pool-visible items
   only, so a card can never disagree with what opening the crate shows.
   art_file_ids (migration 35) is up to four ARTWORKED file ids in crate
   position order, for the card''s stacked-sleeve artwork; never null.';

-- ------------------------------------------------------------
-- feed_new_crates -- migration 31's body, plus art_file_ids. The lateral
-- is byte-identical to crate_list()'s above, deliberately: the two cards
-- are the same object drawn on two pages.
-- ------------------------------------------------------------
drop function if exists public.feed_new_crates(int);

create or replace function public.feed_new_crates(p_limit int default 8)
returns table (
  id                uuid,
  name              text,
  owner_name        text,
  track_count       bigint,
  total_duration_ms bigint,
  made_public_at    timestamptz,
  art_file_ids      uuid[]
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
           c.made_public_at,
           coalesce(art.file_ids, '{}'::uuid[])                as art_file_ids
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
      left join lateral (
        select array_agg(t.file_id) as file_ids
          from (
            select it.file_id
              from public.crate_items it
              join public.files f on f.id = it.file_id
              join public.audio_analysis a on a.file_id = f.id
             where it.crate_id = c.id
               and f.state = any (public.pool_visible_states())
               and a.thumb_key is not null
             order by it.position
             limit 4
          ) t
      ) art on true
     where c.is_public
     order by c.made_public_at desc nulls last, c.id
     limit v_limit;
end $$;

revoke execute on function public.feed_new_crates(int) from public, anon;
grant  execute on function public.feed_new_crates(int) to authenticated;

comment on function public.feed_new_crates(int) is
  'Public crates, newest made_public_at first (never created_at -- that
   never changes). owner_name, the track_count/total_duration_ms lateral
   and the art_file_ids lateral are copied verbatim from crate_list()
   (migrations 27 and 35) so the two never disagree on what a crate card
   shows.';
