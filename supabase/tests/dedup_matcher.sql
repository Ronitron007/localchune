begin;
select plan(46);

-- ============================================================
-- M4 Task 5. Two things are under test and they are not the same thing:
--
--   1. analysis_persist() now stores the six is_upgrade() inputs it used to
--      drop -- INCLUDING the fallback that derives three of them from an
--      older container's response, because the image rolls out gradually
--      and for some minutes the old one is still answering.
--   2. dedup_resolve() bands a set of scores and acts on them. The
--      assertion that matters most is the LAST one in the merge section:
--      the survivor must not depend on the order the candidates arrived
--      in, or the same pool produces two different answers depending on
--      which file happened to be re-analysed first.
-- ============================================================

insert into public.allowlist (email) values ('m1@gmail.com'), ('m2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','m1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','m2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000e1',
                   '00000000-0000-0000-0000-0000000000e2');
insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000be','00000000-0000-0000-0000-0000000000e1');

-- Four files. created_at is set EXPLICITLY and in a deliberate order: the
-- survivor rule reads the oldest file on each identity, so a fixture whose
-- rows all share an insert timestamp would pass the ordering test by
-- accident.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
   container, duration_ms, channels, state, created_at)
values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000be',
   '00000000-0000-0000-0000-0000000000e1','audio/e1/a1.flac','Incumbent.flac',
   40000000,'flac',300000,2,'stored', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000be',
   '00000000-0000-0000-0000-0000000000e2','audio/e2/a2.mp3','Newcomer-320.mp3',
   9000000,'mp3',300000,2,'stored', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000be',
   '00000000-0000-0000-0000-0000000000e2','audio/e2/a3.mp3','Third-copy.mp3',
   8000000,'mp3',300000,2,'stored', now() - interval '1 day'),
  -- Not stored: never a candidate, and never assignable an identity.
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000be',
   '00000000-0000-0000-0000-0000000000e1','audio/e1/a4.wav','Uploading.wav',
   5000000,'wav',300000,2,'uploading', now());

-- ============================================================
-- 1. The six columns exist, and are NOT a promise nothing keeps.
-- ============================================================
select has_column('public','audio_analysis','meas_eff_bit_depth',
  'audio_analysis stores the MEASURED bit depth, not just the tier it fed');
select has_column('public','audio_analysis','meas_eff_sample_rate','and the effective sample rate');
select has_column('public','audio_analysis','inferred_source_kbps','and the bitrate the cutoff implies');
select has_column('public','audio_analysis','lame_disagrees','and is_upgrade''s fake-FLAC veto');
select has_column('public','audio_analysis','mono_vs_stereo','and the -15 mono penalty''s input');
select has_column('public','audio_analysis','decode_errors','and the -25 decode-error input');

-- ============================================================
-- 2. The threshold guard. This is the whole reason the matcher can be
--    switched on: at 0.40 the `different` band is BELOW the measured
--    unrelated floor (~0.51) and cannot be reached by anything real.
--
--    M4.8 (migration 29) then replaced this task's two-data-point guess
--    with a measurement over 3,549 production decisions. 0.60 turned out
--    to be inside the unrelated hump, not above it: its p99 is 0.6635 and
--    its right shoulder filled the near-miss log with 253 non-matches on
--    the first real sweep. 0.78 clears every one of 3,404 unrelated
--    observations (max 0.7659).
-- ============================================================
select is(
  (select t_related from public.dedup_config where algo_version = 'cp-1.6.0/test2/11025'),
  0.78::real,
  't_related clears the whole measured unrelated population, not just its floor');
select ok(
  (select t_same > t_probable and t_probable > t_related
     from public.dedup_config where algo_version = 'cp-1.6.0/test2/11025'),
  'and the bands are still ordered — the CHECK would have refused otherwise');

-- ============================================================
-- 3. analysis_persist stores what the NEW container reports.
-- ============================================================
select lives_ok($$
  select public.analysis_persist(jsonb_build_object(
    'file_id','00000000-0000-0000-0000-0000000000a1',
    'analysis_version','v2','ok',true,'duration_ms',300000,
    'container','flac','codec','flac','sample_rate',44100,'bit_depth',16,'channels',2,
    'content_sha256', repeat('a',64),
    'thumb_key','thumb.jpg','peaks_key','peaks.json','cpu_seconds',44.5,
    'loudness', jsonb_build_object('integrated_lufs',-9.1,'lra_lu',5.0,
                                   'true_peak_dbtp',-0.3,'replaygain_db',0.0,'clipped_pct',0.9),
    'forensics', jsonb_build_object(
      'meas_cutoff_hz',21000,'meas_cliff_db_500',3.2,
      'meas_eff_bit_depth',16,'meas_eff_sample_rate',44100,
      'lame_tag_present',false,'lossy_ancestor','none','tier',5,'quality_score',516.8,
      'lame_disagrees',false,'mono_vs_stereo',false,'decode_errors',false)))
$$, 'analysis_persist accepts a v2 forensics object carrying all ten score inputs');

