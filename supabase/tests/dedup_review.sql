begin;
select plan(60);

-- ============================================================
-- M4 Tasks 7 + 8. The human layer, and the calibrated thresholds.
--
-- The shape of this file mirrors dedup_merge.sql, which asserts the round
-- trip through merge_tracks()/undo_merge() directly. This one asserts the
-- SAME round trip driven the way production drives it -- through
-- review_resolve(), by a signed-in owner, with keep-if-better moving the
-- preferred encode -- because that is the path the shipped UI takes and a
-- green suite on the layer underneath it proves nothing about the layer on
-- top.
--
--   thresholds -> forensics_json -> queue shape -> the three verdicts
--   -> APPROVE, prove the folds, UNDO, prove byte-identical restoration,
--      RE-APPROVE -> authz
-- ============================================================

-- ---------- fixture ----------
-- allowlist BEFORE auth.users: the on_auth_user_created trigger provisions
-- public.members itself and aborts on an email that is not listed yet.
insert into public.allowlist (email) values ('r1@gmail.com'), ('r2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','r1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','r2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000e1',
                   '00000000-0000-0000-0000-0000000000e2');
-- e1 is the owner. review_resolve() and undo_merge() are levers, and only
-- the owner pulls a lever.
update public.members set role = 'owner', username = 'owner1'
 where user_id = '00000000-0000-0000-0000-0000000000e1';
update public.members set username = 'member2'
 where user_id = '00000000-0000-0000-0000-0000000000e2';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-0000000000e1');

-- Four stored files. created_at is set EXPLICITLY and in a deliberate
-- order, because the survivor of a merge is the oldest identity by the
-- arrival of its oldest file -- so a fixture that lets now() decide would
-- assert a different winner on a fast machine than on a slow one.
--   fr01  the incumbent, a 128 kbps mp3   (oldest -> its track survives)
--   fr02  a genuine FLAC upgrade of fr01  (the challenger)
--   fr03  an unrelated file               (the 'different' verdict)
--   fr04  a distinct edit                 (the 'version' verdict)
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
   container, duration_ms, state, created_at)
values
  ('00000000-0000-0000-0000-00000000ee01','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1','audio/e1/fr01.mp3','Recording-128.mp3',
   4800000,'mp3',300000,'stored','2026-07-01 10:00:00+00'),
  ('00000000-0000-0000-0000-00000000ee02','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e2','audio/e2/fr02.flac','Recording.flac',
   42000000,'flac',300000,'stored','2026-07-02 10:00:00+00'),
  ('00000000-0000-0000-0000-00000000ee03','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e2','audio/e2/fr03.mp3','Something Else.mp3',
   5000000,'mp3',301000,'stored','2026-07-03 10:00:00+00'),
  ('00000000-0000-0000-0000-00000000ee04','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e2','audio/e2/fr04.mp3','Recording (Edit).mp3',
   4900000,'mp3',299000,'stored','2026-07-04 10:00:00+00');

-- Forensics. fr01 is a real 128 kbps lossy (tier 3, 16 kHz cutoff); fr02 is
-- a lossless tier 5 at 21 kHz. That gap is what makes fr02 an upgrade under
-- dedup_is_upgrade()'s hard test, and fr03/fr04 carry forensics too so the
-- queue's tier column has something real in it.
insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, quality_tier, quality_score,
   meas_cutoff_hz, meas_eff_bit_depth, meas_eff_sample_rate,
   inferred_source_kbps, lame_disagrees, mono_vs_stereo, decode_errors,
   clipped_pct, true_peak_dbtp, raw_tags)
values
  ('00000000-0000-0000-0000-00000000ee01','v2',300000,3,316.0,
   16000,0,44100,128,false,false,false,0,-1.0,
   '{"artist":"Fixture","title":"Recording"}'::jsonb),
  ('00000000-0000-0000-0000-00000000ee02','v2',300000,5,521.0,
   21000,24,44100,null,false,false,false,0,-1.0,
   '{"artist":"Fixture","title":"Recording"}'::jsonb),
  ('00000000-0000-0000-0000-00000000ee03','v2',301000,3,316.0,
   16000,0,44100,128,false,false,false,0,-1.0,
   '{"artist":"Fixture","title":"Something Else"}'::jsonb),
  ('00000000-0000-0000-0000-00000000ee04','v2',299000,3,316.0,
   16000,0,44100,128,false,false,false,0,-1.0,
   '{"artist":"Fixture","title":"Recording (Edit)"}'::jsonb);

