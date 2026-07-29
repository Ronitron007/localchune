begin;
select plan(16);

-- Two active members. u1 uploads both files under test; u2 exists to prove
-- the in-body ownership check refuses a non-uploader.
insert into public.allowlist (email) values ('ft1@gmail.com'), ('ft2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1','ft1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000f2','ft2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000f1',
                   '00000000-0000-0000-0000-0000000000f2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-0000000000f1');

-- ff01: the tag_add/tag_remove/cap/dedupe fixture.
-- ff02: kept free of any title/artist/filename match on "techno" so the
-- q-search assertion below proves it is the TAG, not another column, doing
-- the matching.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000ff01','00000000-0000-0000-0000-0000000000fb',
   '00000000-0000-0000-0000-0000000000f1',
   'audio/f1/ff01.flac','Track One.flac', 1000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000ff02','00000000-0000-0000-0000-0000000000fb',
   '00000000-0000-0000-0000-0000000000f1',
   'audio/f1/ff02.flac','Track Two.flac', 1000, 'flac', 'stored');

-- pool_tracks INNER JOINs audio_analysis -- both stored files need one.
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000ff01','v1', 300000, 128, '10A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000ff02','v1', 300000, 128, '10A', '{}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';

-- Every assertion below reads back through pool_get/pool_list, never a
-- direct `select ... from file_tags` -- the table's ACL is closed (see the
-- last test in this file), so a direct read as `authenticated` would itself
-- raise 42501 and that is not what most of these assertions are testing.

-- ---- add, key derivation, exposure on pool_get ----
select public.tag_add('00000000-0000-0000-0000-00000000ff01', '  Deep   House  ');
select public.tag_add('00000000-0000-0000-0000-00000000ff02', 'Techno');

select is(
  (select tags from public.pool_get('00000000-0000-0000-0000-00000000ff01')),
  array['Deep House'],
  'tag_add trims/casefolds/collapses whitespace into tag_key while pool_get exposes tag_display verbatim' );

-- ---- exposed on pool_list too -- what TrackRow renders as chips ----
select is(
  (select tags from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000ff01'),
  array['Deep House'],
  'pool_list exposes tags for the pool row chips, same as pool_get' );

-- ---- q searches tag_key, not just artist/title/filename ----
select is(
  (select array_agg(l.file_id) from public.pool_list(p_q => 'techno') l),
  array['00000000-0000-0000-0000-00000000ff02'::uuid],
  'q matches a file by its tag and only that file -- "techno" appears nowhere else in the fixture' );

-- ---- casefold dedupe: "deep house" after "Deep House" is a no-op ----
select public.tag_add('00000000-0000-0000-0000-00000000ff01', 'deep house');
select is(
  (select tags from public.pool_get('00000000-0000-0000-0000-00000000ff01')),
  array['Deep House'],
  'casefold dedupe: adding "deep house" after "Deep House" changes nothing -- ON CONFLICT DO NOTHING, first casing wins' );

-- ---- cap: 32 chars ok, 33 refused ----
select throws_ok(
  $$ select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, repeat('x', 33)) $$,
  '22023', null,
  'a 33-character tag is refused -- the cap is 32' );

-- ---- empty tag refused ----
select throws_ok(
  $$ select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, '   ') $$,
  '22023', null,
  'a whitespace-only tag is refused as empty' );

-- ---- cap: 20 tags/file ----
-- ff01 already carries 1 ("deep house"); add 19 more distinct tags to reach 20.
select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, 'tag' || g.i::text)
  from generate_series(2, 20) as g(i);
select is(
  (select array_length(tags, 1) from public.pool_get('00000000-0000-0000-0000-00000000ff01')),
  20,
  'the file now carries 20 tags' );
select throws_ok(
  $$ select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, 'tag21') $$,
  '22023', null,
  'a 21st distinct tag is refused once the file already has 20' );
select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, 'TAG2');
select is(
  (select array_length(tags, 1) from public.pool_get('00000000-0000-0000-0000-00000000ff01')),
  20,
  're-adding an existing tag (even at the cap) is a no-op, not a cap violation' );

-- ---- remove ----
select public.tag_remove('00000000-0000-0000-0000-00000000ff01'::uuid, 'deep house');
select is(
  (select 'Deep House' = any(tags) from public.pool_get('00000000-0000-0000-0000-00000000ff01')),
  false,
  'tag_remove deletes the row by tag_key -- "Deep House" is gone from the exposed array' );
select is(
  (select array_length(tags, 1) from public.pool_get('00000000-0000-0000-0000-00000000ff01')),
  19,
  'the file now carries 19 tags after the remove' );
select lives_ok(
  $$ select public.tag_remove('00000000-0000-0000-0000-00000000ff01'::uuid, 'deep house') $$,
  'removing an already-absent tag_key is a silent no-op, not an error' );

-- ---- non-owner refused (in-body ownership check, not RLS) ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f2"}';
select throws_ok(
  $$ select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, 'not mine') $$,
  '42501', null,
  'a non-uploader cannot add a tag to another member''s file' );
select throws_ok(
  $$ select public.tag_remove('00000000-0000-0000-0000-00000000ff01'::uuid, 'tag2') $$,
  '42501', null,
  'a non-uploader cannot remove a tag from another member''s file' );

-- ---- anon cannot execute at all -- 42501 before the body ever runs ----
set local role anon;
select throws_ok(
  $$ select public.tag_add('00000000-0000-0000-0000-00000000ff01'::uuid, 'x') $$,
  '42501', null,
  'anon cannot execute tag_add' );

-- ---- file_tags itself stays closed -- reachable only via the definer
-- functions and the (ungranted) view, never a direct client SELECT.
-- Regression guard for the revoke-first grant, same shape as
-- track_stats.sql's assertion. ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';
select throws_ok(
  $$ select 1 from public.file_tags limit 1 $$,
  '42501', null,
  'file_tags has no base grant to authenticated -- reachable only through tag_add/tag_remove/pool_get' );

select * from finish();
rollback;