select results_eq($$
  select meas_eff_bit_depth, meas_eff_sample_rate, inferred_source_kbps,
         lame_disagrees, mono_vs_stereo, decode_errors
    from public.audio_analysis where file_id = '00000000-0000-0000-0000-0000000000a1'
$$, $$ values (16, 44100, null::int, false, false, false) $$,
  'and stores all six — inferred_source_kbps NULL means "no lossy ancestor", not 0 kbps');

-- The two writes earlier migrations added, still here. Rebuilding this
-- function from migration 09's or 14's body would silently drop one of them
-- and nothing else in the system would raise.
select is(
  (select thumb_key from public.audio_analysis where file_id = '00000000-0000-0000-0000-0000000000a1'),
  'thumb.jpg', 'migration 14''s thumb_key survived the re-creation');
select is(
  (select encode(content_sha256,'hex') from public.files where id = '00000000-0000-0000-0000-0000000000a1'),
  repeat('a',64), 'and migration 19''s content_sha256 write');

-- ============================================================
-- 4. The OLD container's response. Three of the six are absent, and the
--    fallback rebuilds them with the container's own formulas rather than
--    storing NULL for the minutes a gradual rollout takes.
-- ============================================================
select lives_ok($$
  select public.analysis_persist(jsonb_build_object(
    'file_id','00000000-0000-0000-0000-0000000000a2',
    'analysis_version','v2','ok',true,'duration_ms',300000,
    'container','mp3','codec','mp3','sample_rate',44100,'bit_depth',0,'channels',1,
    'cpu_seconds',41.0,
    'forensics', jsonb_build_object(
      'meas_cutoff_hz',16800,'meas_cliff_db_500',40.0,
      'meas_eff_bit_depth',0,'meas_eff_sample_rate',44100,
      'lame_tag_present',true,'lame_lowpass_hz',20500,
      'lossy_ancestor','confirmed','inferred_source_kbps',128,
      'tier',1,'quality_score',113.4)))
$$, 'an OLD image''s response — no lame_disagrees, no mono_vs_stereo, no decode_errors');

select results_eq($$
  select inferred_source_kbps, lame_disagrees, mono_vs_stereo, decode_errors
    from public.audio_analysis where file_id = '00000000-0000-0000-0000-0000000000a2'
$$, $$ values (128, true, true, false) $$,
  'derived: |20500-16800| > 1500 so the tag disagrees, channels 1 is mono, decode_errors false');

-- ============================================================
-- 5. A degraded analysis has no verdict, and must not be given one.
-- ============================================================
select lives_ok($$
  select public.analysis_persist(jsonb_build_object(
    'file_id','00000000-0000-0000-0000-0000000000a3',
    'analysis_version','v2','ok',true,'duration_ms',300000,
    'container','mp3','codec','mp3','sample_rate',44100,'channels',2,'cpu_seconds',40.0))
$$, 'a forensics-less analysis is still a legal persist (M4.1 carry)');
select results_eq($$
  select lame_disagrees, mono_vs_stereo, decode_errors
    from public.audio_analysis where file_id = '00000000-0000-0000-0000-0000000000a3'
$$, $$ values (null::boolean, null::boolean, null::boolean) $$,
  'and leaves all three NULL — inventing false would read as a measurement');

-- ============================================================
-- 6. dedup_assign_track.
-- ============================================================
select isnt(public.dedup_assign_track('00000000-0000-0000-0000-0000000000a1'), null,
  'a stored file with no track gets one');
select is(
  public.dedup_assign_track('00000000-0000-0000-0000-0000000000a1'),
  (select track_id from public.files where id = '00000000-0000-0000-0000-0000000000a1'),
  'and a second call returns the same identity, not a second one');
select is(public.dedup_assign_track('00000000-0000-0000-0000-0000000000a4'), null,
  'a file that is still uploading gets nothing — an identity it could never be compared on');
select is(public.dedup_assign_track('00000000-0000-0000-0000-00000000dead'), null,
  'and a file that does not exist is a race, not an error');