-- One identity per file, exactly as dedup_seed_tracks() would leave them.
insert into public.tracks (id, preferred_file_id) values
  ('00000000-0000-0000-0000-00000000cc01','00000000-0000-0000-0000-00000000ee01'),
  ('00000000-0000-0000-0000-00000000cc02','00000000-0000-0000-0000-00000000ee02'),
  ('00000000-0000-0000-0000-00000000cc03','00000000-0000-0000-0000-00000000ee03'),
  ('00000000-0000-0000-0000-00000000cc04','00000000-0000-0000-0000-00000000ee04');
update public.files set track_id = '00000000-0000-0000-0000-00000000cc01' where id = '00000000-0000-0000-0000-00000000ee01';
update public.files set track_id = '00000000-0000-0000-0000-00000000cc02' where id = '00000000-0000-0000-0000-00000000ee02';
update public.files set track_id = '00000000-0000-0000-0000-00000000cc03' where id = '00000000-0000-0000-0000-00000000ee03';
update public.files set track_id = '00000000-0000-0000-0000-00000000cc04' where id = '00000000-0000-0000-0000-00000000ee04';

insert into public.track_stats (file_id, download_count) values
  ('00000000-0000-0000-0000-00000000ee01', 11),
  ('00000000-0000-0000-0000-00000000ee02', 4);
insert into public.file_tags (file_id, tag_display, tag_key, created_by) values
  ('00000000-0000-0000-0000-00000000ee01','House','house','00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-00000000ee02','Detroit','detroit','00000000-0000-0000-0000-0000000000e2');
insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-00000000ee01','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000ba'),
  ('00000000-0000-0000-0000-00000000ee02','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000ba');

-- Three live decisions in the review band, one per verdict under test.
-- The thresholds jsonb is what the decision USED, which after this
-- migration is the calibrated set.
insert into public.match_decisions
  (id, probe_file_id, candidate_file_id, candidate_track_id, algo_version,
   layer, score, band, best_offset_frames, overlap_frames, shared_items,
   duration_delta_ms, per_second_ber, thresholds, action)
values
  (900001,'00000000-0000-0000-0000-00000000ee02','00000000-0000-0000-0000-00000000ee01',
   '00000000-0000-0000-0000-00000000cc01','cp-1.6.0/test2/11025','ber',0.8147,'probable',
   0,3582,43,-3749,array[0.01,0.02,0.44,0.03]::real[],'{}'::jsonb,'review_queued'),
  (900002,'00000000-0000-0000-0000-00000000ee03','00000000-0000-0000-0000-00000000ee01',
   '00000000-0000-0000-0000-00000000cc01','cp-1.6.0/test2/11025','ber',0.8050,'probable',
   0,745,0,-67054,null,'{}'::jsonb,'review_queued'),
  (900003,'00000000-0000-0000-0000-00000000ee04','00000000-0000-0000-0000-00000000ee01',
   '00000000-0000-0000-0000-00000000cc01','cp-1.6.0/test2/11025','ber',0.8200,'probable',
   0,900,9,1000,array[0.02,0.31]::real[],'{}'::jsonb,'review_queued');
-- The reciprocal of 900001. The matcher scores both directions, and the
-- queue must show ONE row for the pair, not two.
insert into public.match_decisions
  (id, probe_file_id, candidate_file_id, candidate_track_id, algo_version,
   layer, score, band, overlap_frames, shared_items, thresholds, action)
values
  (900004,'00000000-0000-0000-0000-00000000ee01','00000000-0000-0000-0000-00000000ee02',
   '00000000-0000-0000-0000-00000000cc02','cp-1.6.0/test2/11025','ber',0.8100,'probable',
   3582,43,'{}'::jsonb,'review_queued');

-- ============================================================
-- 1. THE CALIBRATED THRESHOLDS
-- ============================================================
select is((select t_same from public.dedup_config
            where algo_version = 'cp-1.6.0/test2/11025'), 0.90::real,
  't_same holds at 0.90 — the measured void runs 0.8147-0.9660 and 0.90 is its midpoint');
select is((select t_probable from public.dedup_config
            where algo_version = 'cp-1.6.0/test2/11025'), 0.80::real,
  't_probable is 0.80, above ALL 3404 measured unrelated scores (max 0.7659)');
select is((select t_related from public.dedup_config
            where algo_version = 'cp-1.6.0/test2/11025'), 0.78::real,
  't_related is 0.78 — the near-miss log stops collecting the unrelated hump''s shoulder');
