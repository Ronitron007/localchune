begin;
select plan(25);

-- allowlist BEFORE auth.users, and never insert members by hand: the
-- on_auth_user_created trigger already provisioned them.
insert into public.allowlist (email) values ('up1@gmail.com'), ('up2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','up1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','up2@gmail.com');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

-- 1. batch
select ok( public.upload_batch_create('july promos') is not null,
           'upload_batch_create returns a batch id' );

-- Stash e1's batch id in a temp table (same underlying db role throughout
-- this file -- only request.jwt.claims changes -- so this stays reachable
-- after we switch to e2's claims below, without depending on RLS letting
-- e2 read e1's row back out).
create temporary table t_batch as select id from public.upload_batches limit 1;

-- 2. begin mints the key from auth.uid() + file_id, never from the client
select is(
  (select r.r2_key from public.ingest_begin(
     (select b.id from public.upload_batches b limit 1),
     '00000000-0000-0000-0000-00000000d001',
     'Artist - Title (Extended Mix).flac', 'flac', 40000000, 372000,
     false, null, null) r),
  'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-00000000d001.flac',
  'ingest_begin mints audio/<uid>/<file_id>.<container>' );

-- 3. replaying begin is a no-op, not a second row
select is(
  (select r.state from public.ingest_begin(
     (select b.id from public.upload_batches b limit 1),
     '00000000-0000-0000-0000-00000000d001',
     'Artist - Title (Extended Mix).flac', 'flac', 40000000, 372000,
     false, null, null) r),
  'pending', 'replayed ingest_begin returns the existing row' );
select is( (select count(*)::int from public.files), 1,
           'replayed ingest_begin inserted no second files row' );

-- 4. finalising a file that never got a presigned URL is illegal
select throws_ok(
  $$ select public.ingest_finalize('00000000-0000-0000-0000-00000000d001', 40000000) $$,
  'P0001', NULL,
  'ingest_finalize from pending is refused by the state machine' );

-- 5. the legal path
select is( public.ingest_mark_uploading('00000000-0000-0000-0000-00000000d001'),
           'uploading', 'pending -> uploading' );
select is( public.ingest_finalize('00000000-0000-0000-0000-00000000d001', 40000123),
           'received', 'uploading -> received' );

-- 6. the VERIFIED size wins over the declared one
select is( (select f.byte_size from public.files f
             where f.id = '00000000-0000-0000-0000-00000000d001'), 40000123::bigint,
           'finalize stores the HEAD-verified byte size, not the declared one' );

-- 7. finalize is idempotent and creates exactly one claim
select is( public.ingest_finalize('00000000-0000-0000-0000-00000000d001', 40000123),
           'received', 'replayed finalize is a no-op' );
select is( (select count(*)::int from public.file_claims), 1,
           'the uploader gets exactly one claim, even on replay' );

-- 8. another member cannot touch that file id
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select throws_ok(
  $$ select public.ingest_fail('00000000-0000-0000-0000-00000000d001', 'mine now') $$,
  '42501', NULL,
  'a different member cannot mutate someone else''s file' );

-- 9. the container allowlist
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select throws_ok(
  $$ select public.ingest_begin(
       (select b.id from public.upload_batches b limit 1),
       '00000000-0000-0000-0000-00000000d002', 'mix.exe', 'exe', 10, null,
       false, null, null) $$,
  '22023', NULL,
  'an unsupported container is refused' );

-- 10. a second file: full legal walk, a replay at every step, and a final
-- illegal move once it has reached a terminal state. This is the assertion
-- that matters most -- an illegal transition must be rejected, not merely a
-- legal one accepted.
select is(
  (select r.state from public.ingest_begin(
     (select b.id from public.upload_batches b limit 1),
     '00000000-0000-0000-0000-00000000d003',
     'Artist - Other Mix.mp3', 'mp3', 5000000, null,
     false, null, null) r),
  'pending', 'ingest_begin on a second file starts pending' );

select is( public.ingest_mark_uploading('00000000-0000-0000-0000-00000000d003'),
           'uploading', 'pending -> uploading (second file)' );
select is( public.ingest_mark_uploading('00000000-0000-0000-0000-00000000d003'),
           'uploading', 'replayed mark_uploading is a no-op, not a double-apply' );

select is( public.ingest_fail('00000000-0000-0000-0000-00000000d003', 'client aborted'),
           'failed', 'uploading -> failed' );
select is( public.ingest_fail('00000000-0000-0000-0000-00000000d003', 'client aborted again'),
           'failed', 'replayed ingest_fail is a no-op, not a double-apply' );

select throws_ok(
  $$ select public.ingest_mark_uploading('00000000-0000-0000-0000-00000000d003') $$,
  'P0001', NULL,
  'a failed file cannot be moved back to uploading -- illegal transition rejected' );

