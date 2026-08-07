-- supabase/migrations/20260807100100_33_upload_delete.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- "Give the user who uploaded the track the option to delete their upload."
--
-- WHAT IS DELETED IS THE FILE, NOT THE RECORDING. A member owns the bytes
-- they contributed, not the identity those bytes happen to name. If the
-- file's track carries other live files (a dedup merge put them there),
-- the track survives with one fewer encode and the pool loses nothing it
-- was serving. If the deleted file was the track's only file, the track
-- has no visible member left and disappears from every surface -- the pool
-- table, the feed, search, other members' crates.
--
-- THE ROW BECOMES A TOMBSTONE, NOT A HOLE. `state` moves to 'deleted', a
-- new terminal state. The R2 object is deleted for real by the route that
-- calls this (the bytes are gone and cannot come back), but the row stays:
--   * file_claims stays, so member_storage()'s `contributed` -- the social
--     "what have I brought to the pool" number -- never decreases. PRD 10
--     rejected a shrinking contribution count and this must not reintroduce
--     it by the back door.
--   * credit_grants is never touched by anything here.
--   * track_stats, likes, play_events and file_tags stay. They are the
--     record of what happened, and nothing renders them once the file is
--     invisible.
--   * my_files() keeps returning the row, so /uploads still shows the
--     uploader their own history with 'deleted' beside it. That is the one
--     surface where a tombstone is the point rather than a leak.
-- Deleting the row instead would take file_claims with it (ON DELETE
-- CASCADE, migration 06) and silently rewrite history.
--
-- WHY NOT A DELETED_AT COLUMN. Every visibility predicate in this schema
-- already reads `files.state`, most of them through pool_visible_states().
-- A second, parallel axis of invisibility would mean auditing all of them
-- again and getting one wrong. A new state is invisible to every existing
-- positive filter on day one, for free -- see the audit block below.
--
-- ONLY A 'stored' FILE IS DELETABLE. A pending or uploading one is
-- abandoned through /api/upload/abort; a failed, abandoned, quarantined or
-- rejected_* one already holds no bytes anyone can reach and the
-- maintenance Worker's reconcile already owns its object. 'received' and
-- 'analysing' are mid-pipeline: the analysis container is holding the key
-- and a delete underneath it would surface as an unexplained worker
-- failure. 'needs_review' belongs to the owner's review queue, not to the
-- uploader. So: 'stored', and a clear refusal everywhere else.
-- ============================================================


-- ============================================================
-- 1. The state machine gains a terminal state.
--
-- The CHECK is a literal in-list, not pool_visible_states(): a CHECK runs
-- under the WRITING role's privileges, so a function reference there would
-- need EXECUTE granted to every writer. Migration 06 says so; this keeps
-- its shape and only adds the value.
-- ============================================================
alter table public.files drop constraint files_state_check;
alter table public.files add constraint files_state_check
  check (state in ('pending','uploading','received','analysing','stored',
                   'needs_review','rejected_duration','rejected_redundant',
                   'quarantined','failed','abandoned','deleted'));