select matches((select source from public.dedup_config
                 where algo_version = 'cp-1.6.0/test2/11025'), '^CALIBRATED 2026',
  'and source names a calibration run, not the PRD');
select ok((select t_same > t_probable and t_probable > t_related
             from public.dedup_config where algo_version = 'cp-1.6.0/test2/11025'),
  'the bands stay ordered — the CHECK would have refused otherwise');

-- Thresholds are DATA. Prove it the way Task 4 proved duration_gate_s:
-- change one and watch the banding follow, with no deploy.
select is((case when 0.8147 >= (select t_probable from public.dedup_config
                                 where algo_version = 'cp-1.6.0/test2/11025')
                then 'probable' else 'related' end), 'probable',
  'the Blue Monday score still bands probable under the calibrated numbers');
select is((case when 0.7659 >= (select t_related from public.dedup_config
                                 where algo_version = 'cp-1.6.0/test2/11025')
                then 'related' else 'different' end), 'different',
  'and the highest measured unrelated score bands different — the flood is closed');

-- ============================================================
-- 2. forensics_json — keep-if-better's ten inputs
-- ============================================================
select is((select (public.forensics_json('00000000-0000-0000-0000-00000000ee02') ->> 'tier')::int), 5,
  'forensics_json reads quality_tier back under the scorer''s key name');
select is((select (public.forensics_json('00000000-0000-0000-0000-00000000ee01') ->> 'inferred_kbps')::int), 128,
  'and the six columns migration 25 added, which migration 19 had dropped');
select ok((select public.dedup_is_upgrade(
             public.forensics_json('00000000-0000-0000-0000-00000000ee01'),
             public.forensics_json('00000000-0000-0000-0000-00000000ee02'))),
  'a real tier-3 -> tier-5 jump reads as an upgrade');
select ok((select not public.dedup_is_upgrade(
             public.forensics_json('00000000-0000-0000-0000-00000000ee02'),
             public.forensics_json('00000000-0000-0000-0000-00000000ee01'))),
  'and the reverse does not — keep-if-better is not symmetric');
select ok((select public.forensics_json('00000000-0000-0000-0000-00000000ee01') is not null),
  'a file with forensics answers with an object');

-- ============================================================
-- 3. THE QUEUE. Owner's eyes only, one row per pair.
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select is((select count(*)::int from public.review_queue(50, 'pending', null)), 3,
  'three pairs pending — the reciprocal of the first is folded into it, not counted twice');

-- THE STALE-LABEL TEST (migration 30). 900005 was banded `probable` when
-- t_probable was 0.70 and its thresholds jsonb still says so, but 0.72 is
-- below the calibrated 0.80. The LOG keeps the old label; the WORK QUEUE
-- must not show the row. Nine of production's ten pending pairs were
-- exactly this, and reading the frozen band would have let the flood
-- survive its own fix.
--
-- Written as the harness, not as the member: only the matcher (service_role)
-- and this file ever insert a decision, and `authenticated` holds no write
-- on match_decisions by design.
reset role;
insert into public.match_decisions
  (id, probe_file_id, candidate_file_id, candidate_track_id, algo_version,
   layer, score, band, overlap_frames, shared_items, duration_delta_ms,
   thresholds, action)
values
  (900005,'00000000-0000-0000-0000-00000000ee03','00000000-0000-0000-0000-00000000ee04',
   '00000000-0000-0000-0000-00000000cc04','cp-1.6.0/test2/11025','ber',0.72,'probable',
   351,3,-124531,
   '{"t_same":0.9,"t_probable":0.7,"t_related":0.6}'::jsonb,'review_queued');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select is((select count(*)::int from public.review_queue(50, 'pending', null)
            where decision_id = 900005), 0,
  'a row labelled probable under the OLD thresholds is not in the queue at the new ones');
select is((select band from public.match_decisions where id = 900005), 'probable',
  'and its stored band is untouched — the log records what we believed then');
select is((select (thresholds ->> 't_probable')::real from public.match_decisions
            where id = 900005), 0.70::real,
  'as do the thresholds it was judged against — a recalibration explains history, never rewrites it');
select is((select count(*)::int from public.review_queue(50, 'pending', null)), 3,
  'so the queue is still the same three real pairs');
select is((select count(*)::int from public.review_queue(50, 'pending', null)
            where decision_id in (900001, 900004)), 1,
  'ONE row per ordered file pair, and it is the higher-scoring direction');
