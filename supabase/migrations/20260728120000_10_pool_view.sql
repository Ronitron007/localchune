-- supabase/migrations/20260728120000_10_pool_view.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- audio_analysis: the parts M3 Task 9's draft left out.
--
-- 1. It enables RLS and grants nothing. RLS filters rows only AFTER the
--    table-level ACL check passes, so with no grant `authenticated` gets
--    42501 "permission denied for table" on every join -- the policy is
--    dead code. Migrations 01 and 06 carry the same warning.
-- 2. It has no column for the derived-artifact keys, although
--    workers/analysis/src/index.ts already writes those objects to
--    derived/<file_id>/<name>. Nothing recorded the name, so nothing could
--    ever find them again. M3 Task 9's persist() must populate these three.
--
-- Everything here is idempotent, so whichever milestone lands first wins and
-- the other is a no-op.
-- ============================================================

alter table public.audio_analysis add column if not exists preview_key text;
alter table public.audio_analysis add column if not exists peaks_key   text;
alter table public.audio_analysis add column if not exists artwork_key text;
alter table public.audio_analysis add column if not exists thumb_key text;

comment on column public.audio_analysis.preview_key is
  'Basename of the Opus preview inside derived/<file_id>/. NULL means no
   preview exists and the player must stream the original -- which is the
   correct behaviour for an mp3 and the fallback behaviour for a FLAC.';
comment on column public.audio_analysis.peaks_key is
  'Basename of the peaks JSON inside derived/<file_id>/. NULL means the
   waveform renders flat. Immutable per file, so it is served with a
   one-year cache-control.';
comment on column public.audio_analysis.thumb_key is
  'Basename of the 64px cover thumbnail inside derived/<file_id>/. NULL
   means the file was analysed before the thumb task landed (or has no
   embedded art) and the row renders a bordered empty box instead.';

-- The policy reads public.files, NOT public.audio_analysis -- a policy on X
-- that selects from X raises 42P17. Referencing files is safe and is the
-- point: files' own RLS runs inside this subquery, so analysis is visible
-- exactly when its file is, with no second copy of the visibility rule.
drop policy if exists "members read analysis for visible files" on public.audio_analysis;
create policy "members read analysis for visible files"
  on public.audio_analysis for select to authenticated
  using (
    (select public.is_active_member())
    and exists (select 1 from public.files f where f.id = audio_analysis.file_id)
  );

grant select on public.audio_analysis to authenticated;
grant select, insert, update, delete on public.audio_analysis to service_role;

-- ============================================================
-- Display helpers. raw_tags is the title/artist source until M7, and it is
-- routinely absent or junk -- 1,388 of 2,122 genres empty in the Rekordbox
-- export the PRD measured, and tags are no better. The filename fallback
-- lives HERE rather than in TypeScript because server-side search and sort
-- must operate on the same strings the table renders; derive them twice and
-- searching for an artist stops finding the row that displays it.
--
-- EXECUTE is revoked from every client role and granted to none. These are
-- reached only from the view, which is itself reached only from the
-- SECURITY DEFINER functions in Task 3 -- all owned by postgres, which can
-- execute its own functions. Migration 07's ingest_set_state() uses the same
-- "granted to nobody" pattern. Note that Postgres grants EXECUTE to PUBLIC
-- by default on every new function, so the REVOKE is not optional.
-- ============================================================

-- First non-empty value among the given keys, in the order given.
-- `with ordinality` + `order by` is load-bearing: unnest() makes no promise
-- about row order, so a bare `limit 1` could return the wrong tag.
create or replace function public.tag_value(p_tags jsonb, variadic p_keys text[])
returns text language sql immutable set search_path = '' as $$
  select t.v
    from unnest(p_keys) with ordinality as k(name, ord)
    cross join lateral (select nullif(btrim(p_tags ->> k.name), '') as v) t
   where t.v is not null
   order by k.ord
   limit 1;
$$;
revoke execute on function public.tag_value(jsonb, text[]) from public, anon, authenticated;

create or replace function public.filename_stem(p_name text)
returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(coalesce(p_name, ''), '\.[A-Za-z0-9]{1,5}$', ''));
$$;
revoke execute on function public.filename_stem(text) from public, anon, authenticated;

-- 'Artist - Title.flac' is the near-universal DJ filename. Anything without
-- a ' - ' has no artist to guess, and guessing one is worse than showing
-- none: NULL renders as "Unknown artist", which is honest.
create or replace function public.display_artist(p_tags jsonb, p_filename text)
returns text language sql immutable set search_path = '' as $$
  with s as (select public.filename_stem(p_filename) as stem)
  select coalesce(
           public.tag_value(p_tags, 'artist', 'ARTIST', 'TPE1',
                                    'albumartist', 'ALBUMARTIST'),
           case when position(' - ' in s.stem) > 0
                then nullif(btrim(left(s.stem, position(' - ' in s.stem) - 1)), '')
           end)
    from s;
$$;
revoke execute on function public.display_artist(jsonb, text) from public, anon, authenticated;

