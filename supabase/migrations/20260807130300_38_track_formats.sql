-- supabase/migrations/20260807130300_38_track_formats.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- track_formats(uuid) -- EVERY ENCODE OF ONE RECORDING, for /track/[id].
--
-- OWNER, 2026-08-08, verbatim: "what about the format and file system...
-- I still see repeats...no way to select the format to play....instead
-- what should happen is each track detail page should show all the
-- different formats available."
--
-- The two halves of that sentence are one design. Migration 37 collapsed
-- the browse surfaces to one row per RECORDING, and this branch finished
-- that rollout onto /artist and /member. Collapsing is only honest if the
-- encodes it hides stay reachable, and migration 37's own header already
-- promised where: "the other encodes stay reachable: /track/[id] lists
-- them (see the app)". They did not. This is that list.
--
-- ============================================================
-- WHY A NEW FUNCTION AND NOT A WIDER pool_get
-- ============================================================
--
-- pool_get(uuid) answers "tell me about THIS file" and returns one row of
-- 46 columns. The question here is "which files are the same recording as
-- this one", whose answer is 0..n rows of a DIFFERENT, much narrower
-- shape. Folding it into pool_get would mean either an array-of-jsonb
-- column on a function migrations 20 and 28 fought to keep narrow, or a
-- second call anyway. It is a second call either way, so it is a second
-- function with its own grant.
--
-- It is also the only place in the app that needs files.codec,
-- files.sample_rate, files.bit_depth and files.channels. pool_tracks does
-- not carry them -- it never needed to, because no surface showed them --
-- so this function joins public.files directly for those four and takes
-- everything else off pool_tracks, which is where the display_* fallbacks
-- and the visibility rules already live.
--
-- ============================================================
-- WHAT IT REFUSES TO RETURN
-- ============================================================
--
--   raw_tags   Migration 20's standing rule, restated by 28 and 31: the
--              embedded tag blob never leaves the database. An iTunes
--              file's raw_tags carry buyer identity (apID, ownr, xid).
--              This function has no tag column at all -- not even
--              provenance_from_tags() -- because a format list has no use
--              for one.
--   r2_key     Nothing here presigns. Play and download both go through
--              the routes that already exist (/api/track/:id/source and
--              /api/track/:id/download), and both call pool_get for
--              themselves. A key on this row would be a second path to
--              the bytes with no second reason for one.
--
-- ============================================================
-- VISIBILITY: 'stored', AND THE SEED USES THE SAME TEST
-- ============================================================
--
-- `state = 'stored'` is pool_list's predicate verbatim. It excludes
-- migration 33's tombstones (state 'deleted'), everything mid-pipeline,
-- and every rejected/quarantined/failed file. There is deliberately NO
-- uploader exception of the kind pool_get carries: pool_get has one so an
-- uploader can read their own FAILED upload's diagnosis, and a format
-- list is not a diagnosis. The page only renders this section for a
-- 'stored' file anyway (its transport block is gated the same way), so the
-- two agree.
--
-- The SEED is tested the same way, which is what makes this safe to call
-- with a uuid off the URL: a file the caller may not see resolves to no
-- track and the function returns zero rows. It never says "that file
-- exists but is not yours" and it never leaks a track id.
--
-- A TRACKLESS FILE IS ITS OWN RECORDING. `files.track_id` is null until
-- the dedup backstop reaches a freshly stored file (migration 34), and
-- that window is hours, not seconds. Such a file returns exactly itself,
-- marked as the face -- the same survival rule `track_id is null or
-- file_id = track_face_file(track_id)` gives it on every collapsed
-- surface. Rendering nothing for it would make the section blink out for
-- every new upload.
--
-- ============================================================
-- is_face, AND WHY track_face_file() IS STILL NOT GRANTED
-- ============================================================
--
-- Migration 34 revoked track_face_file(uuid) from public, anon and
-- authenticated and granted it to service_role alone. That is unchanged
-- and must stay unchanged. This function is SECURITY DEFINER, so its body
-- runs as the owner and can call it; the caller cannot. `is_face` is that
-- one call, surfaced as a boolean, which is exactly the amount of the rule
-- a page needs: it labels the row "preferred" and it sorts that row first.
-- The pgTAP re-proves the 42501 from the member's side rather than
-- assuming migration 34 still holds, for the same reason migration 37's
-- did.
--
-- ============================================================
-- THE ORDER IS THE SERVER'S, ONCE
-- ============================================================
--
--   is_face desc, quality_tier desc, average bitrate desc,
--   created_at desc, file_id
--
-- Preferred first, then best-quality first, then deterministic. The client
-- does not re-sort: two sorts of one list is how two surfaces come to
-- disagree about which encode is "best".
--
-- THE BITRATE IS INFERRED AND IT IS NOT A COLUMN. Migration 21 dropped
-- files.bitrate_kbps and said why: the only available number is the
-- DECLARED bitrate, and declared bitrate lies -- a 128 kbps transcode
-- remuxed as 320 still declares 320. Nothing here re-adds it. The sort
-- uses `byte_size / duration_ms`, which is arithmetic over two numbers
-- that are already true: real bytes counted, real duration measured. It
-- is an AVERAGE over the whole container (tag block and embedded artwork
-- included), so it is approximate, and the app labels it approximate. It
-- is returned as nothing at all -- byte_size and duration_ms are the
-- columns, and src/lib/track-formats.ts does the division once so the
-- figure a member reads and the figure this ORDER BY used come from the
-- same two numbers.
--
-- ============================================================
-- REVOKE FIRST, THEN GRANT (CLAUDE.md, migration 09). A hosted project's
-- ALTER DEFAULT PRIVILEGES has already granted EXECUTE to public and anon
-- by the time these lines run, so a bare grant is a no-op that leaves anon
-- holding it.
-- ============================================================

