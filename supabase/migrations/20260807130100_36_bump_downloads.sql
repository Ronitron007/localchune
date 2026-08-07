-- supabase/migrations/20260807130100_36_bump_downloads.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- bump_downloads(uuid[]) -- the SET-AT-A-TIME form of migration 15b's
-- bump_download(uuid), for the crate download.
--
-- WHY THIS EXISTS. Downloading a crate takes every track in it at once. The
-- single-file function would mean one round trip per track -- 25 sequential
-- RPCs for an ordinary crate, 200 at the cap -- on the very request that is
-- also about to stream gigabytes. This is ONE statement, whatever the crate
-- holds.
--
-- IT IS THE SAME COUNTER, NOT A SECOND ONE. Same table, same semantics as
-- 15b: a counter and not idempotent (downloading a crate twice is two
-- downloads of each of its tracks), no ownership check (any active member's
-- download counts), and the one gate is visibility.
--
-- WHERE IT DIVERGES, AND WHY: bump_download RAISES P0002 on a file that is
-- not pool-visible; this SKIPS it. A single-file call names one file and the
-- caller asked about that file, so refusing is the honest answer. A batch
-- names a whole crate, and one tombstoned member (migration 33) must not
-- cost the other twenty-four their counts -- an all-or-nothing statement
-- would do exactly that. The caller cannot smuggle a hidden file in either
-- way: the join is the same pool_visible_states() filter, so a guessed uuid
-- is dropped rather than counted.
--
-- DUPLICATES ARE COUNTED, NOT COLLAPSED. p_files is aggregated to
-- (file_id, n) before the insert for two reasons. The correctness one:
-- ON CONFLICT DO UPDATE refuses to touch the same row twice in one
-- statement (21000, "cannot affect row a second time"), so a naive
-- multi-row insert would ERROR on a repeated id rather than count it. The
-- semantic one: two copies of a track in one archive really are two
-- downloads, and `+ excluded.download_count` says so.
-- ============================================================

create or replace function public.bump_downloads(p_files uuid[])
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_len  int;
  v_rows bigint;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- array_length is NULL for both '{}' and NULL, which is the whole empty
  -- case in one test. Zero rows bumped is a legal outcome, not an error:
  -- the route calls this before it knows whether every object still exists.
  v_len := array_length(p_files, 1);
  if v_len is null then
    return 0;
  end if;

  -- A ceiling well above the route's own 200-track cap (src/lib/crate-zip.ts).
  -- This is the database refusing to be the place an unbounded array lands,
  -- not a second product limit -- the route's message is the one a member
  -- ever sees.
  if v_len > 500 then
    raise exception 'bump_downloads: % files in one call is too many', v_len
      using errcode = '22023';
  end if;

  insert into public.track_stats (file_id, download_count)
  select c.file_id, c.n
    from (select u.file_id, count(*)::bigint as n
            from unnest(p_files) as u(file_id)
           where u.file_id is not null
           group by u.file_id) c
    join public.files f on f.id = c.file_id
   where f.state = any (public.pool_visible_states())
  on conflict (file_id) do update
    set download_count = public.track_stats.download_count + excluded.download_count;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- Revoke first. Hosted Supabase's ALTER DEFAULT PRIVILEGES hands `public`
-- and `anon` EXECUTE on a new function, so the grant below is only
-- meaningful after they are taken away -- see CLAUDE.md and migration 09.
revoke execute on function public.bump_downloads(uuid[]) from public, anon;
grant  execute on function public.bump_downloads(uuid[]) to authenticated;

comment on function public.bump_downloads(uuid[]) is
  'Set-at-a-time bump_download: one statement increments track_stats for
   every pool-visible file named in p_files, adding the number of times each
   id appears. Returns the number of rows actually bumped. Active members
   only (42501); a file not in pool_visible_states() is SKIPPED, not raised
   on, so one hidden member cannot fail a whole crate download. Refuses
   (22023) above 500 ids. Same counter and same non-idempotent semantics as
   bump_download(uuid).';