-- Title always resolves to something: worst case the filename stem, which
-- is what the uploader called it and is never empty for a real upload.
create or replace function public.display_title(p_tags jsonb, p_filename text)
returns text language sql immutable set search_path = '' as $$
  with s as (select public.filename_stem(p_filename) as stem)
  select coalesce(
           public.tag_value(p_tags, 'title', 'TITLE', 'TIT2'),
           case when position(' - ' in s.stem) > 0
                then nullif(btrim(substr(s.stem, position(' - ' in s.stem) + 3)), '')
           end,
           s.stem)
    from s;
$$;
revoke execute on function public.display_title(jsonb, text) from public, anon, authenticated;

-- The harmonically compatible set: one step either way around the wheel in
-- the same mode, plus the relative major/minor. The modular arithmetic is
-- the whole reason Camelot notation exists -- 12 and 1 are ADJACENT, and an
-- implementation that treats the number as an ordinary integer silently
-- drops the wraparound and mixes badly at exactly one point on the wheel.
create or replace function public.camelot_neighbours(p_key text)
returns text[] language plpgsql immutable set search_path = '' as $$
declare
  v_key text := upper(btrim(coalesce(p_key, '')));
  v_num int;
  v_let text;
begin
  if v_key !~ '^([1-9]|1[0-2])[AB]$' then
    return null;
  end if;
  v_num := left(v_key, length(v_key) - 1)::int;
  v_let := right(v_key, 1);
  return array[
    v_num::text                     || v_let,
    ((v_num % 12) + 1)::text        || v_let,
    (((v_num + 10) % 12) + 1)::text || v_let,
    v_num::text                     || (case when v_let = 'A' then 'B' else 'A' end)
  ];
end $$;
revoke execute on function public.camelot_neighbours(text) from public, anon, authenticated;

-- ============================================================
-- The view.
--
-- SECURITY_INVOKER IS DELIBERATELY OFF and the view is granted to NO role.
-- It runs as its owner (postgres), which owns every underlying table and
-- therefore bypasses their RLS. That is safe only because nothing can reach
-- it: the visibility gate lives in the SECURITY DEFINER functions in Task 3,
-- exactly as migration 08's member_storage() documents for the same reason.
--
-- The alternative -- security_invoker = true, granted to authenticated --
-- looks safer and is worse. members' RLS ("members read own row") would then
-- hide every other member's row, so `uploader_name` would render blank for
-- every track except your own, with no error anywhere.
--
-- Supabase's `security_definer_view` advisor will flag this view. The
-- finding is accepted: a view with zero grants is unreachable by anon and
-- authenticated alike.
-- ============================================================
create or replace view public.pool_tracks as
select
  f.id                                       as file_id,
  f.track_id,
  f.batch_id,
  f.uploaded_by,
  split_part(m.email, '@', 1)                as uploader_name,
  f.original_filename,
  -- Exposed for pool_get() only, so the signed-GET routes need not
  -- re-derive the key that ingest_begin() minted. pool_list() does not
  -- return it: a list of 100 object keys is 100 things the browser has no
  -- use for.
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
  -- ---------------------------------------------------------------
  -- Sort keys. EVERY sort in this application is an ASCENDING scan of
  -- one of these text columns, so there is one cursor format, one keyset
  -- predicate, and no NULLS FIRST/LAST reasoning anywhere: an unknown
  -- value maps to a high sentinel string and therefore sorts last.
  -- A descending sort is encoded by subtracting from a constant, not by
  -- flipping ORDER BY.
  --
  -- COLLATE "C" on all six is not decoration. A CASE whose branches carry
  -- different collations raises 42P22 "could not determine which collation
  -- to use" -- at RUNTIME, from the CASE in pool_list() that picks one of
  -- these. Pinning all six to C also makes the keyset order byte-stable,
  -- which is what a cursor needs.
  -- ---------------------------------------------------------------
  ((lpad((99999999999999::bigint
          - (extract(epoch from f.created_at) * 1000)::bigint)::text, 14, '0')
   ) collate "C")                            as sk_added,
  ((case when a.bpm is null or a.bpm <= 0 then '99999999'
         else lpad(((a.bpm * 100)::int)::text, 8, '0') end) collate "C")
                                             as sk_bpm,
  ((lpad(d.camelot_sort::text, 3, '0')) collate "C")
                                             as sk_key,
  -- '~' (0x7E) sorts after every letter and digit in the C collation, so an
  -- untitled upload lands at the end rather than at the top.
  ((lower(coalesce(d.display_artist, '~'))) collate "C")
                                             as sk_artist,
  ((case when coalesce(a.duration_ms, f.duration_ms, 0) <= 0 then '99999999'
         else lpad(coalesce(a.duration_ms, f.duration_ms)::text, 8, '0') end) collate "C")
                                             as sk_duration,
  (((9 - coalesce(a.quality_tier, 0))::text) collate "C")
                                             as sk_tier
from public.files f
join public.audio_analysis a on a.file_id = f.id
join public.members m        on m.user_id  = f.uploaded_by
cross join lateral (
  select
    -- The cue-tracks composite sort (FileList.tsx:120-125), in SQL.
    -- Lexicographic ordering puts '10A' before '2A'; this is the fix.
    -- Mirrored by camelotSortKey() in src/lib/track-format.ts.
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
   functions in migration 11, which own the visibility gate. Do NOT grant
   this to authenticated: it runs as its owner and bypasses RLS.';
