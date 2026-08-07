begin;
select plan(41);

-- ============================================================
-- upload_delete() -- the uploader deletes their own upload.
--
-- The shape of the file follows the operation: the ACL and the authz gate
-- first (a delete that the wrong person can reach is the only failure that
-- cannot be undone), then the two outcomes the semantics distinguish --
-- the SOLE file on a track, which takes the track down with it, and one
-- file of a MERGED track, which does not -- and finally the predicates the
-- migration had to change by hand, because a positive `state = 'stored'`
-- filter excludes a tombstone for free and an uploader/owner escape hatch
-- does not.
-- ============================================================

-- ---------- fixture ----------
-- allowlist BEFORE auth.users: the on_auth_user_created trigger provisions
-- public.members itself and aborts on an email that is not listed yet.
insert into public.allowlist (email) values
  ('ud1@gmail.com'), ('ud2@gmail.com'), ('ud3@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d001'::uuid,'ud1@gmail.com'),
  ('00000000-0000-0000-0000-00000000d002'::uuid,'ud2@gmail.com'),
  ('00000000-0000-0000-0000-00000000d003'::uuid,'ud3@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-00000000d001',
                   '00000000-0000-0000-0000-00000000d002',
                   '00000000-0000-0000-0000-00000000d003');
-- g1 is the platform owner: the one member who may delete someone else's
-- upload. g2 is the uploader under test. g3 is the bystander.
update public.members set role = 'owner', username = 'udowner'
 where user_id = '00000000-0000-0000-0000-00000000d001';
update public.members set username = 'uduploader'
 where user_id = '00000000-0000-0000-0000-00000000d002';
update public.members set username = 'udother'
 where user_id = '00000000-0000-0000-0000-00000000d003';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-00000000d0bd','00000000-0000-0000-0000-00000000d002');

-- Four identities. T1 has one file and dies with it; T2 has four and
-- survives; T3 and T4 are the review_queue pair.
insert into public.tracks (id) values
  ('00000000-0000-0000-0000-00000000d101'::uuid),
  ('00000000-0000-0000-0000-00000000d102'::uuid),
  ('00000000-0000-0000-0000-00000000d103'::uuid),
  ('00000000-0000-0000-0000-00000000d104'::uuid);

-- created_at is set EXPLICITLY throughout. The re-election tie-breaks on
-- arrival order, so a fixture that let now() decide would assert a
-- different winner on a fast machine than on a slow one.
--
--   ud01  g2, SOLE file of T1, T1's preferred. The happy path.
--   ud02  g2, T2's preferred. The merged-track path.
--   ud08  g2, on T2, arrives BEFORE ud03 but scores worse -- present so
--         "quality wins" is distinguishable from "oldest wins".
--   ud03  g3, on T2, arrives LAST and scores best. Must win the election.
--   ud09  g2, on T2, NO forensics at all. Must never win it.
--   ud04  g3, on T3. The wrong-member refusal, then the owner's override.
--   ud05  g2, failed. The wrong-state refusal.
--   ud06  g2, on T4. The review_queue pair partner for ud04.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
   container, duration_ms, state, content_sha256, created_at)
values
  ('00000000-0000-0000-0000-0000000dd001'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d002','audio/g2/ud01.flac','Alone.flac',
   10000000,'flac',300000,'stored',decode(repeat('a1',32),'hex'),'2026-07-01 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd002'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d002','audio/g2/ud02.mp3','Merged-128.mp3',
   4800000,'mp3',300000,'stored',decode(repeat('a2',32),'hex'),'2026-07-02 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd008'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d002','audio/g2/ud08.mp3','Merged-poor.mp3',
   4700000,'mp3',300000,'stored',decode(repeat('a8',32),'hex'),'2026-07-03 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd003'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d003','audio/g3/ud03.flac','Merged.flac',
   42000000,'flac',300000,'stored',decode(repeat('a3',32),'hex'),'2026-07-04 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd009'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d002','audio/g2/ud09.mp3','Merged-unknown.mp3',
   4600000,'mp3',300000,'stored',decode(repeat('a9',32),'hex'),'2026-07-05 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd004'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d003','audio/g3/ud04.mp3','Others.mp3',
   5000000,'mp3',301000,'stored',decode(repeat('a4',32),'hex'),'2026-07-06 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd005'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d002','audio/g2/ud05.mp3','Broken.mp3',
   1000,'mp3',null,'failed',null,'2026-07-07 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000dd006'::uuid,'00000000-0000-0000-0000-00000000d0bd',
   '00000000-0000-0000-0000-00000000d002','audio/g2/ud06.mp3','Pairwise.mp3',
   5100000,'mp3',302000,'stored',decode(repeat('a6',32),'hex'),'2026-07-08 10:00:00+00');