-- 11. ingest_begin refuses a batch id that does not resolve to the caller's
-- own batch (the RPC gives one error for "not yours" and "no such batch",
-- so this also covers the nonexistent-batch case).
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select throws_ok(
  format(
    $$ select public.ingest_begin(%L::uuid,
         '00000000-0000-0000-0000-00000000d004'::uuid, 'not-mine.mp3', 'mp3', 10, null,
         false, null, null) $$,
    (select id from t_batch)),
  '42501', NULL,
  'ingest_begin refuses a batch created by a different member' );

-- 12. the low-level mutator has no EXECUTE grant to any role -- the
-- definer functions above are the ONLY path to it, which is what makes
-- their transition tables the complete list of legal moves.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select throws_ok(
  $$ select public.ingest_set_state(
       '00000000-0000-0000-0000-00000000d001', array['received'], 'stored') $$,
  '42501', NULL,
  'ingest_set_state is not directly callable by authenticated' );

-- 13-17. the sweeper. It runs as service_role (no user session at 04:00),
-- so this stays in the SAME transaction/plan as everything above -- pgTAP
-- emits exactly one "1..N" plan line per file, and a second begin/plan pair
-- in one file breaks prove's TAP parsing ("More than one plan found").
-- reset role first: 'authenticated' has no INSERT on allowlist/auth.users,
-- only the session's real role (postgres, superuser here) does -- same
-- pattern as revoke_access.sql and owner_bootstrap.sql.
reset role;

insert into public.allowlist (email) values ('sw1@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e9','sw1@gmail.com');
insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000e9');
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, state, state_changed_at)
values
  ('00000000-0000-0000-0000-00000000d009','00000000-0000-0000-0000-0000000000b9',
   '00000000-0000-0000-0000-0000000000e9','audio/e9/d009.wav','old.wav', 900000000,
   'uploading', now() - interval '30 hours'),
  ('00000000-0000-0000-0000-00000000d00a','00000000-0000-0000-0000-0000000000b9',
   '00000000-0000-0000-0000-0000000000e9','audio/e9/d00a.wav','fresh.wav', 900000000,
   'uploading', now() - interval '10 minutes');
insert into public.ingest_jobs
  (file_id, batch_id, user_id, declared_byte_size, multipart, part_size, part_count, upload_id)
values
  ('00000000-0000-0000-0000-00000000d009','00000000-0000-0000-0000-0000000000b9',
   '00000000-0000-0000-0000-0000000000e9', 900000000, true, 16777216, 54, 'UPLOAD-ID-9'),
  ('00000000-0000-0000-0000-00000000d00a','00000000-0000-0000-0000-0000000000b9',
   '00000000-0000-0000-0000-0000000000e9', 900000000, true, 16777216, 54, 'UPLOAD-ID-A');

set local role service_role;
select is( (select count(*)::int from public.ingest_abandon_stale()), 1,
           'only the 30-hour-old upload is swept' );
select is( (select s.upload_id from public.ingest_abandon_stale(interval '5 minutes') s
             where s.file_id = '00000000-0000-0000-0000-00000000d00a'),
           'UPLOAD-ID-A',
           'the sweeper returns the UploadId the worker must abort in R2' );
select is( (select f.state from public.files f
             where f.id = '00000000-0000-0000-0000-00000000d009'), 'abandoned',
           'a swept file is abandoned, not deleted — the reconcile job needs its key' );

-- A stale file that never even got a presigned URL (still 'pending', never
-- reached 'uploading') must be swept too -- the diagram's abandon arrow
-- starts at 'pending', not only 'uploading'. Inserted only now, after the
-- default-interval sweep above already ran and settled, so it cannot
-- perturb the exact counts asserted above.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, state, state_changed_at)
values
  ('00000000-0000-0000-0000-00000000d00b','00000000-0000-0000-0000-0000000000b9',
   '00000000-0000-0000-0000-0000000000e9','audio/e9/d00b.wav','pending-old.wav', 500000,
   'pending', now() - interval '48 hours');
insert into public.ingest_jobs
  (file_id, batch_id, user_id, declared_byte_size, multipart)
values
  ('00000000-0000-0000-0000-00000000d00b','00000000-0000-0000-0000-0000000000b9',
   '00000000-0000-0000-0000-0000000000e9', 500000, false);

select is( (select f.state from public.files f
             where f.id = '00000000-0000-0000-0000-00000000d00b'), 'pending',
           'sanity: the new file starts pending, not yet swept' );
select is(
  (select s.file_id from public.ingest_abandon_stale() s
    where s.file_id = '00000000-0000-0000-0000-00000000d00b'),
  '00000000-0000-0000-0000-00000000d00b'::uuid,
  'a stale PENDING file (never started upload) is swept too, not only uploading' );

select * from finish();
rollback;