create or replace function public.track_formats(p_file_id uuid)
returns table (
  file_id           uuid,
  track_id          uuid,
  uploaded_by       uuid,
  uploader_name     text,
  original_filename text,
  display_artist    text,
  display_title     text,
  container         text,
  codec             text,
  sample_rate       int,
  bit_depth         int,
  channels          smallint,
  byte_size         bigint,
  duration_ms       int,
  bpm               real,
  key_camelot       text,
  key_open          text,
  key_musical       text,
  quality_tier      smallint,
  quality_score     real,
  lossy_ancestor    text,
  meas_cutoff_hz    int,
  created_at        timestamptz,
  is_face           boolean,
  is_current        boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_seen  boolean;
  v_track uuid;
  v_face  uuid;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The seed test IS the visibility test. A file the caller cannot see
  -- resolves to nothing, and the two "not visible" cases -- no such file,
  -- and a tombstoned one -- are the same empty answer.
  select true, t.track_id into v_seen, v_track
    from public.pool_tracks t
   where t.file_id = p_file_id
     and t.state = 'stored';
  if v_seen is not true then
    return;
  end if;

  -- Called ONCE, outside the row loop: it reads two tables, and a
  -- per-row call would re-read them for every encode of the recording.
  -- Null for a trackless file, which is why the is_face expression below
  -- has its own arm for that case rather than comparing against null.
  v_face := case when v_track is null then null
                 else public.track_face_file(v_track) end;

  return query
  select t.file_id, t.track_id, t.uploaded_by, t.uploader_name,
         t.original_filename, t.display_artist, t.display_title,
         t.container, f.codec, f.sample_rate, f.bit_depth, f.channels,
         t.byte_size, t.duration_ms, t.bpm,
         t.key_camelot, t.key_open, t.key_musical,
         t.quality_tier, t.quality_score, t.lossy_ancestor, t.meas_cutoff_hz,
         t.created_at,
         (v_track is null or t.file_id = v_face)   as is_face,
         (t.file_id = p_file_id)                   as is_current
    from public.pool_tracks t
    join public.files f on f.id = t.file_id
   where t.state = 'stored'
     and (case when v_track is null
               then t.file_id = p_file_id
               else t.track_id = v_track end)
   order by (v_track is null or t.file_id = v_face) desc,
            t.quality_tier desc nulls last,
            (t.byte_size::numeric / nullif(t.duration_ms, 0)) desc nulls last,
            t.created_at desc,
            t.file_id;
end $$;

revoke execute on function public.track_formats(uuid) from public, anon;
grant  execute on function public.track_formats(uuid) to authenticated;

comment on function public.track_formats(uuid) is
  'Every pool-visible file that is the same RECORDING as p_file_id -- the
   Formats list on /track/[id]. Visibility is pool_list''s, verbatim
   (state = ''stored''), applied to the SEED as well, so a file the caller
   may not see returns zero rows rather than an error. A trackless file
   (the dedup backstop has not reached it) returns exactly itself, marked
   is_face, matching the ''track_id is null'' survival arm every collapsed
   surface uses. is_face is track_face_file() (migration 34), reachable
   only because this body is SECURITY DEFINER -- that function stays
   revoked from authenticated. Ordered preferred-first, then quality_tier,
   then average bitrate (byte_size/duration_ms; migration 21 refuses to
   store a declared one), then newest, then file_id: the client must not
   re-sort. Returns no raw_tags and no r2_key -- migration 20''s rule, and
   nothing here presigns.';
