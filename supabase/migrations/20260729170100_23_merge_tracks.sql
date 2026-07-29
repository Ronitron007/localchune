-- supabase/migrations/20260729170100_23_merge_tracks.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M4 Task 2, second half: the one collapse path, and its undo.
--
-- merge_tracks() is the ONLY way two identities ever become one -- the
-- matcher's automatic path (Task 6's dedup_resolve calls this rather than
-- re-pointing files.track_id itself) and the review queue's human path both
-- come through here, so there is one undo payload, one merges feed and one
-- reversal. A silent assignment with no track_merges row would be the one
-- collapse in the system nobody could notice or reverse, which is exactly
-- the risk PRD §15 names first: "wrong auto-merges destroy someone's
-- crates", mitigated by "merges reversible by design".
--
-- WHAT THE MERGE FOLDS, and why (plan amendment 1, from the pool-ux batch;
-- migrations 15b and 16 wrote the same carry into their own headers):
--   download_count  SUMMED onto the survivor. track_stats keys on file_id
--                   because the track identity did not exist when it was
--                   written; the owner's stated intent is that the count
--                   belongs to the TRACK, not the encode.
--   file_tags       UNIONED onto the survivor by tag_key, same reason.
--   file_claims     UNIONED onto the survivor and NEVER removed. PRD §10:
--                   contributed never decreases. This is the one fold the
--                   undo deliberately does not reverse.
--
-- Everything the undo needs is captured BEFORE anything moves and written
-- into the track_merges row. Reconstructing it afterwards is impossible:
-- once the merge has run there is nothing left that says which files moved,
-- which tags came from where, or how the counts were split.

