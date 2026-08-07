-- supabase/tests/bump_downloads.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- Migration 36's batch counter. Proves the three things the crate download
-- depends on: it counts (once per occurrence, per call), it never counts a
-- file that is not pool-visible, and no unauthenticated role can reach it.

begin;
select plan(14);

-- Two active members: d1 uploads, d2 exists to prove the "any member's
-- download counts" rule survives the batch form.
insert into public.allowlist (email) values ('bd1@gmail.com'), ('bd2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','bd1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000d2','bd2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000d1',
                   '00000000-0000-0000-0000-0000000000d2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000dd','00000000-0000-0000-0000-0000000000d1');

-- cf01/cf02: pool-visible, the crate's real members.
-- cf03: 'deleted' -- migration 33's tombstone. The batch must SKIP it,
--       where bump_download would have raised P0002 on it.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000cf01','00000000-0000-0000-0000-0000000000dd',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf01.flac','One.flac',   1000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000cf02','00000000-0000-0000-0000-0000000000dd',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf02.flac','Two.flac',   1000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000cf03','00000000-0000-0000-0000-0000000000dd',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf03.flac','Gone.flac',  1000, 'flac', 'deleted');

-- The fixture's own precondition, asserted as the test role (which is not
-- subject to files' RLS) before any role switch: cf03 really is outside
-- pool_visible_states(), so "skipped" below means skipped for that reason
-- and not because the id was wrong.
select is(
  (select count(*)::int from public.files f
    where f.id = '00000000-0000-0000-0000-00000000cf03'
      and f.state = any (public.pool_visible_states())),
  0,
  'the fixture holds: the tombstoned file is outside pool_visible_states()' );

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

-- ---- the ordinary crate case: every named file bumped, once ----
select is(
  public.bump_downloads(array['00000000-0000-0000-0000-00000000cf01',
                              '00000000-0000-0000-0000-00000000cf02']::uuid[]),
  2::bigint,
  'bump_downloads reports the two rows it bumped' );

select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000cf01')),
           1::bigint,
           'the first track of the crate counted exactly once' );
select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000cf02')),
           1::bigint,
           'the second track of the crate counted exactly once' );

-- ---- a counter, not idempotent: downloading the crate again is a second
-- download of each of its tracks ----
select lives_ok(
  $$ select public.bump_downloads(array['00000000-0000-0000-0000-00000000cf01',
                                        '00000000-0000-0000-0000-00000000cf02']::uuid[]) $$,
  'a second crate download runs clean' );
select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000cf01')),
           2::bigint,
           'downloading the crate twice reads back 2, not 1 -- a counter, like bump_download' );

-- ---- any active member's download counts, exactly as the single form ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select is(
  public.bump_downloads(array['00000000-0000-0000-0000-00000000cf01']::uuid[]),
  1::bigint,
  'a non-uploading member bumps the same counter -- no ownership check' );
select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000cf01')),
           3::bigint,
           'the non-uploader''s download landed on the SAME counter' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

-- ---- a duplicated id counts twice AND does not error.
-- ON CONFLICT DO UPDATE cannot touch one row twice in a statement (21000);
-- the pre-aggregation in migration 36 is what turns that into +2. ----
select is(
  public.bump_downloads(array['00000000-0000-0000-0000-00000000cf02',
                              '00000000-0000-0000-0000-00000000cf02']::uuid[]),
  1::bigint,
  'a repeated id is one ROW bumped, not an ON CONFLICT error' );
-- cf02 stood at 2 (the two whole-crate downloads above), so the repeated
-- id must take it to 4, not 3.
select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000cf02')),
           4::bigint,
           'a repeated id adds 2, not 1 -- two copies in one archive are two downloads' );

-- ---- a tombstoned file is skipped, and gets no track_stats row at all ----
select is(
  public.bump_downloads(array['00000000-0000-0000-0000-00000000cf01',
                              '00000000-0000-0000-0000-00000000cf03']::uuid[]),
  1::bigint,
  'a non-pool-visible file is skipped -- one row bumped out of two named' );

-- ---- an empty array is a legal no-op, not an error: the route calls this
-- before it knows whether every object still exists ----
select is( public.bump_downloads(array[]::uuid[]), 0::bigint,
           'an empty array bumps nothing and returns 0' );

-- ---- the runaway ceiling ----
select throws_ok(
  $$ select public.bump_downloads(
       (select array_agg('00000000-0000-0000-0000-00000000cf01'::uuid)
          from generate_series(1, 501)) ) $$,
  '22023', null,
  'bump_downloads refuses more than 500 ids in one call' );

-- ---- anon cannot execute at all -- 42501 before the body ever runs.
-- This is the revoke-first proof: hosted Supabase grants EXECUTE on a new
-- function to public/anon by default (CLAUDE.md), so without the REVOKE in
-- migration 36 this call would succeed. ----
set local role anon;
select throws_ok(
  $$ select public.bump_downloads(array['00000000-0000-0000-0000-00000000cf01']::uuid[]) $$,
  '42501', null,
  'anon cannot execute bump_downloads' );

select * from finish();
rollback;
