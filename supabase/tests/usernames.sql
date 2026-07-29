begin;
select plan(13);

-- Two active members. e1 claims a username (and is later promoted to owner
-- to prove admin_members() surfaces it); e2 exists to prove the reserved
-- list and the uniqueness check against e1's already-claimed name.
insert into public.allowlist (email) values ('un1@gmail.com'), ('un2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','un1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','un2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000e1',
                   '00000000-0000-0000-0000-0000000000e2');

-- e1 is promoted to owner here, up front, alongside the rest of the
-- privileged fixture setup -- authenticated has no UPDATE grant on members
-- (migration 10) so this cannot happen after the role switch below. Being
-- owner does not change any of e1's format/reserved/set-once assertions
-- (is_active_member() already passes), it only unlocks the admin_members()
-- check at the end of this file.
update public.members set role = 'owner'
 where user_id = '00000000-0000-0000-0000-0000000000e1';

-- Fixture for the view assertion below, inserted BEFORE the role switch --
-- authenticated has no base INSERT grant on these tables (migration 10),
-- same ordering every other fixture file in this suite already uses.
insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000eb','00000000-0000-0000-0000-0000000000e1');
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000ef01','00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/e1/ef01.flac','Track.flac', 1000, 'flac', 'stored');
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values ('00000000-0000-0000-0000-00000000ef01','v1', 300000, 128, '10A', '{}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

-- ---- format: one message, five inputs that must all fail it ----
select throws_ok(
  $$ select public.username_set('ab') $$,
  '22023', null,
  'a 2-character username is refused -- the floor is 3' );
select throws_ok(
  $$ select public.username_set('abcdefghijklmnopqrstu') $$,
  '22023', null,
  'a 21-character username is refused -- the ceiling is 20' );
select throws_ok(
  $$ select public.username_set('1abcde') $$,
  '22023', null,
  'a username starting with a digit is refused' );
select throws_ok(
  $$ select public.username_set('a b cde') $$,
  '22023', null,
  'a username containing a space is refused' );
select throws_ok(
  $$ select public.username_set('a-b-cde') $$,
  '22023', null,
  'a username containing a hyphen is refused' );

-- ---- happy path: uppercase input is lowercased before every check, and
-- storage is canonically lowercase ----
select is( public.username_set('RohanM'), 'rohanm',
           'uppercase input is canonicalised to lowercase before storage' );
select is( (select username from public.current_member()), 'rohanm',
           'current_member reflects the username the claim just set' );

-- ---- the view swaps in the username wherever it showed the email local
-- part -- pool_view.sql already proves the pre-claim fallback ----
select is( (select uploader_name from public.pool_get('00000000-0000-0000-0000-00000000ef01')),
           'rohanm',
           'pool_get shows the username, not the email local part, once one is set' );

-- ---- reserved: checked against the LOWERCASED value, so uppercase input
-- cannot smuggle a reserved name past the check ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select throws_ok(
  $$ select public.username_set('ADMIN') $$,
  '22023', 'that username is reserved',
  'a reserved name is refused even typed in uppercase -- lowercasing happens before the reserved check' );

-- ---- duplicate: a friendly message, never the raw 23505 constraint text ----
select throws_ok(
  $$ select public.username_set('RohanM') $$,
  '23505', 'that username is already taken',
  'a second member claiming the same (canonicalised) name gets a friendly error, not the raw constraint text' );

-- ---- set-once: the first member cannot claim a second time ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select throws_ok(
  $$ select public.username_set('someoneelse') $$,
  'P0001', 'username is already set and cannot be changed',
  'a member who already has a username cannot set a different one' );

-- ---- anon cannot execute at all -- 42501 before the body ever runs ----
set local role anon;
select throws_ok(
  $$ select public.username_set('whatever') $$,
  '42501', null,
  'anon cannot execute username_set' );

-- ---- admin_members() surfaces the username column for the owner's table ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select is( (select username from public.admin_members() where email = 'un1@gmail.com'),
           'rohanm',
           'admin_members exposes the claimed username next to the allowlist email' );

select * from finish();
rollback;