-- ============================================================
-- 7. dedup_resolve — banding.
-- ============================================================
select is(
  public.dedup_resolve('00000000-0000-0000-0000-0000000000a1','[]'::jsonb,
                       'cp-9.9.9/nope') ->> 'action',
  'no_config',
  'an uncalibrated algo_version refuses rather than borrowing another version''s numbers');

select is(
  public.dedup_resolve('00000000-0000-0000-0000-0000000000a4','[]'::jsonb,
                       'cp-1.6.0/test2/11025') ->> 'action',
  'not_assignable',
  'and a file that is not stored is skipped, not failed');

select is(
  public.dedup_resolve('00000000-0000-0000-0000-0000000000a1','[]'::jsonb,
                       'cp-1.6.0/test2/11025') ->> 'action',
  'no_match',
  'NO CANDIDATES AT ALL is the commonest case in a small pool, and is not an error');

-- Three candidates, one per band below t_same. a4 is not in a visible state
-- and must be dropped inside the lock even though the caller offered it.
select is(
  (public.dedup_resolve('00000000-0000-0000-0000-0000000000a1', $j$[
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a2","candidateTrackId":null,
      "layer":"ber","score":0.80,"bestOffset":-4,"overlapFrames":2400,
      "sharedItems":180,"durationDeltaMs":120,"perSecondBer":[0.1,0.2]},
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a3","candidateTrackId":null,
      "layer":"ber","score":0.79,"bestOffset":0,"overlapFrames":2400,
      "sharedItems":40,"durationDeltaMs":-90,"perSecondBer":[]},
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a4","candidateTrackId":null,
      "layer":"ber","score":0.99,"bestOffset":0,"overlapFrames":2400,
      "sharedItems":400,"durationDeltaMs":0,"perSecondBer":[]}
   ]$j$::jsonb, 'cp-1.6.0/test2/11025')) -> 'bands',
  '{"same": 0, "probable": 1, "related": 1, "different": 0}'::jsonb,
  '0.80 is probable, 0.79 is related — and the 0.99 candidate is dropped for its state, not merged');

select is(
  (select count(*)::int from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1' and superseded_at is null),
  2, 'two live decision rows, one per surviving candidate');

select is(
  (select band from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a2'
      and superseded_at is null),
  'probable',
  'the review band IS the review queue — a decision with no review_actions row is pending');

select is(
  (select action from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a3'
      and superseded_at is null),
  'near_miss',
  'and the related band is logged, never merged and never promoted to a track_relation here');

select is(
  (select (thresholds ->> 't_related')::real from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a2'
      and superseded_at is null),
  0.78::real,
  'every decision carries the thresholds it used, so a later calibration cannot rewrite its meaning');

select is(
  (select per_second_ber from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a2'
      and superseded_at is null),
  array[0.1,0.2]::real[],
  'the divergence strip survives the trip through jsonb');

select is(
  (select count(*)::int from public.dedup_near_misses
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'),
  1, 'and the near-miss view — PRD §15''s vinyl-drift tripwire — sees exactly the related row');

-- Re-running supersedes rather than duplicating, which is also what keeps
-- the partial unique index from raising 23505 on the second pass.
select lives_ok($$
  select public.dedup_resolve('00000000-0000-0000-0000-0000000000a1', $j$[
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a2","candidateTrackId":null,
      "layer":"ber","score":0.75,"bestOffset":-4,"overlapFrames":2400,
      "sharedItems":180,"durationDeltaMs":120,"perSecondBer":[]}
   ]$j$::jsonb, 'cp-1.6.0/test2/11025')
$$, 'a second run over the same pair does not collide on match_decisions_live_uniq');
select is(
  (select count(*)::int from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a2'),
  2, 'the old row is kept as history');
select is(
  (select count(*)::int from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a1'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a2'
      and superseded_at is null),
  1, 'and exactly one of them is live');

-- A human's "these are different" is never re-asked.
insert into public.dedup_negatives (file_lo, file_hi, decided_by) values
  (least('00000000-0000-0000-0000-0000000000a1'::uuid,'00000000-0000-0000-0000-0000000000a3'::uuid),
   greatest('00000000-0000-0000-0000-0000000000a1'::uuid,'00000000-0000-0000-0000-0000000000a3'::uuid),
   '00000000-0000-0000-0000-0000000000e1');
select is(
  (public.dedup_resolve('00000000-0000-0000-0000-0000000000a1', $j$[
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a3","candidateTrackId":null,
      "layer":"ber","score":0.99,"bestOffset":0,"overlapFrames":2400,
      "sharedItems":400,"durationDeltaMs":0,"perSecondBer":[]}
   ]$j$::jsonb, 'cp-1.6.0/test2/11025')) ->> 'skipped',
  '1',
  'a recorded negative suppresses the pair even at 0.99 — the human outranks the scorer');

-- ============================================================
-- 8. The auto-merge, and the property that makes it trustworthy.
-- ============================================================
delete from public.dedup_negatives;
select is(
  (public.dedup_resolve('00000000-0000-0000-0000-0000000000a3', $j$[
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a1","candidateTrackId":null,
      "layer":"ber","score":0.974,"bestOffset":-2,"overlapFrames":1399,
      "sharedItems":212,"durationDeltaMs":0,"perSecondBer":[0.01]},
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a2","candidateTrackId":null,
      "layer":"content_sha256","score":1,"bestOffset":0,"overlapFrames":2400,
      "sharedItems":300,"durationDeltaMs":0,"perSecondBer":[]}
   ]$j$::jsonb, 'cp-1.6.0/test2/11025')) ->> 'action',
  'merged',
  'two candidates over t_same collapse into one identity');

