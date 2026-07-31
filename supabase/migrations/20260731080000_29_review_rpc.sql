-- supabase/migrations/20260731080000_29_review_rpc.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M4 Tasks 7 and 8 — the human layer, and the calibrated thresholds.
--
-- Two things live here, and the order is deliberate. The thresholds move
-- FIRST, because every function below reads a band that the old numbers
-- spelled wrong.
--
-- NUMBERING. The plan calls the review migration "18". That label went to
-- pool-ux. M4.1 took 19, PR #16 took 20, rohan/drop-files-bitrate claimed
-- 21, M4 Tasks 2/4/5 took 22-25, likes/plays and crates took 26/27, and
-- provenance-reswap took 28. This is 29. Trust `ls supabase/migrations/`,
-- never the plan's numbers.

-- ============================================================
-- 1. THE CALIBRATION. M4.8, measured rather than guessed.
--
-- Migration 25 raised t_related 0.40 -> 0.60 on TWO data points and said so
-- in its own header: "THIS IS A GUESS WITH TWO DATA POINTS UNDER IT, not a
-- calibration." This is the calibration, over 3,549 real production
-- decisions covering 350 probes, taken 2026-07-31 08:00Z.
--
-- THE MEASURED DISTRIBUTION, in 0.02 buckets. Two populations, and a void
-- between them:
--
--   0.00-0.02    70   scoring floor: overlaps of 1-43 frames, 0 shared items
--   0.44-0.50   190  \
--   0.50-0.56  2398   |  THE UNRELATED HUMP. 3,404 observations.
--   0.56-0.62   673   |  p50 0.5340 · p90 0.5896 · p99 0.6635
--   0.62-0.70   133  /   p99.9 0.7453 · max 0.7659
--   0.70-0.78    12      the hump's thin right tail: every one of these is
--                        a short-overlap artefact (0-14 shared items over
--                        315-763 frames, 33-125 s duration deltas)
--   0.78-0.82     1      "Blue Monday" m4a vs mp3 — 43 shared items over
--                        3,582 frames, 3.7 s apart. The one genuinely
--                        ambiguous pair in the pool.
--   0.82-0.96     0      **EMPTY.** A 0.15-wide void.
--   0.96-1.00    55      THE TRUE-DUPLICATE CLUSTER. Every single one is a
--                        FLAC/MP3 transcode pair with a matching filename
--                        stem. min 0.966014.
--   1.00         20      layer fp_sha256: byte-identical fingerprints.
--
-- WHY EACH NUMBER IS WHERE IT IS.
--
-- t_same 0.90, UNCHANGED. The measurement confirms the seeded value rather
-- than replacing it. The empty void runs 0.814716 -> 0.966014 and its
-- midpoint is 0.8904; 0.90 sits 0.066 below the lowest verified true merge
-- and 0.085 above the highest thing that is not one. It also clears the one
-- known related-but-distinct pair, "Feeling For You" at 0.666096, by 0.234.
-- Moving it would be unjustified precision: there is no 128 kbps corpus in
-- this pool, so the recall margin below 0.966 is the one number that must
-- not be spent, and nothing measured here argues for spending it.
--
-- t_probable 0.70 -> 0.80. THIS IS THE FLOOD FIX. At 0.70 the review queue
-- holds ten pairs and nine of them are noise — the hump's tail, not
-- duplicates. 0.80 sits above ALL 3,404 unrelated observations (max 0.7659,
-- margin 0.034) and below the one pair a human should actually look at.
-- Queue depth goes 10 -> 1, and the one row left is real.
--
-- t_related 0.60 -> 0.78. At 0.60 the `related` band caught 253 pairs, all
-- of them the right shoulder of the unrelated hump: dedup_near_misses is
-- PRD §15's vinyl-drift tripwire and a tripwire that is always tripped is
-- not a tripwire. 0.78 sits above every unrelated observation, so a
-- `related` verdict now means "no random pair in this pool ever reached
-- here" — which is what the plan asked for and what the seeded number could
-- not deliver.
--
-- THE HONEST LIMIT, recorded so nobody rediscovers it. The `related` band
-- is now nearly empty and that is CORRECT for this pool, not a bug. The one
-- genuinely related-but-distinct pair, "Feeling For You" (original vs DJ
-- tool), scores 0.666096 — inside the unrelated hump, indistinguishable
-- from noise — and is in any case excluded from its own candidate set by
-- the +/-10 s duration gate (431 s vs 278 s). The BER scorer cannot express
-- "related" on this evidence, so no threshold can. Calling a 0.666 pair
-- `related` would be a claim the data does not support.
--
-- Still an UPDATE and not a deploy: thresholds are data (migration 22's
-- decision), every match_decisions row carries a copy of the thresholds it
-- used, and the next recalibration is one statement. It sits in a migration
-- so a replay from zero reproduces the calibrated pool and pgTAP can assert
-- the numbers.
-- ============================================================
update public.dedup_config
   set t_same     = 0.90,
       t_probable = 0.80,
       t_related  = 0.78,
       source = 'CALIBRATED 2026-07-31 from 3549 production match_decisions '
                '(350 probes, hosted). Unrelated population n=3404: p50 0.5340, '
                'p99 0.6635, p99.9 0.7453, max 0.7659. True-duplicate cluster '
                'n=55 ber (all FLAC/MP3 transcode pairs) min 0.966014, plus 20 '
                'fp_sha256 exact at 1.0. Empty void 0.8147-0.9660. t_same held '
                'at 0.90 (void midpoint 0.8904); t_probable 0.70->0.80 above the '
                'unrelated max; t_related 0.60->0.78 to stop the near-miss log '
                'flooding with the hump''s right shoulder.',
       updated_at = now()
 where algo_version = 'cp-1.6.0/test2/11025';

