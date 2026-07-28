begin;
select plan(13);

-- allowlist BEFORE auth.users: handle_new_user() aborts with 'not
-- allowlisted' otherwise. The on_auth_user_created trigger then provisions
-- public.members, so members must NOT be inserted by hand here.
insert into public.allowlist (email) values
  ('u1@gmail.com'), ('u2@gmail.com'), ('gone@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1','u1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000f2','u2@gmail.com'),
  ('00000000-0000-0000-0000-0000000000f3','gone@gmail.com');

-- An expired member, to prove "everything else goes dark".
update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000f3';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, state)
values
  ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000f1','audio/f1/a001.flac','good.flac', 100, 'stored'),
  ('00000000-0000-0000-0000-00000000a002','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000f1','audio/f1/a002.flac','bad.flac',  200, 'quarantined');

insert into public.ingest_jobs (file_id, batch_id, user_id, declared_byte_size, multipart)
values ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000f1', 100, false);

-- ---- as u2: another active member, not the uploader ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f2"}';

-- A missing base GRANT raises 42501 "permission denied for table", NOT an
-- empty result. lives_ok is what distinguishes the two.
select lives_ok( $$ select 1 from public.files limit 1 $$,
                 'authenticated can reach files at all (base grant present)' );
select lives_ok( $$ select 1 from public.file_claims limit 1 $$,
                 'authenticated can reach file_claims' );
select is( (select count(*)::int from public.files), 1,
           'a non-uploader sees the pool-visible file and not the quarantined one' );
select is( (select count(*)::int from public.ingest_jobs), 0,
           'ingest_jobs are private to their owner' );
select is( (select count(*)::int from public.upload_batches), 0,
           'upload_batches are private to their creator' );

-- [F3] Migration 10 closed hosted Supabase's default open ACL on these four
-- tables. Locally the default privileges never granted INSERT to
-- authenticated in the first place, so these pass with or without
-- migration 10 -- the value is as a regression guard, same as the mirrored
-- assertions in rls_reachable.sql and analysis.sql.
select throws_ok(
  $$ insert into public.files (id, batch_id, uploaded_by, r2_key, original_filename, byte_size)
     values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000b1',
             '00000000-0000-0000-0000-0000000000f2', 'audio/f2/nope.flac', 'nope.flac', 100) $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into files directly -- writes go through ingest_begin()' );
select throws_ok(
  $$ insert into public.upload_batches (created_by)
     values ('00000000-0000-0000-0000-0000000000f2') $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into upload_batches directly -- writes go through upload_batch_create()' );
select throws_ok(
  $$ insert into public.file_claims (file_id, user_id, batch_id) values
     ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000f2',
      '00000000-0000-0000-0000-0000000000b1') $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into file_claims directly' );
select throws_ok(
  $$ insert into public.ingest_jobs (file_id, batch_id, user_id, declared_byte_size, multipart)
     values ('00000000-0000-0000-0000-00000000a002','00000000-0000-0000-0000-0000000000b1',
             '00000000-0000-0000-0000-0000000000f2', 100, false) $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into ingest_jobs directly' );

-- ---- as u1: the uploader ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';
select is( (select count(*)::int from public.files), 2,
           'the uploader sees their own quarantined file too' );
select is( (select count(*)::int from public.ingest_jobs), 1,
           'the uploader sees their own ingest job' );

-- ---- as the expired member: everything goes dark ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f3"}';
select ok( not public.is_active_member(), 'an expired member is not active' );
select is( (select count(*)::int from public.files), 0,
           'an expired member sees no files at all' );

select * from finish();
rollback;