select is(
  (select count(distinct public.canonical_track_id(track_id))::int
     from public.files
    where id in ('00000000-0000-0000-0000-0000000000a1',
                 '00000000-0000-0000-0000-0000000000a2',
                 '00000000-0000-0000-0000-0000000000a3')),
  1, 'all three files now resolve to ONE surviving track');

select is(
  (select public.canonical_track_id(track_id) from public.files
    where id = '00000000-0000-0000-0000-0000000000a3'),
  (select public.canonical_track_id(track_id) from public.files
    where id = '00000000-0000-0000-0000-0000000000a1'),
  'and the survivor is the OLDEST identity — a1 was uploaded three days before the probe');

select ok(
  (select count(*) from public.track_merges where undone_at is null) = 2,
  'one recorded, undoable event per collapsed identity — merge_tracks is the only path');

select ok(
  (select bool_and(decision_id is not null) from public.track_merges),
  'every merge points at the decision that caused it');

select is(
  (select action from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a3'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a1'
      and superseded_at is null),
  'merged', 'and the decision row says so');

select is(
  (select layer from public.match_decisions
    where probe_file_id = '00000000-0000-0000-0000-0000000000a3'
      and candidate_file_id = '00000000-0000-0000-0000-0000000000a2'
      and superseded_at is null),
  'content_sha256',
  'layer 0 is recorded as layer 0, so a free answer is never mistaken for a swept one');

-- Idempotence. The pool grows, the cron re-runs, the same pair is scored
-- again: nothing must collapse twice.
select is(
  (public.dedup_resolve('00000000-0000-0000-0000-0000000000a3', $j$[
     {"candidateFileId":"00000000-0000-0000-0000-0000000000a1","candidateTrackId":null,
      "layer":"ber","score":0.974,"bestOffset":-2,"overlapFrames":1399,
      "sharedItems":212,"durationDeltaMs":0,"perSecondBer":[]}
   ]$j$::jsonb, 'cp-1.6.0/test2/11025')) -> 'merge_ids',
  '[]'::jsonb,
  'a re-run over an ALREADY merged pair records the decision and merges nothing');
select ok(
  (select count(*) from public.track_merges) = 2,
  'so the merges feed does not fill with no-ops');

-- ============================================================
-- 9. Authz. Every one of these is a definer function granted to
--    service_role and to nobody else: the matcher is machinery, not a
--    member-facing API.
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select throws_ok(
  $$ select public.dedup_resolve('00000000-0000-0000-0000-0000000000a1','[]'::jsonb,'cp-1.6.0/test2/11025') $$,
  '42501', 'permission denied for function dedup_resolve',
  'a member cannot resolve — that is an auto-merge with no audit trail');
select throws_ok(
  $$ select public.dedup_assign_track('00000000-0000-0000-0000-0000000000a1') $$,
  '42501', 'permission denied for function dedup_assign_track',
  'nor mint track identities');
select throws_ok(
  $$ insert into public.match_decisions
       (probe_file_id, candidate_file_id, algo_version, layer, score, band,
        thresholds, action)
     values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2',
             'x','ber',1,'same','{}'::jsonb,'merged') $$,
  '42501', 'permission denied for table match_decisions',
  'nor forge a decision directly — the hosted grant-everything default is closed here');
reset role;

select * from finish();
rollback;