-- ------------------------------------------------------------
-- merge_tracks -- fold, record, then move.
-- ------------------------------------------------------------
create or replace function public.merge_tracks(
  p_loser uuid, p_winner uuid, p_decision_id bigint default null,
  p_performed_by text default 'auto'
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_loser      uuid;
  v_winner     uuid;
  v_files      uuid[];
  v_prior      jsonb;
  v_sink       uuid;
  v_prior_dl   jsonb;
  v_prior_tags jsonb;
  v_folded     text[] := '{}';
  v_claims     uuid[] := '{}';
  v_sum        bigint;
  v_id         bigint;
begin
  -- Re-entrant within a transaction, so Task 6's dedup_resolve can hold the
  -- same lock around a wider critical section and this is a no-op inside
  -- it. Standalone (the review queue's human path) it is what serialises a
  -- hand-driven merge against the matcher.
  perform pg_advisory_xact_lock(hashtext('localchune.track_assign'));

  v_loser  := public.canonical_track_id(p_loser);
  v_winner := public.canonical_track_id(p_winner);
  if v_loser is null or v_winner is null or v_loser = v_winner then
    raise exception 'merge_tracks: nothing to merge' using errcode = 'P0001';
  end if;

  -- ---- capture, before anything moves ----

  -- The files that will be re-pointed, and what each one points at now.
  select coalesce(array_agg(f.id order by f.created_at, f.id), '{}'::uuid[]),
         coalesce(jsonb_object_agg(f.id::text, f.track_id::text), '{}'::jsonb)
    into v_files, v_prior
    from public.files f where f.track_id = v_loser;

  -- The survivor's representative file: the one row that carries the
  -- track's counts and tags. preferred_file_id when there is one, otherwise
  -- the oldest file on the winning track. Computed BEFORE the move, or the
  -- files arriving from the loser would be candidates for it.
  --
  -- v_sink can be NULL only when the winning track has no files at all. The
  -- fold is skipped in that case: there is nowhere to put the numbers, and
  -- leaving them on the files they came from is the honest outcome.
  select coalesce(t.preferred_file_id,
                  (select f2.id from public.files f2
                    where f2.track_id = v_winner
                    order by f2.created_at, f2.id limit 1))
    into v_sink
    from public.tracks t where t.id = v_winner;

  -- Counts, for the sink AND every moving file. The sink's own pre-merge
  -- number is in here too: the undo restores an exact split, not a
  -- subtraction, so it must know what the survivor held before the sum.
  select coalesce(jsonb_object_agg(s.file_id::text, s.download_count), '{}'::jsonb)
    into v_prior_dl
    from public.track_stats s
   where s.file_id = any (v_files) or s.file_id = v_sink;

  -- Tag rows on the moving files, whole. Restored verbatim by the undo,
  -- created_at included, so a round trip is byte-identical.
  select coalesce(jsonb_agg(to_jsonb(t) order by t.file_id, t.tag_key), '[]'::jsonb)
    into v_prior_tags
    from public.file_tags t
   where t.file_id = any (v_files) and t.file_id is distinct from v_sink;

  -- ---- record the event, before acting on it ----
  insert into public.track_merges
    (loser_track_id, winner_track_id, decision_id, performed_by,
     moved_file_ids, prior_track_id_by_file, prior_preferred_file_id,
     sink_file_id, prior_download_counts, prior_file_tags)
  select v_loser, v_winner, p_decision_id, p_performed_by,
         v_files, v_prior, t.preferred_file_id,
         v_sink, v_prior_dl, v_prior_tags
    from public.tracks t where t.id = v_winner
  returning id into v_id;

  -- ---- fold ----
  if v_sink is not null then
    -- download_count: sum onto the sink, zero the sources. The sink is
    -- excluded from the source set in case preferred_file_id already
    -- pointed at a file sitting on the losing track.
    select coalesce(sum(s.download_count), 0) into v_sum
      from public.track_stats s
     where s.file_id = any (v_files) and s.file_id is distinct from v_sink;

    if v_sum > 0 then
      insert into public.track_stats (file_id, download_count)
      values (v_sink, v_sum)
      on conflict (file_id) do update
        set download_count = track_stats.download_count + excluded.download_count;

      update public.track_stats s set download_count = 0
       where s.file_id = any (v_files) and s.file_id is distinct from v_sink;
    end if;

    -- file_tags: union by tag_key. First writer of a key wins its display
    -- casing, exactly as tag_add() already behaves ("Deep House" then
    -- "deep house" collide on the key and the second changes nothing).
    --
    -- The 20-tag cap in tag_add() is NOT applied here, on purpose: a merge
    -- is not user input, and truncating to fit would discard a tag the
    -- undo promises to restore. A survivor can therefore end up above the
    -- cap, in which case tag_add() refuses further tags until one is
    -- removed. That is a visible, reversible outcome; silent data loss is
    -- not.
    with src as (
      select distinct on (t.tag_key)
             t.tag_key, t.tag_display, t.created_by, t.created_at
        from public.file_tags t
       where t.file_id = any (v_files) and t.file_id is distinct from v_sink
       order by t.tag_key, t.created_at, t.file_id
    ), ins as (
      insert into public.file_tags (file_id, tag_display, tag_key, created_by, created_at)
      select v_sink, s.tag_display, s.tag_key, s.created_by, s.created_at from src s
      on conflict (file_id, tag_key) do nothing
      returning tag_key
    )
    select coalesce(array_agg(i.tag_key order by i.tag_key), '{}'::text[])
      into v_folded from ins i;

    delete from public.file_tags t
     where t.file_id = any (v_files) and t.file_id is distinct from v_sink;

    -- file_claims: union onto the sink, and leave every source claim in
    -- place. Both halves matter. PRD §10's "contributed never decreases"
    -- is why nothing is deleted here and why undo_merge() does not reverse
    -- this fold: the upload really did happen.
    with ins as (
      insert into public.file_claims (file_id, user_id, batch_id)
      select distinct on (c.user_id) v_sink, c.user_id, c.batch_id
        from public.file_claims c
       where c.file_id = any (v_files) and c.file_id is distinct from v_sink
       order by c.user_id, c.claimed_at
      on conflict (file_id, user_id) do nothing
      returning user_id
    )
    select coalesce(array_agg(i.user_id order by i.user_id), '{}'::uuid[])
      into v_claims from ins i;

    update public.track_merges m
       set folded_tag_keys = v_folded, added_claim_user_ids = v_claims
     where m.id = v_id;
  end if;

  -- ---- move ----
  update public.files  f set track_id = v_winner where f.track_id = v_loser;
  update public.tracks t set merged_into_track_id = v_winner, merged_at = now()
   where t.id = v_loser;

  return v_id;
end $$;
revoke execute on function public.merge_tracks(uuid, uuid, bigint, text)
  from public, anon, authenticated;
grant  execute on function public.merge_tracks(uuid, uuid, bigint, text) to service_role;

-- ------------------------------------------------------------
-- undo_merge -- PRD §6's whole reason the 0.90 band is tolerable.
--
-- REFUSES when a later, un-undone merge sits on top of either side. Undoing
-- out of order does not error later -- it silently produces a chain nobody
-- intended -- so the refusal has to be here.
--
-- What it does NOT restore:
--   bytes.  A reclaimed object was deleted from R2 and no database row can
--           bring it back. The FILE ROW returns to 'stored' and the nightly
--           reconcile then reports it as missing, which is the honest
--           outcome and is why the reclaim rule is strict about what it
--           will delete in the first place.
--   claims. The upload really did happen; PRD §10 says contributed never
--           decreases. added_claim_user_ids records what the merge added so
--           the fold is auditable, not so it can be taken away.
-- ------------------------------------------------------------
create or replace function public.undo_merge(p_merge_id bigint)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare m public.track_merges%rowtype;
begin
  -- Owner only, and NOT granted to service_role: an undo is a human
  -- reversing a machine, so there is no automated caller to serve. A
  -- service_role connection has no auth.uid() and would fail this check
  -- anyway; withholding the grant makes that explicit rather than
  -- accidental.
  if not (select public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('localchune.track_assign'));

  select * into m from public.track_merges where id = p_merge_id;
  if m.id is null then
    raise exception 'no such merge %', p_merge_id using errcode = 'P0002';
  end if;
  if m.undone_at is not null then
    raise exception 'merge already undone' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.track_merges l
     where l.undone_at is null and l.id > m.id
       and (l.loser_track_id  in (m.loser_track_id, m.winner_track_id)
         or l.winner_track_id in (m.loser_track_id, m.winner_track_id))
  ) then
    raise exception 'a later merge depends on this one' using errcode = 'P0001';
  end if;

  update public.tracks t
     set merged_into_track_id = null, merged_at = null
   where t.id = m.loser_track_id;

  -- Every file goes back to the track the payload says it came from, not
  -- to the loser wholesale: a file may have been re-pointed by a later
  -- action, and this is a merge undo, not a restore-from-backup.
  update public.files f
     set track_id = (m.prior_track_id_by_file ->> f.id::text)::uuid
   where f.id = any (m.moved_file_ids)
     and m.prior_track_id_by_file ? f.id::text;

  update public.tracks t set preferred_file_id = m.prior_preferred_file_id
   where t.id = m.winner_track_id and m.prior_preferred_file_id is not null;

  -- Reclaimed rows return to 'stored'. The bytes may be gone; the row is
  -- what a person can act on.
  update public.files f
     set state = 'stored', state_changed_at = now()
   where f.id = any (m.reclaimed_file_ids) and f.state = 'rejected_redundant';

  -- ---- reverse the fold ----

  -- Tags the merge CREATED on the survivor go away; tags the survivor
  -- already had are untouched, which is why folded_tag_keys exists rather
  -- than a blanket delete.
  if array_length(m.folded_tag_keys, 1) > 0 and m.sink_file_id is not null then
    delete from public.file_tags t
     where t.file_id = m.sink_file_id and t.tag_key = any (m.folded_tag_keys);
  end if;

  -- Then the originals come back exactly as they were, created_at included.
  insert into public.file_tags (file_id, tag_display, tag_key, created_by, created_at)
  select (e ->> 'file_id')::uuid, e ->> 'tag_display', e ->> 'tag_key',
         (e ->> 'created_by')::uuid, (e ->> 'created_at')::timestamptz
    from jsonb_array_elements(m.prior_file_tags) e
   where exists (select 1 from public.files f where f.id = (e ->> 'file_id')::uuid)
  on conflict (file_id, tag_key) do nothing;

  -- Counts are RESTORED to the recorded split, never subtracted back out.
  -- A subtraction would be wrong the moment anything downloaded the
  -- survivor between the merge and the undo.
  insert into public.track_stats (file_id, download_count)
  select (kv.key)::uuid, (kv.value)::bigint
    from jsonb_each_text(m.prior_download_counts) kv
   where exists (select 1 from public.files f where f.id = (kv.key)::uuid)
  on conflict (file_id) do update set download_count = excluded.download_count;

  update public.track_merges
     set undone_at = now(), undone_by = auth.uid()
   where id = m.id;
  return m.id;
end $$;
revoke execute on function public.undo_merge(bigint) from public, anon, service_role;
grant  execute on function public.undo_merge(bigint) to authenticated;

comment on function public.undo_merge(bigint) is
  'Owner-only, gated in the body on is_owner() -- the same shape as M1''s
   admin RPCs. A member can SEE the merges feed; only the owner can pull a
   lever on it. Restores the track pointer, every moved file''s prior
   track_id, the survivor''s prior preferred_file_id, every reclaimed
   file''s state, the pre-merge download_count split and every folded tag.
   Does NOT restore reclaimed R2 objects (gone) or remove claims (PRD §10:
   contributed never decreases).';