comment on column public.files.state is
  '''deleted'' is TERMINAL and one-way: upload_delete() is the only writer
   and ingest_set_state() -- the only place files.state is ever written --
   has no transition out of it, because no from-array in this schema names
   it. The R2 object is gone; the row survives so file_claims (and
   therefore member_storage()''s ''contributed'') never shrinks.';


-- ============================================================
-- 2. THE VISIBILITY AUDIT. Every live predicate that reads files.state,
--    and what 'deleted' does to it. This is the load-bearing part: one
--    missed filter puts a dead file into a queue that then 404s.
--
-- EXCLUDED FOR FREE -- positive filters that name the states they want:
--   pool_list            `t.state = 'stored'`      <- ALSO the auto-queue's
--                        candidate source (/api/queue/candidates calls
--                        pool_list, deliberately: see that route's header).
--   pool_uploaders       `t.state = 'stored'`
--   feed_tracks          four `state = 'stored'` predicates, and every row
--                        it returns is pool_get(file_id) anyway
--   member_resolve       `f.state = 'stored'` (track_count)
--   dedup_pending        `f.state = 'stored'`
--   dedup_seed_tracks    `f.state = 'stored'`
--   dedup_assign_track   raises unless `v_state = 'stored'`
--   analysis_requeue     `f.state = 'stored'`
--   dedup_exact          pool_visible_states()  <- the matcher's layer 0
--   dedup_candidates     pool_visible_states()  <- the matcher's layer 1
--   crate_get/crate_list/crate_add/crate_reorder   pool_visible_states()
--   toggle_like/bump_play/bump_download            pool_visible_states()
--   feed_new_crates      pool_visible_states()
--   analysis_stuck       `state in ('received','analysing')` -- the
--                        maintenance Worker can never re-enqueue a tombstone
--   ingest_abandon_stale `state in ('pending','uploading')`
--   member_storage       states_holding_bytes() for `occupying` (the bytes
--                        really are gone); NO filter for `contributed`, on
--                        purpose and unchanged
--   search_tracks        migration 32 reuses pool_list's predicate verbatim
--   every upload route   presign/parts/complete gate on pending|uploading,
--                        and ingest_set_state has no from-array naming
--                        'deleted', so a tombstoned key can never be
--                        re-uploaded to
--
-- FIXED BELOW -- the two predicates with an uploader/owner escape hatch,
-- which is exactly where a positive filter stops protecting you:
--   pool_get      `... or t.uploaded_by = auth.uid() or is_owner()` would
--                 have kept rendering /track/<id> for the person who just
--                 deleted it, with a player that 409s and a delete button
--                 that errors. Section 3.
--   review_queue  joins pool_tracks with no state filter at all, so a
--                 deleted file's pair would sit in the owner's queue with a
--                 dead preview and a verdict that can no longer act.
--                 Section 4.
--
-- DELIBERATELY UNCHANGED:
--   my_files      no state filter, whole history. The tombstone shows, and
--                 src/lib/file-state.ts labels it.
--   the `members read pool files` RLS policy on files. Its uploader/owner
--     clause still exposes the tombstone ROW to its own uploader over
--     PostgREST. That row carries no bytes and no capability, one app call
--     site reads files directly (loadOwnedJob, which every upload route
--     then gates on pending|uploading), and my_files needs the history
--     anyway. Narrowing it would buy nothing and could hide a row from the
--     person entitled to see it.
--   crate_items   NOT deleted. See section 5.
-- ============================================================


-- ============================================================
-- 3. pool_get -- migration 28's body, verbatim, plus one predicate.
--
-- Migration 20's standing rule: anything redefining pool_get must extend
-- migration 20's body, keep `provenance`, and never re-grant raw_tags.
-- This is a copy of migration 28's definition with `t.state <> 'deleted'`
-- added and nothing else touched; provenance_from_tags() still does the
-- projecting and raw_tags still never leaves the database.
--
-- The predicate sits OUTSIDE the visible-or-mine-or-owner group on
-- purpose. 'deleted' beats the uploader exception: migration 16b added
-- that exception so an uploader could read their own FAILED upload's
-- diagnosis, and a file the uploader deliberately destroyed has no
-- diagnosis to read. /track/<id> 404s for everyone, including them.
--
-- DROP + CREATE per the 42P13 rule (15b precedent), even though the
-- signature is unchanged -- the same shape migrations 20, 26 and 28 used.
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
     and t.state <> 'deleted'
     and ( t.state = any (public.pool_visible_states())
           or t.uploaded_by = (select auth.uid())
           or public.is_owner() );
end $$;

revoke execute on function public.pool_get(uuid) from public, anon;
grant  execute on function public.pool_get(uuid) to authenticated;

comment on function public.pool_get(uuid) is
  'One row for the track page. Migration 28''s body (migration 26''s column
   list with migration 20''s raw_tags->provenance swap) plus migration 33''s
   `state <> ''deleted''`, which sits OUTSIDE the visible-or-mine-or-owner
   group: a tombstone is invisible to its own uploader and to the owner
   too, so /track/<id> 404s for everyone once the bytes are gone.';


-- ============================================================
-- 4. review_queue -- migration 30's body, plus the same exclusion.
--
-- It joins pool_tracks twice with no state filter at all, so today a
-- deleted file's pair would still be listed for the owner, with a preview
-- key pointing at nothing and a 'same' verdict that dedup_assign_track can
-- no longer act on (it requires 'stored' and answers "a file on this pair
-- has no track identity"). Excluding the tombstone on both sides is a
-- no-op against every row that exists today.
-- ============================================================
create or replace function public.review_queue(
  p_limit int default 50, p_status text default 'pending',
  p_decision_id bigint default null
)
returns table (
  decision_id       bigint,
  score             real,
  band              text,
  layer             text,
  shared_items      int,
  overlap_frames    int,
  duration_delta_ms int,
  per_second_ber    real[],
  decided_at        timestamptz,
  probe_file_id     uuid,
  probe_artist      text,
  probe_title       text,
  probe_filename    text,
  probe_uploader    text,
  probe_tier        smallint,
  probe_container   text,
  probe_duration_ms int,
  probe_kbps        int,
  probe_preview_key text,
  cand_file_id      uuid,
  cand_artist       text,
  cand_title        text,
  cand_filename     text,
  cand_uploader     text,
  cand_tier         smallint,
  cand_container    text,
  cand_duration_ms  int,
  cand_kbps         int,
  cand_preview_key  text,
  verdict           text,
  reviewed_at       timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with live as (
    select distinct on (least(d.probe_file_id, d.candidate_file_id),
                        greatest(d.probe_file_id, d.candidate_file_id))
           d.*
      from public.match_decisions d
      -- Live thresholds, not the frozen label (migration 30).
      join public.dedup_config g on g.algo_version = d.algo_version
     where d.superseded_at is null
       and d.score >= g.t_probable
       and d.score <  g.t_same
     order by least(d.probe_file_id, d.candidate_file_id),
              greatest(d.probe_file_id, d.candidate_file_id),
              d.score desc, d.id desc
  ), answered as (
    select least(d2.probe_file_id, d2.candidate_file_id)    as lo,
           greatest(d2.probe_file_id, d2.candidate_file_id) as hi,
           r.verdict, r.decided_at
      from public.review_actions r
      join public.match_decisions d2 on d2.id = r.decision_id
  )
  select l.id, l.score,
         -- The band the row is being shown under NOW, so the page never
         -- displays a label that contradicts why the row is in front of you.
         'probable'::text,
         l.layer, l.shared_items, l.overlap_frames,
         l.duration_delta_ms, l.per_second_ber, l.decided_at,
         p.file_id, p.display_artist, p.display_title, p.original_filename,
         p.uploader_name, p.quality_tier, p.container, p.duration_ms,
         case when coalesce(p.duration_ms, 0) > 0
              then (p.byte_size * 8 / p.duration_ms)::int end,
         p.preview_key,
         c.file_id, c.display_artist, c.display_title, c.original_filename,
         c.uploader_name, c.quality_tier, c.container, c.duration_ms,
         case when coalesce(c.duration_ms, 0) > 0
              then (c.byte_size * 8 / c.duration_ms)::int end,
         c.preview_key,
         a.verdict, a.decided_at
    from live l
    join public.pool_tracks p on p.file_id = l.probe_file_id
    join public.pool_tracks c on c.file_id = l.candidate_file_id
    left join answered a
      on a.lo = least(l.probe_file_id, l.candidate_file_id)
     and a.hi = greatest(l.probe_file_id, l.candidate_file_id)
   where case coalesce(p_status, 'pending')
           when 'pending'  then a.verdict is null
           when 'resolved' then a.verdict is not null
           else true
         end
     and (a.verdict is not null
          or public.canonical_track_id(p.track_id)
               is distinct from public.canonical_track_id(c.track_id))
     and (p_decision_id is null or l.id = p_decision_id)
     -- Migration 33: a tombstone has no object to preview and no identity
     -- to merge. Its pair leaves the queue in both directions.
     and p.state <> 'deleted'
     and c.state <> 'deleted'
   order by l.score desc, l.id desc
   limit greatest(least(coalesce(p_limit, 50), 200), 1);
end $$;

revoke execute on function public.review_queue(int, text, bigint)
  from public, anon, service_role;
grant  execute on function public.review_queue(int, text, bigint) to authenticated;


-- ============================================================
-- 5. upload_delete -- the whole operation, in one transaction.
--
-- AUTHORISATION IS IN THE BODY, never in a caller-supplied filter: the
-- uploader of this exact file, or the platform owner. Same discipline as
-- my_files() and upload_batch_status().
--
-- THE ADVISORY LOCK is the same one merge_tracks(), dedup_resolve() and
-- review_resolve() take. A delete re-elects a preferred file; a merge
-- re-points files at a new track. Interleaved without the lock, the merge
-- could move a file onto the track a delete is halfway through emptying.
--
-- THE TRACK FOLD, in full:
--   * The file's track is resolved through canonical_track_id() first, so
--     a merged-away identity is never the one examined.
--   * Every tracks row whose preferred_file_id names this file is
--     re-elected -- not only the canonical one. merge_tracks() leaves the
--     loser row in place with its own pointer, and undo_merge() restores
--     from track_merges, so a stale pointer at a tombstone would outlive
--     the delete.
--   * The election reuses the quality data keep-if-better already ranks on
--     (audio_analysis.quality_score, then quality_tier), NULLS LAST so a
--     file with no forensics never outranks one that has them -- the same
--     rule dedup_is_upgrade() encodes as "absence of evidence is not an
--     upgrade". Ties break on created_at then id: the oldest arrival wins,
--     which is the survivor rule dedup_resolve() and review_resolve()
--     already share.
--   * The candidate pool is that track's own pool_visible_states() files,
--     minus the one being deleted. If none remain, the pointer goes NULL
--     and the track is empty -- kept, not deleted, because track_relations,
--     match_decisions and track_merges all reference it and every reader
--     already tolerates a track with no visible file (feed_tracks skips it,
--     pool_list never produced it).
--
-- CRATES: NOTHING HAPPENS TO crate_items, ON PURPOSE. Chosen over deleting
-- the rows because it is the option that keeps crate pages rendering
-- correctly with no new code and no cross-member write:
--   * crate_get() filters `f.state = any (pool_visible_states())`, so the
--     item is already invisible in every crate that holds it, including
--     other members';
--   * crate_list()'s track_count/total_duration_ms apply the identical
--     filter, so the card's count never disagrees with the open crate;
--   * crate_reorder() was written (migration 27, fix I1b) to renumber
--     hidden items past the visible run rather than compare them, so a
--     crate holding a tombstone still reorders instead of 22023-ing
--     forever;
--   * crate_add() refuses a non-pool-visible file, so it cannot come back.
-- Deleting the rows would instead mean one member's action silently
-- editing another member's saved crate, and would renumber positions the
-- curator chose. The tombstone is invisible either way; only one of the
-- two options is also non-destructive.
--
-- content_sha256 IS CLEARED. It is UNIQUE, and analysis_persist() refuses
-- to write a digest another row already holds -- so a tombstone keeping
-- its hash would leave the NEXT upload of those bytes with a permanently
-- NULL content_sha256 and no layer-0 dedup, forever. The digest is a
-- live-corpus key, not an audit record; the acoustic identity survives in
-- fingerprints and the forensics in audio_analysis, both untouched.
--
-- RETURNS the r2_key so the route can delete the object, plus enough of
-- the outcome to say what happened. The object delete is deliberately NOT
-- attempted here: this function has no network, and a tombstone whose
-- object outlives it is a state the nightly reconcile already understands
-- (workers/maintenance/src/reconcile.ts lists 'deleted' as safe to sweep).
-- ============================================================
create or replace function public.upload_delete(p_file_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uploader  uuid;
  v_state     text;
  v_r2_key    text;
  v_track     uuid;
  v_new_pref  uuid;
  v_reelected int := 0;
  v_remaining int := 0;
  r           record;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_file_id is null then
    raise exception 'upload_delete: no file id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('localchune.track_assign'));

  select f.uploaded_by, f.state, f.r2_key, f.track_id
    into v_uploader, v_state, v_r2_key, v_track
    from public.files f
   where f.id = p_file_id
     for update;

  if v_uploader is null then
    raise exception 'unknown file %', p_file_id using errcode = 'P0002';
  end if;

  -- Uploader-only, plus the platform owner. Checked BEFORE the state
  -- check, so a stranger probing file ids learns nothing about their state.
  if v_uploader <> (select auth.uid()) and not public.is_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_state = 'deleted' then
    raise exception 'this upload is already deleted' using errcode = 'P0001';
  end if;
  if v_state <> 'stored' then
    raise exception 'only a stored upload can be deleted (this one is %)', v_state
      using errcode = 'P0001';
  end if;

  -- Resolve the identity BEFORE the state moves, through the merge chain.
  v_track := public.canonical_track_id(v_track);

  -- ingest_set_state() is the only writer of files.state anywhere in this
  -- schema, and it is granted to nobody -- reachable only from a definer
  -- function like this one. It raises P0001 on an illegal transition, so
  -- the 'stored' check above is belt to its braces.
  perform public.ingest_set_state(p_file_id, array['stored'], 'deleted');

  update public.files f set content_sha256 = null where f.id = p_file_id;

  -- ---- re-elect every pointer that named this file ----
  for r in
    select t.id from public.tracks t where t.preferred_file_id = p_file_id
  loop
    select f.id into v_new_pref
      from public.files f
      left join public.audio_analysis a on a.file_id = f.id
     where f.track_id = r.id
       and f.id <> p_file_id
       and f.state = any (public.pool_visible_states())
     order by a.quality_score desc nulls last,
              a.quality_tier  desc nulls last,
              f.created_at, f.id
     limit 1;

    update public.tracks t set preferred_file_id = v_new_pref where t.id = r.id;
    v_reelected := v_reelected + 1;
  end loop;

  if v_track is not null then
    select count(*) into v_remaining
      from public.files f
     where f.track_id = v_track
       and f.id <> p_file_id
       and f.state = any (public.pool_visible_states());
  end if;

  return jsonb_build_object(
    'ok',             true,
    'file_id',        p_file_id,
    'r2_key',         v_r2_key,
    'track_id',       v_track,
    'track_survives', (v_track is not null and v_remaining > 0),
    'remaining_files', v_remaining,
    'reelected',      v_reelected);
end $$;

revoke execute on function public.upload_delete(uuid)
  from public, anon, service_role;
grant  execute on function public.upload_delete(uuid) to authenticated;

comment on function public.upload_delete(uuid) is
  'Tombstones one stored file: state -> ''deleted'' (terminal),
   content_sha256 cleared, every tracks.preferred_file_id that named it
   re-elected to the track''s best remaining pool-visible file (quality_score
   then quality_tier, NULLS LAST, oldest wins ties) or NULL. Uploader or
   is_owner() only, checked in the body; 42501 otherwise, P0002 for an
   unknown id, P0001 for any state but ''stored''. file_claims,
   credit_grants, track_stats, likes, play_events, file_tags and
   crate_items are all left alone -- ''contributed'' never decreases and
   crate_get/crate_list already filter the tombstone out. Returns the
   r2_key so the caller can delete the object.';