-- ============================================================
-- 2. forensics_json -- keep-if-better's ten inputs, read back.
--
-- dedup_is_upgrade(a, b) and dedup_quality_score(f) (migration 24) take a
-- jsonb of ten measured fields. Migration 25 added the six that migration
-- 19 dropped on the floor, so all ten are now persisted and this function
-- is finally able to answer honestly. Before 25 it would have scored with
-- six neutral defaults and lost the fake-FLAC veto entirely.
--
-- RETURNS NULL WHEN quality_tier IS NULL, deliberately. dedup_is_upgrade()
-- answers false on a NULL side, so "no forensics" flows to "not an
-- upgrade" -- absence of evidence is not evidence of a better encode. The
-- alternative, a jsonb of nulls, would let dedup_quality_score()'s
-- coalesces invent a score out of nothing.
--
-- Key names are dedup_quality_score()'s, not audio_analysis's. They differ
-- (tier/cutoff_hz/eff_bits/eff_sr/inferred_kbps vs quality_tier/
-- meas_cutoff_hz/meas_eff_bit_depth/...) because the scorer's shape came
-- from the container's Python dict. Mapping in one place beats spelling it
-- at every call site.
-- ============================================================
create or replace function public.forensics_json(p_file_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when a.quality_tier is null then null else jsonb_build_object(
           'tier',           a.quality_tier,
           'cutoff_hz',      a.meas_cutoff_hz,
           'eff_bits',       a.meas_eff_bit_depth,
           'eff_sr',         a.meas_eff_sample_rate,
           'inferred_kbps',  a.inferred_source_kbps,
           'lame_disagrees', a.lame_disagrees,
           'clipped_pct',    a.clipped_pct,
           'true_peak',      a.true_peak_dbtp,
           'mono_vs_stereo', a.mono_vs_stereo,
           'decode_errors',  a.decode_errors,
           'quality_score',  a.quality_score) end
    from public.audio_analysis a where a.file_id = p_file_id;
$$;
revoke execute on function public.forensics_json(uuid)
  from public, anon, authenticated;
grant  execute on function public.forensics_json(uuid) to service_role;

comment on function public.forensics_json(uuid) is
  'The ten dedup_is_upgrade()/dedup_quality_score() inputs, read out of
   audio_analysis into the key names the scorer expects. NULL when
   quality_tier is NULL, so a file with no forensics can never be judged an
   upgrade over one that has them.';

-- ============================================================
-- 3. review_queue -- the 0.80-0.90 band, minus everything answered.
--
-- There is NO queue table and no queue state column. Migration 22 said why:
-- either would be a second source of truth for "has a person looked at this
-- yet". A `probable` decision with no review_actions row is pending; one
-- with a row is answered.
--
-- FOUR FILTERS, and the last three are all load-bearing:
--
--  1. band = 'probable' and superseded_at is null -- the live decisions in
--     the review band.
--  2. NOT ANSWERED, keyed on the ORDERED FILE PAIR rather than the decision
--     id. Re-analysis supersedes a decision and inserts a new one with a
--     new id, and a new id has no review_actions row -- so keying on the id
--     alone would put the reviewer's own answer back in front of them every
--     time the matcher re-ran. A person's verdict outlives the row that
--     prompted it.
--  3. NOT ALREADY ONE TRACK. A pair that a later auto-merge or a chain of
--     merges already collapsed has nothing left to decide.
--  4. ONE ROW PER PAIR. The matcher scores both directions, so A->B and
--     B->A can both land in the band. distinct on the ordered pair, highest
--     score first, keeps the better-evidenced row.
--
-- Display strings come from pool_tracks, which is where the pool table
-- reads them. Deriving them a second time here is how a review row and a
-- pool row start disagreeing about what a file is called.
--
-- BITRATE IS DERIVED, never read from files.bitrate_kbps. That column has
-- never been written (0 of 1090 rows on production) and open PR #18 drops
-- it. byte_size * 8 / duration_ms is the real, always-available number.
-- ============================================================
-- ONE FUNCTION, not a queue plus a review_get. The plan drew a second
-- function for the permalink, which would mean spelling this 32-column
-- RETURNS TABLE twice -- and `returns setof record` is not an option,
-- because PostgREST cannot supply the column definition list that a bare
-- record requires. p_decision_id narrows the same query to one row, so the
-- list page and the permalink render from one shape.
create or replace function public.review_queue(
  p_limit int default 50, p_status text default 'pending',
  p_decision_id bigint default null
) returns table (
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
  -- Owner only. A member can SEE the merges feed; the review queue is a
  -- lever, and M1's admin RPCs draw the line in the same place.
  if not (select public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with live as (
    select distinct on (least(d.probe_file_id, d.candidate_file_id),
                        greatest(d.probe_file_id, d.candidate_file_id))
           d.*
      from public.match_decisions d
     where d.band = 'probable'
       and d.superseded_at is null
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
  select l.id, l.score, l.band, l.layer, l.shared_items, l.overlap_frames,
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
     -- Nothing left to decide once the two sides are one identity.
     and (a.verdict is not null
          or public.canonical_track_id(p.track_id)
               is distinct from public.canonical_track_id(c.track_id))
     and (p_decision_id is null or l.id = p_decision_id)
   order by l.score desc, l.id desc
   limit greatest(least(coalesce(p_limit, 50), 200), 1);
end $$;
revoke execute on function public.review_queue(int, text, bigint)
  from public, anon, service_role;
grant  execute on function public.review_queue(int, text, bigint) to authenticated;

-- ------------------------------------------------------------
-- review_pending_count -- the nav badge. One number, owner only.
--
-- Returns 0 rather than raising for a non-owner: a member simply has no
-- badge, and AppNav renders on every page for everyone. The is_owner()
-- test has to come BEFORE the review_queue() call, which does raise.
-- ------------------------------------------------------------
create or replace function public.review_pending_count()
returns int
language plpgsql stable security definer set search_path = '' as $$
declare v_n int;
begin
  if not (select public.is_owner()) then
    return 0;
  end if;
  select count(*)::int into v_n from public.review_queue(200, 'pending', null);
  return coalesce(v_n, 0);
end $$;
revoke execute on function public.review_pending_count()
  from public, anon, service_role;
grant  execute on function public.review_pending_count() to authenticated;

-- ============================================================
-- 4. review_resolve -- the three verdicts.
--
--   same      -> merge_tracks(), so a human merge is EXACTLY as undoable as
--                an automatic one. There is no second collapse path.
--                Then keep-if-better picks which encode the surviving
--                identity prefers.
--   different -> a dedup_negatives row on the ORDERED FILE PAIR, which is
--                what stops the matcher re-asking. dedup_resolve() already
--                skips any candidate carrying one. Without it the next
--                re-analysis re-asks the same question and the reviewer's
--                two seconds were wasted.
--   version   -> track_relations, both directions, so either track's page
--                can show it. NO negative: a version pair stays comparable
--                on purpose, and review_queue()'s pair-keyed answered
--                filter is what keeps it out of the queue.
--
-- Always: one review_actions row. match_decisions stays append-only and a
-- re-run of the matcher can never overwrite a person's verdict.
--
-- KEEP-IF-BETTER, and what it deliberately does NOT do. It moves
-- tracks.preferred_file_id to the better encode and stops there. It does
-- not demote the incumbent to rejected_redundant and it does not reclaim
-- an R2 object, because merge_tracks() keeps every file and the worst
-- outcome of a wrong verdict is therefore one undo_merge() call with no
-- byte deleted. merge_tracks() captured prior_preferred_file_id before the
-- pointer moved, so the undo restores it for free. Reclaim stays deferred
-- for the same reason migration 25 deferred it: reconcile.ts cannot yet
-- tell rejected_redundant from a genuinely missing object.
-- ============================================================
create or replace function public.review_resolve(
  p_decision_id bigint, p_verdict text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d            public.match_decisions%rowtype;
  v_actor      uuid := (select auth.uid());
  v_probe_trk  uuid;
  v_cand_trk   uuid;
  v_winner     uuid;
  v_loser      uuid;
  v_challenger uuid;
  v_pref       uuid;
  v_merge      bigint;
  v_upgraded   boolean := false;
begin
  if not (select public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(p_verdict, '') not in ('same', 'different', 'version') then
    raise exception 'review_resolve: unknown verdict %', coalesce(p_verdict, '(null)')
      using errcode = '22023';
  end if;

  -- The same lock every collapse takes, held around read-decide-write so a
  -- verdict cannot interleave with the matcher merging the same identities.
  perform pg_advisory_xact_lock(hashtext('localchune.track_assign'));

  select * into d from public.match_decisions where id = p_decision_id;
  if d.id is null then
    raise exception 'no such decision %', p_decision_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.review_actions r where r.decision_id = d.id) then
    raise exception 'decision % is already answered', p_decision_id
      using errcode = 'P0001';
  end if;

  -- Record the human's answer BEFORE acting on it, for the same reason
  -- dedup_resolve() writes its decision first: a ledger whose rows appear
  -- only for the branches that succeeded is not a ledger.
  insert into public.review_actions (decision_id, verdict, decided_by, note)
  values (d.id, p_verdict, v_actor, nullif(btrim(coalesce(p_note, '')), ''));

  v_probe_trk := public.dedup_assign_track(d.probe_file_id);
  v_cand_trk  := public.dedup_assign_track(d.candidate_file_id);

  if p_verdict = 'different' then
    insert into public.dedup_negatives (file_lo, file_hi, decided_by)
    values (least(d.probe_file_id, d.candidate_file_id),
            greatest(d.probe_file_id, d.candidate_file_id), v_actor)
    on conflict (file_lo, file_hi) do nothing;
    return jsonb_build_object('ok', true, 'verdict', 'different',
                              'decision_id', d.id, 'suppressed', true);
  end if;

  if v_probe_trk is null or v_cand_trk is null then
    -- A file that left 'stored' underneath the reviewer. The verdict is
    -- recorded (so the pair stays out of the queue) but there is no
    -- identity to act on.
    return jsonb_build_object('ok', false, 'verdict', p_verdict,
      'decision_id', d.id, 'reason', 'a file on this pair has no track identity');
  end if;

  if p_verdict = 'version' then
    if v_probe_trk is distinct from v_cand_trk then
      insert into public.track_relations (track_id, related_id, relation, score)
      values (v_probe_trk, v_cand_trk, 'version', d.score)
      on conflict do nothing;
      insert into public.track_relations (track_id, related_id, relation, score)
      values (v_cand_trk, v_probe_trk, 'version', d.score)
      on conflict do nothing;
    end if;
    return jsonb_build_object('ok', true, 'verdict', 'version',
                              'decision_id', d.id);
  end if;

  -- ---------- 'same' ----------
  if v_probe_trk = v_cand_trk then
    return jsonb_build_object('ok', true, 'verdict', 'same',
      'decision_id', d.id, 'action', 'already_merged', 'track_id', v_probe_trk);
  end if;

  -- THE SURVIVOR IS THE OLDEST IDENTITY, by the arrival of its oldest file.
  -- Exactly dedup_resolve()'s rule, and for its reason: dedup_seed_tracks()
  -- minted every backfilled identity in one statement, so tracks.created_at
  -- cannot tell an incumbent from a newcomer. Upload order can, and is what
  -- "already in the pool" actually means. A human merge and an automatic
  -- one must pick the same winner or the feed reads as two systems.
  select t.id into v_winner
    from public.tracks t
   where t.id in (v_probe_trk, v_cand_trk)
   order by (select min(f2.created_at) from public.files f2 where f2.track_id = t.id),
            t.created_at, t.id
   limit 1;
  v_loser      := case when v_winner = v_probe_trk then v_cand_trk  else v_probe_trk end;
  v_challenger := case when v_winner = v_probe_trk then d.candidate_file_id
                                                   else d.probe_file_id end;

  -- performed_by carries the member uuid as text, not 'auto'. The feed
  -- shows who, and undo_merge() works the same either way.
  v_merge := public.merge_tracks(v_loser, v_winner, d.id, v_actor::text);

  -- KEEP-IF-BETTER. PRD §7.2: never overwrite the incumbent, keep both
  -- files and flip a pointer.
  select t.preferred_file_id into v_pref from public.tracks t where t.id = v_winner;
  if v_pref is null then
    update public.tracks t set preferred_file_id = v_challenger where t.id = v_winner;
  elsif public.dedup_is_upgrade(public.forensics_json(v_pref),
                                public.forensics_json(v_challenger)) then
    update public.tracks t set preferred_file_id = v_challenger where t.id = v_winner;
    v_upgraded := true;
  end if;

  update public.match_decisions m
     set action = case when v_upgraded then 'merged_upgraded' else 'merged_alternate' end
   where m.id = d.id;

  return jsonb_build_object('ok', true, 'verdict', 'same', 'decision_id', d.id,
    'action', case when v_upgraded then 'merged_upgraded' else 'merged_alternate' end,
    'merge_id', v_merge, 'track_id', v_winner, 'upgraded', v_upgraded);
end $$;
revoke execute on function public.review_resolve(bigint, text, text)
  from public, anon, service_role;
grant  execute on function public.review_resolve(bigint, text, text) to authenticated;

comment on function public.review_resolve(bigint, text, text) is
  'Owner-only, gated in the body on is_owner(). ''same'' collapses through
   merge_tracks() -- the ONE collapse path -- and then moves
   preferred_file_id if the newcomer is a genuine upgrade; ''different''
   writes a dedup_negatives row on the ordered file pair so the matcher
   stops asking; ''version'' writes track_relations both ways. Every verdict
   writes a review_actions row, which is what takes the pair out of
   review_queue() permanently, across re-analysis.';

-- ============================================================
-- 5. recent_merges -- the feed. PRD §6's last "where dedup will fail"
-- bullet, verbatim: "Nothing currently surfaces a completed auto-merge for
-- after-the-fact review. Wrong merges are cheap to undo only if someone
-- notices."
--
-- EVERY MEMBER MAY READ IT; only the owner may undo. The spec's rule is
-- omit, don't disable, so the page renders the form only for the owner and
-- undo_merge() enforces it again in the database.
--
-- The losing track has no files left after the merge, so its display comes
-- from moved_file_ids[1] -- the file that actually moved. Reading the loser
-- track's own files would return nothing and the feed would show a merge of
-- a named track into a blank.
-- ============================================================
create or replace function public.recent_merges(p_limit int default 50)
returns table (
  merge_id        bigint,
  performed_at    timestamptz,
  performed_by    text,
  performer_name  text,
  is_auto         boolean,
  undone_at       timestamptz,
  undone_by_name  text,
  decision_id     bigint,
  score           real,
  layer           text,
  band            text,
  winner_track_id uuid,
  winner_file_id  uuid,
  winner_artist   text,
  winner_title    text,
  winner_tier     smallint,
  winner_container text,
  loser_track_id  uuid,
  loser_file_id   uuid,
  loser_artist    text,
  loser_title     text,
  loser_tier      smallint,
  loser_container text,
  moved_files     int,
  reclaimed_files int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select public.is_active_member()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select m.id, m.performed_at, m.performed_by,
           coalesce(pm.username, split_part(pm.email, '@', 1)),
           (m.performed_by = 'auto'),
           m.undone_at, coalesce(um.username, split_part(um.email, '@', 1)),
           m.decision_id, d.score, d.layer, d.band,
           m.winner_track_id, w.file_id, w.display_artist, w.display_title,
           w.quality_tier, w.container,
           m.loser_track_id,  l.file_id, l.display_artist, l.display_title,
           l.quality_tier, l.container,
           coalesce(array_length(m.moved_file_ids, 1), 0),
           coalesce(array_length(m.reclaimed_file_ids, 1), 0)
      from public.track_merges m
      left join public.match_decisions d on d.id = m.decision_id
      left join public.tracks wt on wt.id = m.winner_track_id
      left join public.pool_tracks w
        on w.file_id = coalesce(wt.preferred_file_id, m.sink_file_id)
      left join public.pool_tracks l on l.file_id = m.moved_file_ids[1]
      -- performed_by is 'auto' or a member uuid as text. The regex guard is
      -- not decoration: a bare ::uuid cast on anything else raises 22P02
      -- and takes the whole feed down over one malformed row.
      left join public.members pm
        on m.performed_by ~ '^[0-9a-fA-F-]{36}$' and pm.user_id = m.performed_by::uuid
      left join public.members um on um.user_id = m.undone_by
     order by m.id desc
     limit greatest(least(coalesce(p_limit, 50), 200), 1);
end $$;
revoke execute on function public.recent_merges(int)
  from public, anon, service_role;
grant  execute on function public.recent_merges(int) to authenticated;

-- PostgREST caches the function signatures it exposes. Without this the
-- first /review page load answers PGRST202 until the cache happens to roll.
notify pgrst, 'reload schema';
