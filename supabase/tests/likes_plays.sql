begin;
select plan(23);

-- allowlist BEFORE auth.users: handle_new_user() raises 'not allowlisted'
-- otherwise, and the on_auth_user_created trigger provisions public.members
-- itself -- so members rows are never inserted by hand here, only updated.
insert into public.allowlist (email) values ('lk1@gmail.com'), ('lk2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1','lk1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2','lk2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000c1',
                   '00000000-0000-0000-0000-0000000000c2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000cb','00000000-0000-0000-0000-0000000000c1');

-- af01/af02: pool-visible (stored), the two files under test -- af01 ends up
-- with 2 likes / 1 play, af02 with 1 like / 2 plays, so likes_desc and
-- plays_desc disagree on which file sorts first (proves each sort reads its
-- own column, not a shared/accidentally-correlated one).
-- af03: NOT pool-visible (failed) -- proves the P0002 gate on both RPCs.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000af01','00000000-0000-0000-0000-0000000000cb',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/c1/af01.flac','Liked.flac', 1000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000af02','00000000-0000-0000-0000-0000000000cb',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/c1/af02.flac','Played.flac', 1000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000af03','00000000-0000-0000-0000-0000000000cb',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/c1/af03.flac','Failed.flac',  1000, 'flac', 'failed');

-- pool_tracks LEFT JOINs audio_analysis (migration 16b) so this is not
-- strictly required for either stored file to appear, but every other
-- fixture in this suite gives its stored files an analysis row and there is
-- no reason for this one to be the exception.
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000af01','v1', 300000, 128, '10A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000af02','v1', 300000, 128, '10A', '{}'::jsonb);

-- ---- schema + closure ----
select has_table('public', 'likes', 'likes exists');
select has_table('public', 'play_events', 'play_events exists');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

-- The anonymity proof is structural: no other test in this file may read
-- likes/play_events directly -- if a future grant appears, these three fail.
select throws_ok(
  $$insert into public.likes (file_id, user_id)
    values ('00000000-0000-0000-0000-000000000001', auth.uid())$$,
  '42501', null, 'direct INSERT into likes denied');
select throws_ok(
  $$select * from public.likes$$,
  '42501', null, 'direct SELECT from likes denied');
select throws_ok(
  $$select * from public.play_events$$,
  '42501', null, 'direct SELECT from play_events denied');

-- ---- toggle_like: delete-first toggle, count reflects all members ----
select results_eq(
  $$ select * from public.toggle_like('00000000-0000-0000-0000-00000000af01') $$,
  $$ values (1::bigint, true) $$,
  'the first toggle_like on a fresh file inserts and returns (1, true)' );
select results_eq(
  $$ select * from public.toggle_like('00000000-0000-0000-0000-00000000af01') $$,
  $$ values (0::bigint, false) $$,
  'a second toggle_like on the same (file, member) deletes and returns (0, false)' );
select results_eq(
  $$ select * from public.toggle_like('00000000-0000-0000-0000-00000000af01') $$,
  $$ values (1::bigint, true) $$,
  'a third toggle_like re-likes -- c1 now likes af01 again' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2"}';
select results_eq(
  $$ select * from public.toggle_like('00000000-0000-0000-0000-00000000af01') $$,
  $$ values (2::bigint, true) $$,
  'a second member liking the same file raises the count to 2, not restarting at 1' );
select results_eq(
  $$ select * from public.toggle_like('00000000-0000-0000-0000-00000000af02') $$,
  $$ values (1::bigint, true) $$,
  'c2 liking af02 (which c1 never liked) returns (1, true)' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';
select throws_ok(
  $$ select public.toggle_like('00000000-0000-0000-0000-00000000af03') $$,
  'P0002', null,
  'toggle_like refuses a file whose state is not pool-visible (failed)' );

set local role anon;
select throws_ok(
  $$ select public.toggle_like('00000000-0000-0000-0000-00000000af01') $$,
  '42501', null,
  'anon cannot execute toggle_like' );
select throws_ok(
  $$ select public.bump_play('00000000-0000-0000-0000-00000000af01') $$,
  '42501', null,
  'anon cannot execute bump_play' );

-- ---- bump_play: one INSERT per call, proven only via the pool-side count
-- (never by selecting play_events directly) ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';
select public.bump_play('00000000-0000-0000-0000-00000000af01');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2"}';
select public.bump_play('00000000-0000-0000-0000-00000000af02');
select public.bump_play('00000000-0000-0000-0000-00000000af02');

select throws_ok(
  $$ select public.bump_play('00000000-0000-0000-0000-00000000af03') $$,
  'P0002', null,
  'bump_play refuses a file whose state is not pool-visible (failed)' );

select is( (select play_count from public.pool_get('00000000-0000-0000-0000-00000000af01')),
           1,
           'af01 has exactly one play_events row after exactly one bump_play call' );
select is( (select play_count from public.pool_get('00000000-0000-0000-0000-00000000af02')),
           2,
           'af02 has exactly two play_events rows after exactly two bump_play calls -- a counter, not idempotent' );

-- ---- pool_list: likes_desc and plays_desc read different columns ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';
select is( (select file_id from public.pool_list(p_sort => 'likes_desc', p_limit => 1)),
           '00000000-0000-0000-0000-00000000af01'::uuid,
           'likes_desc orders the 2-liked file (af01) before the 1-liked file (af02)' );
select is( (select file_id from public.pool_list(p_sort => 'plays_desc', p_limit => 1)),
           '00000000-0000-0000-0000-00000000af02'::uuid,
           'plays_desc orders the 2-played file (af02) before the 1-played file (af01)' );

select is( (select like_count from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000af01'),
           2,
           'pool_list exposes like_count as the total across both members' );
select is( (select play_count from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000af02'),
           2,
           'pool_list exposes play_count as the total across both members' );

-- ---- liked_by_me is per-caller, not a global flag ----
select is( (select liked_by_me from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000af01'),
           true,
           'liked_by_me is true for c1 on af01 -- c1 liked it' );
select is( (select liked_by_me from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000af02'),
           false,
           'liked_by_me is false for c1 on af02 -- only c2 liked it' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2"}';
select is( (select liked_by_me from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000af02'),
           true,
           'liked_by_me is true for c2 on af02 -- the flag flips with the caller, not the file' );

select * from finish();
rollback;