select is((select decision_id from public.review_queue(50, 'pending', null)
            where decision_id in (900001, 900004)), 900001::bigint,
  'specifically 900001 at 0.8147, not its 0.8100 reciprocal');
select is((select probe_kbps from public.review_queue(50, 'pending', null)
            where decision_id = 900001), 1120,
  'bitrate is DERIVED from byte_size and duration — files.bitrate_kbps has never been written');
select is((select probe_uploader from public.review_queue(50, 'pending', null)
            where decision_id = 900001), 'member2',
  'the uploader comes from pool_tracks, so a review row and a pool row agree');
select is((select cand_tier from public.review_queue(50, 'pending', null)
            where decision_id = 900001), 3::smallint,
  'and both sides carry the quality tier the reviewer needs to choose');
select ok((select per_second_ber is not null from public.review_queue(50, 'pending', null)
            where decision_id = 900001),
  'the divergence strip is carried on the row');
select ok((select per_second_ber is null from public.review_queue(50, 'pending', null)
            where decision_id = 900002),
  'and a decision with no strip renders as one — a NULL is not a crash');
select is((select review_pending_count()), 3,
  'the nav badge counts exactly what the queue shows');

-- ============================================================
-- 4. THE THREE VERDICTS
-- ============================================================

-- ---------- different ----------
select lives_ok(
  $$ select public.review_resolve(900002, 'different', 'unrelated') $$,
  'a reviewer can say different');
select is((select count(*)::int from public.dedup_negatives), 1,
  'and it is recorded as a negative on the ORDERED FILE PAIR — file ids never move, track ids do');
select is((select count(*)::int from public.review_queue(50, 'pending', null)
            where decision_id = 900002), 0,
  'the answered pair leaves the queue');
select is((select note from public.review_actions where decision_id = 900002), 'unrelated',
  'the note is kept');

-- ---------- version ----------
select lives_ok(
  $$ select public.review_resolve(900003, 'version', null) $$,
  'a reviewer can say different version');
select is((select count(*)::int from public.track_relations where relation = 'version'), 2,
  'which writes the relation BOTH ways, so either track''s page can show it');
select is((select count(*)::int from public.dedup_negatives), 1,
  'and writes NO negative — a version pair stays comparable on purpose');
select is((select count(*)::int from public.review_queue(50, 'pending', null)), 1,
  'two answered, one left');

-- ============================================================
-- 5. THE ROUND TRIP, driven the way the shipped UI drives it.
--
-- approve -> prove the folds -> undo -> prove byte-identical restoration
-- -> re-approve. dedup_merge.sql asserts this against merge_tracks()
-- directly; this asserts it against review_resolve(), which is what a
-- person actually clicks.
-- ============================================================
reset role;
create temp table snap_tags as
  select file_id, tag_display, tag_key, created_by, created_at from public.file_tags;
create temp table snap_downloads as
  select file_id, download_count from public.track_stats;
create temp table snap_tracks as
  select id, preferred_file_id, merged_into_track_id from public.tracks;
create temp table snap_files as
  select id, track_id, state from public.files;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select is((select (public.review_resolve(900001, 'same', null) ->> 'action')),
          'merged_upgraded',
  'APPROVE: the FLAC is a genuine upgrade, so the merge is recorded as one');
select is((select count(*)::int from public.recent_merges(50)), 1,
  'and it appears in the merges feed immediately');
select is((select performer_name from public.recent_merges(50) limit 1), 'owner1',
  'by name — a human merge is attributable, not "auto"');
select is((select count(*)::int from public.review_queue(50, 'pending', null)), 0,
  'the queue is empty — every pair answered');

-- The verdict was given as the owner; the STATE assertions below read
-- tables `authenticated` deliberately cannot see (track_stats, file_claims
-- carry no member-facing grant). Reading them is the test harness's job,
-- not a member's, so the role goes back before they run.
reset role;

select is((select public.canonical_track_id('00000000-0000-0000-0000-00000000cc02')),
          '00000000-0000-0000-0000-00000000cc01'::uuid,
  'the newer identity collapsed into the older one — upload order picks the survivor, not arrival order');
select is((select t.preferred_file_id from public.tracks t
            where t.id = '00000000-0000-0000-0000-00000000cc01'),
          '00000000-0000-0000-0000-00000000ee02'::uuid,
  'KEEP-IF-BETTER: the surviving identity now prefers the FLAC');