update public.files set track_id = '00000000-0000-0000-0000-00000000d101'
 where id = '00000000-0000-0000-0000-0000000dd001';
update public.files set track_id = '00000000-0000-0000-0000-00000000d102'
 where id in ('00000000-0000-0000-0000-0000000dd002',
              '00000000-0000-0000-0000-0000000dd008',
              '00000000-0000-0000-0000-0000000dd003',
              '00000000-0000-0000-0000-0000000dd009');
update public.files set track_id = '00000000-0000-0000-0000-00000000d103'
 where id = '00000000-0000-0000-0000-0000000dd004';
update public.files set track_id = '00000000-0000-0000-0000-00000000d104'
 where id = '00000000-0000-0000-0000-0000000dd006';

update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000dd001'
 where id = '00000000-0000-0000-0000-00000000d101';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000dd002'
 where id = '00000000-0000-0000-0000-00000000d102';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000dd004'
 where id = '00000000-0000-0000-0000-00000000d103';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000dd006'
 where id = '00000000-0000-0000-0000-00000000d104';

-- ud09 deliberately gets NO audio_analysis row.
insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, quality_tier, quality_score,
   meas_cutoff_hz, raw_tags)
values
  ('00000000-0000-0000-0000-0000000dd001','v2',300000,5,500.0,21000,
   '{"artist":"Fixture","title":"Alone"}'::jsonb),
  ('00000000-0000-0000-0000-0000000dd002','v2',300000,4,400.0,19000,
   '{"artist":"Fixture","title":"Merged"}'::jsonb),
  ('00000000-0000-0000-0000-0000000dd008','v2',300000,3,316.0,16000,
   '{"artist":"Fixture","title":"Merged"}'::jsonb),
  ('00000000-0000-0000-0000-0000000dd003','v2',300000,5,521.0,21000,
   '{"artist":"Fixture","title":"Merged"}'::jsonb),
  ('00000000-0000-0000-0000-0000000dd004','v2',301000,4,400.0,19000,
   '{"artist":"Fixture","title":"Others"}'::jsonb),
  ('00000000-0000-0000-0000-0000000dd006','v2',302000,4,400.0,19000,
   '{"artist":"Fixture","title":"Pairwise"}'::jsonb);

-- The contribution ledger. This is the number that must NOT move.
insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-0000000dd001','00000000-0000-0000-0000-00000000d002',
   '00000000-0000-0000-0000-00000000d0bd');

-- The review pair: ud06 (T4) against ud04 (T3), scored in the probable
-- band of the seeded config so review_queue() actually returns it.
insert into public.match_decisions
  (id, probe_file_id, candidate_file_id, candidate_track_id, algo_version,
   layer, score, band, overlap_frames, shared_items, thresholds, action)
values
  (910001,'00000000-0000-0000-0000-0000000dd006','00000000-0000-0000-0000-0000000dd004',
   '00000000-0000-0000-0000-00000000d103','cp-1.6.0/test2/11025','ber',0.8500,'probable',
   3000,40,'{}'::jsonb,'review_queued');

create temporary table ud_ids (label text primary key, id uuid not null);
grant all on ud_ids to authenticated;


-- ============================================================
-- 1. SHAPE AND CLOSURE
-- ============================================================
select has_function('public', 'upload_delete', array['uuid'],
  'upload_delete(uuid) exists');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'upload_delete'),
  true, 'upload_delete is SECURITY DEFINER');

select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'upload_delete'),
  array['search_path=""'], 'upload_delete pins an empty search_path');

-- The CHECK gained a value; it did not become permissive.
select throws_ok(
  $$ update public.files set state = 'nonsense'
      where id = '00000000-0000-0000-0000-0000000dd005' $$,
  '23514', null, 'files_state_check still refuses a state it does not name');

select lives_ok(
  $$ update public.files set state = 'deleted'
      where id = '00000000-0000-0000-0000-0000000dd005' $$,
  'files_state_check accepts the new terminal state');
update public.files set state = 'failed'
 where id = '00000000-0000-0000-0000-0000000dd005';


-- ============================================================
-- 2. THE ACL. Revoke-first, proven from every role that is not
--    `authenticated` -- and proven for the TABLE too, since a member who
--    can UPDATE files.state directly does not need this function at all.
-- ============================================================
set local role anon;
select throws_ok(
  $$ select public.upload_delete('00000000-0000-0000-0000-0000000dd001') $$,
  '42501', null, 'anon cannot execute upload_delete');
