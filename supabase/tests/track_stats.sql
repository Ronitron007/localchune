begin;
select plan(11);

-- Two active members. b1 is the uploader; b2 exists to prove "any member's
-- downloads count" and to seed the two-member claims fixture for
-- upload_count.
insert into public.allowlist (email) values ('ts1@gmail.com'), ('ts2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1','ts1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000b2','ts2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000b1',
                   '00000000-0000-0000-0000-0000000000b2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000b1');

-- bf01: pool-visible (stored), the file under test.
-- bf02: NOT pool-visible (failed) -- proves bump_download refuses a
-- hidden/failed file even though the row exists.
-- bf03: pool-visible, never downloaded -- proves the coalesced-0 default.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000bf01','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000b1',
   'audio/b1/bf01.flac','Downloaded.flac', 1000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000bf02','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000b1',
   'audio/b1/bf02.flac','Failed.flac',     1000, 'flac', 'failed'),
  ('00000000-0000-0000-0000-00000000bf03','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000b1',
   'audio/b1/bf03.flac','NeverDownloaded.flac', 1000, 'flac', 'stored');

-- pool_tracks INNER JOINs audio_analysis -- a file with no analysis row
-- never appears in the view at all, so both stored files need one.
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000bf01','v1', 300000, 128, '10A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000bf03','v1', 300000, 128, '10A', '{}'::jsonb);

-- The two-member claims fixture for upload_count: bf01 was uploaded by b1
-- (the claim ingest_finalize would have written) and independently claimed
-- by b2 (the row M4's dedupe would insert -- written by hand here exactly
-- as storage_accounting.sql already does for the same reason).
insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-00000000bf01','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000bb'),
  ('00000000-0000-0000-0000-00000000bf01','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000bb');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1"}';

-- ---- bump increments; twice = 2 -- a counter, not idempotent ----
select is( public.bump_download('00000000-0000-0000-0000-00000000bf01'), 1::bigint,
           'the first bump_download on a fresh file returns 1' );
select is( public.bump_download('00000000-0000-0000-0000-00000000bf01'), 2::bigint,
           'a second bump_download on the same file returns 2, not 1 -- counters, not idempotent' );

-- ---- any active member's downloads count, not just the uploader's ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2"}';
select is( public.bump_download('00000000-0000-0000-0000-00000000bf01'), 3::bigint,
           'a non-uploading member''s download bumps the SAME counter -- no ownership check' );

-- ---- bump on a non-pool-visible file is refused ----
select throws_ok(
  $$ select public.bump_download('00000000-0000-0000-0000-00000000bf02') $$,
  'P0002', null,
  'bump_download refuses a file whose state is not pool-visible (failed)' );

-- ---- anon cannot execute at all -- 42501 before the body ever runs ----
set local role anon;
select throws_ok(
  $$ select public.bump_download('00000000-0000-0000-0000-00000000bf01') $$,
  '42501', null,
  'anon cannot execute bump_download' );

-- ---- track_stats itself stays closed -- reachable only via the definer
-- function and the (ungranted) view, never by a direct client SELECT.
-- Regression guard for the revoke-first grant, same shape as
-- rls_reachable.sql's allowlist assertion. ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1"}';
select throws_ok(
  $$ select 1 from public.track_stats limit 1 $$,
  '42501', null,
  'track_stats has no base grant to authenticated -- reachable only through bump_download/pool_get' );

-- ---- the view exposes both counts correctly ----
select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000bf01')),
           3::bigint,
           'pool_get reports the download_count that bump_download actually accumulated' );
select is( (select upload_count from public.pool_get('00000000-0000-0000-0000-00000000bf01')),
           2,
           'pool_get reports upload_count as the live count(*) from file_claims -- two members, two' );

-- coalesced 0, never null, for a file nobody has downloaded yet.
select is( (select download_count from public.pool_get('00000000-0000-0000-0000-00000000bf03')),
           0::bigint,
           'a file with no track_stats row reports download_count 0, not null' );
select is( (select upload_count from public.pool_get('00000000-0000-0000-0000-00000000bf03')),
           0,
           'a file with no claims reports upload_count 0' );

-- pool_list (the pool table's feed) carries download_count too.
select is( (select download_count from public.pool_list() where file_id = '00000000-0000-0000-0000-00000000bf01'),
           3::bigint,
           'pool_list exposes download_count for the pool table''s Downloads column' );

select * from finish();
rollback;