select is((select state from public.files where id = '00000000-0000-0000-0000-00000000ee01'),
          'stored',
  'and the 128 kbps incumbent is RETAINED as an alternate — never overwritten, never reclaimed');
select is((select download_count from public.track_stats
            where file_id = '00000000-0000-0000-0000-00000000ee01'), 15::bigint,
  'download_count folded onto the sink: 11 + 4');
select is((select count(*)::int from public.file_tags
            where file_id = '00000000-0000-0000-0000-00000000ee01'), 2,
  'tags unioned onto the sink');
select is((select count(*)::int from public.file_claims
            where file_id = '00000000-0000-0000-0000-00000000ee01'), 2,
  'both uploaders hold a claim on the survivor');
select is((select performed_by from public.track_merges
            where id = (select max(m.id) from public.track_merges m)),
          '00000000-0000-0000-0000-0000000000e1',
  'the event names the PERSON who pulled the lever');

-- ---------- UNDO ----------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select lives_ok(
  $$ select public.undo_merge((select max(id) from public.track_merges)) $$,
  'UNDO: the owner reverses it');

reset role;
select set_eq(
  $$ select id, track_id, state from public.files $$,
  $$ select id, track_id, state from snap_files $$,
  'every file is back on the track it came from, in the state it was in');
select set_eq(
  $$ select id, preferred_file_id, merged_into_track_id from public.tracks $$,
  $$ select id, preferred_file_id, merged_into_track_id from snap_tracks $$,
  'every track pointer is back — including the preferred_file_id keep-if-better moved');
select set_eq(
  $$ select file_id, download_count from public.track_stats $$,
  $$ select file_id, download_count from snap_downloads $$,
  'every download_count is back at its pre-merge split, restored and not subtracted');
select set_eq(
  $$ select file_id, tag_display, tag_key, created_by, created_at from public.file_tags $$,
  $$ select file_id, tag_display, tag_key, created_by, created_at from snap_tags $$,
  'every file_tags row is byte-identical — file, display, key, author and timestamp');
select is((select count(*)::int from public.file_claims
            where file_id = '00000000-0000-0000-0000-00000000ee01'), 2,
  'the claim the fold added SURVIVES the undo — PRD §10, contributed never decreases');

-- ---------- RE-APPROVE ----------
-- The verdict is still on record, so review_resolve() refuses to answer the
-- same decision twice. Re-merging is merge_tracks()' job, and it produces a
-- second, independently undoable event.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select throws_ok(
  $$ select public.review_resolve(900001, 'same', null) $$,
  'P0001',
  'decision 900001 is already answered',
  'a decision cannot be answered twice — the first verdict stands');
reset role;

do $$ begin
  perform public.merge_tracks('00000000-0000-0000-0000-00000000cc02',
                              '00000000-0000-0000-0000-00000000cc01',
                              900001, '00000000-0000-0000-0000-0000000000e1');
end $$;
select is((select public.canonical_track_id('00000000-0000-0000-0000-00000000cc02')),
          '00000000-0000-0000-0000-00000000cc01'::uuid,
  'RE-APPROVE: the pair collapses again, and the second event is its own undo');
select is((select count(*)::int from public.track_merges), 2,
  'two events on record — the undone one is marked, never deleted');

-- ============================================================
-- 6. AUTHZ. Doctrine: revoke first, then prove 42501.
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select throws_ok(
  $$ select public.review_resolve(900001, 'same', null) $$,
  '42501', 'forbidden',
  'a member who is not the owner cannot resolve a review');
select throws_ok(
  $$ select count(*) from public.review_queue(50, 'pending', null) $$,
  '42501', 'forbidden',
  'nor even see the queue');
select is((select public.review_pending_count()), 0,
  'and the nav badge answers zero rather than raising — it renders on every page for everyone');
select lives_ok(
  $$ select count(*) from public.recent_merges(50) $$,
  'but every member CAN read the merges feed — wrong merges are only cheap to undo if someone notices');
select throws_ok(
  $$ select public.forensics_json('00000000-0000-0000-0000-00000000ee01') $$,
  '42501', 'permission denied for function forensics_json',
  'forensics_json is service_role only — it is a matcher input, not a pool-facing fact');
reset role;

select ok(not has_function_privilege('anon', 'public.review_resolve(bigint,text,text)', 'execute'),
  'anon holds no execute on review_resolve — revoke ran before grant');
select ok(not has_function_privilege('anon', 'public.recent_merges(int)', 'execute'),
  'nor on the merges feed');

select * from finish();
rollback;