reset role;

set local role service_role;
select throws_ok(
  $$ select public.upload_delete('00000000-0000-0000-0000-0000000dd001') $$,
  '42501', null, 'service_role cannot execute upload_delete either -- no cron deletes a member''s upload');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d002"}';
select throws_ok(
  $$ update public.files set state = 'deleted'
      where id = '00000000-0000-0000-0000-0000000dd001' $$,
  '42501', null, 'a member cannot write files.state directly');


-- ============================================================
-- 3. THE AUTHZ GATE
-- ============================================================
select throws_ok(
  $$ select public.upload_delete('00000000-0000-0000-0000-0000000dd004') $$,
  '42501', 'forbidden', 'a member cannot delete another member''s upload');

select throws_ok(
  $$ select public.upload_delete('00000000-0000-0000-0000-00000000d0ff') $$,
  'P0002', null, 'an unknown file id is P0002, not a silent no-op');

select throws_ok(
  $$ select public.upload_delete('00000000-0000-0000-0000-0000000dd005') $$,
  'P0001', 'only a stored upload can be deleted (this one is failed)',
  'a failed upload is refused -- /api/upload/abort owns that path');

select throws_ok(
  $$ select public.upload_delete(null) $$,
  '22023', null, 'a null file id is 22023');


-- ============================================================
-- 4. THE CRATE. Built BEFORE the delete, by a DIFFERENT member, so the
--    "disappears from every surface including other members' crates"
--    claim is tested across an ownership boundary rather than within one.
-- ============================================================
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d001"}';
insert into ud_ids (label, id) select 'crate', public.crate_create('someone elses crate');
select public.crate_add(
  (select id from ud_ids where label = 'crate'),
  '00000000-0000-0000-0000-0000000dd001');

select is(
  (select count(*)::int from public.crate_get((select id from ud_ids where label = 'crate'))),
  1, 'the owner''s crate holds the file before the delete');


-- ============================================================
-- 5. THE SOLE FILE ON A TRACK. The track goes with it.
-- ============================================================
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d002"}';

create temporary table ud_out (k text primary key, v jsonb);
grant all on ud_out to authenticated;
insert into ud_out (k, v)
select 'sole', public.upload_delete('00000000-0000-0000-0000-0000000dd001');

select is((select (v ->> 'ok')::boolean from ud_out where k = 'sole'), true,
  'the sole-file delete reports ok');
select is((select v ->> 'r2_key' from ud_out where k = 'sole'), 'audio/g2/ud01.flac',
  'it returns the r2_key, which is the only way the route can delete the object');
select is((select (v ->> 'track_survives')::boolean from ud_out where k = 'sole'), false,
  'track_survives is false -- nothing visible is left on T1');
select is((select (v ->> 'remaining_files')::int from ud_out where k = 'sole'), 0,
  'no pool-visible file remains on the track');

reset role;
select is(
  (select state from public.files where id = '00000000-0000-0000-0000-0000000dd001'),
  'deleted', 'the row survives as a tombstone');
select is(
  (select content_sha256 from public.files where id = '00000000-0000-0000-0000-0000000dd001'),
  null, 'content_sha256 is cleared so the next upload of those bytes keeps its own digest');
select is(
  (select preferred_file_id from public.tracks where id = '00000000-0000-0000-0000-00000000d101'),
  null, 'the empty track''s preferred_file_id is NULL, and the track row itself is kept');


-- ============================================================
-- 6. THE PREDICATE AUDIT, as the database can reach it.
--
--    pool_get is the one that mattered: its `or uploaded_by = auth.uid()
--    or is_owner()` clause is the reason a positive filter was not enough,
--    and both halves are asserted below.
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d002"}';

select is(
  (select count(*)::int from public.pool_get('00000000-0000-0000-0000-0000000dd001')),
  0, 'pool_get hides the tombstone from the UPLOADER -- the escape-hatch clause does not win');
select is(
  (select count(*)::int from public.pool_list()
    where file_id = '00000000-0000-0000-0000-0000000dd001'),
  0, 'pool_list drops it -- and pool_list IS the auto-queue''s candidate source');
select is(
  (select count(*)::int from public.feed_tracks('fresh', 50)
    where file_id = '00000000-0000-0000-0000-0000000dd001'),
  0, 'the home feed drops it');
-- dedup_exact is the matcher's, granted to service_role alone -- the
-- probe carries the digest the container just computed, which is exactly
-- the re-upload-of-deleted-bytes case.
reset role;
set local role service_role;
select is(
  (select count(*)::int from public.dedup_exact(
     '00000000-0000-0000-0000-0000000dd002', decode(repeat('a1',32),'hex'))),
  0, 'the matcher''s layer-0 digest lookup can never return a tombstone');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d002"}';

-- my_files is the deliberate exception: an uploader's own history keeps
-- the row, labelled, because that is the record of what they did.
select is(
  (select state from public.my_files(500) where file_id = '00000000-0000-0000-0000-0000000dd001'),
  'deleted', 'my_files still shows it, so /uploads can say "deleted by you"');

-- "Contributed never decreases." Occupying does, because the bytes are
-- really gone.
select is(
  (select contributed_files from public.my_storage()), 1,
  'contributed_files does not move -- file_claims and credit_grants are untouched');
-- g2 uploaded five files: ud01, ud02, ud08, ud09, ud06 stored, plus ud05
-- failed (never counted). The delete takes ud01 out of states_holding_bytes().
select is(
  (select occupying_files from public.my_storage()), 4,
  'occupying_files drops from 5 to 4 -- states_holding_bytes() no longer counts it');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d001"}';
select is(
  (select count(*)::int from public.pool_get('00000000-0000-0000-0000-0000000dd001')),
  0, 'pool_get hides the tombstone from the PLATFORM OWNER too');

-- The crate decision, both halves: invisible everywhere it renders, and
-- the curator's row is still there rather than silently rewritten.
select is(
  (select count(*)::int from public.crate_get((select id from ud_ids where label = 'crate'))),
  0, 'the file is gone from another member''s crate');
select is(
  (select track_count from public.crate_list()
    where id = (select id from ud_ids where label = 'crate')),
  0, 'the crate card''s count agrees with the open crate');
reset role;
select is(
  (select count(*)::int from public.crate_items
    where file_id = '00000000-0000-0000-0000-0000000dd001'),
  1, 'the crate_items row is KEPT, not deleted -- one member''s delete never edits another''s crate');


-- ============================================================
-- 7. IDEMPOTENCE. A double submit is a distinct, readable refusal, not a
--    second delete and not a success.
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d002"}';
select throws_ok(
  $$ select public.upload_delete('00000000-0000-0000-0000-0000000dd001') $$,
  'P0001', 'this upload is already deleted',
  'deleting twice says so, rather than reporting a second success');


-- ============================================================
-- 8. ONE FILE OF A MERGED TRACK. The track survives and re-elects.
--
--    ud08 arrived before ud03 and would win a pure arrival-order tie-break;
--    ud09 has no forensics at all. The election must pick ud03 over both.
-- ============================================================
insert into ud_out (k, v)
select 'merged', public.upload_delete('00000000-0000-0000-0000-0000000dd002');

select is((select (v ->> 'track_survives')::boolean from ud_out where k = 'merged'), true,
  'the track survives when other live files remain on it');
select is((select (v ->> 'remaining_files')::int from ud_out where k = 'merged'), 3,
  'the three surviving files are counted');
select is((select (v ->> 'reelected')::int from ud_out where k = 'merged'), 1,
  'exactly one preferred pointer was re-elected');

reset role;
select is(
  (select preferred_file_id from public.tracks where id = '00000000-0000-0000-0000-00000000d102'),
  '00000000-0000-0000-0000-0000000dd003'::uuid,
  'quality wins the election: ud03 (521) beats the earlier ud08 (316) and the forensics-free ud09');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d002"}';
select is(
  (select count(*)::int from public.pool_list()
    where file_id = '00000000-0000-0000-0000-0000000dd003'),
  1, 'the surviving encode is still in the pool -- deleting one file did not take the recording down');
select is(
  (select count(*)::int from public.pool_get('00000000-0000-0000-0000-0000000dd003')),
  1, 'and its track page still renders');


-- ============================================================
-- 9. review_queue. The second predicate with no state filter of its own.
-- ============================================================
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000d001"}';

select is(
  (select count(*)::int from public.review_queue(50, 'pending') where decision_id = 910001),
  1, 'the pair is in the owner''s review queue while both files live');

-- The owner deletes someone else's upload. Allowed, and the only account
-- other than the uploader that may.
insert into ud_out (k, v)
select 'byowner', public.upload_delete('00000000-0000-0000-0000-0000000dd004');
select is((select (v ->> 'ok')::boolean from ud_out where k = 'byowner'), true,
  'the platform owner may delete another member''s upload');

select is(
  (select count(*)::int from public.review_queue(50, 'pending') where decision_id = 910001),
  0, 'the pair leaves the queue -- a tombstone has no preview to show and no identity to merge');

select * from finish();
rollback;
