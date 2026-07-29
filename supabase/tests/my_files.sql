begin;
select plan(14);

-- Two members. d1 is the caller under test; d2 exists only to prove their
-- rows never leak into d1's list.
insert into public.allowlist (email) values ('mf1@gmail.com'), ('mf2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','mf1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000d2','mf2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000d1',
                   '00000000-0000-0000-0000-0000000000d2');

insert into public.upload_batches (id, created_by, label) values
  ('00000000-0000-0000-0000-0000000000db','00000000-0000-0000-0000-0000000000d1','set one');

-- d1's three files, spread across time so newest-first and keyset paging
-- have something real to prove: a stored+analysed one, a failed one with a
-- recorded reason, and one still pending.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state, created_at)
values
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/f1.flac','ready.flac',   1000, 'flac', 'stored',  now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/f2.mp3', 'broken.mp3',    500, 'mp3',  'failed',  now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/f3.wav', 'waiting.wav',   700, 'wav',  'pending', now());

-- d2's own file. Must never appear in d1's my_files().
insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000dc','00000000-0000-0000-0000-0000000000d2');
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000f9','00000000-0000-0000-0000-0000000000dc',
   '00000000-0000-0000-0000-0000000000d2',
   'audio/d2/f9.flac','other.flac', 900, 'flac', 'stored');

insert into public.ingest_jobs (file_id, batch_id, user_id, declared_byte_size, multipart, last_error)
values ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000db',
        '00000000-0000-0000-0000-0000000000d1', 500, false, 'empty_decode');

insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values ('00000000-0000-0000-0000-0000000000f1','v1', 200000, 128.4, '8B', '{}'::jsonb);

-- Seed 5 files with identical created_at for composite cursor testing.
-- These are inserted as postgres before the role switch to authenticated.
with tied_ts as (select now() as ts)
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state, created_at)
values
  ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1', 'audio/d1/tied5.flac', 'tied5.flac',
   1000, 'flac', 'stored', (select ts from tied_ts)),
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1', 'audio/d1/tied4.flac', 'tied4.flac',
   1000, 'flac', 'stored', (select ts from tied_ts)),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1', 'audio/d1/tied3.flac', 'tied3.flac',
   1000, 'flac', 'stored', (select ts from tied_ts)),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1', 'audio/d1/tied2.flac', 'tied2.flac',
   1000, 'flac', 'stored', (select ts from tied_ts)),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1', 'audio/d1/tied1.flac', 'tied1.flac',
   1000, 'flac', 'stored', (select ts from tied_ts));

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

-- ---- the assertion that matters: only the caller's own rows ----
select is( (select count(*)::int from public.my_files()), 8,
           'the caller sees all 8 of their files (3 original + 5 tied)' );
select is( (select count(*)::int from public.my_files()
             where file_id = '00000000-0000-0000-0000-0000000000f9'), 0,
           'another member''s file never appears' );

-- ---- what each row carries ----
select is( (select f.last_error from public.my_files() f
             where f.file_id = '00000000-0000-0000-0000-0000000000f2'),
           'empty_decode',
           'the failed row''s last_error comes back verbatim' );
select is( (select f.bpm from public.my_files() f
             where f.file_id = '00000000-0000-0000-0000-0000000000f1'),
           128.4::real,
           'the stored row''s bpm comes back' );
select is( (select f.key_camelot from public.my_files() f
             where f.file_id = '00000000-0000-0000-0000-0000000000f1'),
           '8B',
           'the stored row''s key comes back' );
select is( (select f.batch_label from public.my_files() f
             where f.file_id = '00000000-0000-0000-0000-0000000000f1'),
           'set one',
           'the batch label comes through when the batch has one' );
select is( (select f.last_error from public.my_files() f
             where f.file_id = '00000000-0000-0000-0000-0000000000f1'),
           null::text,
           'a row with no ingest_jobs error reports null, not an empty string' );

-- ---- ordering: newest first ----
select is( (select array_agg(f.file_id order by f.created_at desc) from public.my_files() f),
           array['00000000-0000-0000-0000-0000000000f3'::uuid,
                 '00000000-0000-0000-0000-000000000005'::uuid,
                 '00000000-0000-0000-0000-000000000004'::uuid,
                 '00000000-0000-0000-0000-000000000003'::uuid,
                 '00000000-0000-0000-0000-000000000002'::uuid,
                 '00000000-0000-0000-0000-000000000001'::uuid,
                 '00000000-0000-0000-0000-0000000000f2'::uuid,
                 '00000000-0000-0000-0000-0000000000f1'::uuid],
           'newest first (f3 + 5 tied rows @ now, then f2 @ 1h ago, then f1 @ 2h ago)' );

-- ---- keyset pagination on (created_at, id) ----
select is( (select array_agg(x.file_id) from (select f.file_id from public.my_files(p_limit => 1) f) x),
           array['00000000-0000-0000-0000-0000000000f3'::uuid],
           'p_limit=1 returns just the newest file' );
select is( (select count(*)::int from public.my_files(
              p_before => (select f.created_at from public.files f
                            where f.id = '00000000-0000-0000-0000-0000000000f3'))),
           2,
           'p_before excludes the row it was read from and returns the older two' );

-- ---- composite keyset cursor: tied timestamps no longer skip rows ----
-- When all tied rows + f3 (which also has created_at=now()) are paginated:
-- Page 1 limit=3 returns: [f3, tied5, tied4]. Filtering for tied: 2 rows.
-- Using the cursor from tied4, page 2 returns: [tied3, tied2, tied1, f2].
-- Limited to 3, that's [tied3, tied2, tied1]. Filtering for tied: 3 rows.
-- Total tied across pages: 2 + 3 = 5. No rows skipped despite tied timestamps.

-- Page 1: get first 3 rows overall (includes f3 and 2 tied), filter to tied.
with page1 as (
  select f.file_id, f.created_at
    from public.my_files(p_limit => 3) f
   where f.file_id in (select id from public.files where r2_key like 'audio/d1/tied%')
)
select is(
  (select count(*)::int from page1),
  2,
  'page 1 with tied timestamps returns 2 tied rows (f3 + tied5 + tied4 total, 2 are tied)' );

-- Page 2: continue with composite cursor from the last tied row from page 1.
with page1_all as (
  select f.file_id, f.created_at
    from public.my_files(p_limit => 3) f
),
cursor_from_page1 as (
  select f.created_at, f.file_id
    from page1_all f
   where f.file_id in (select id from public.files where r2_key like 'audio/d1/tied%')
   order by f.created_at desc, f.file_id desc
   limit 1
),
page2 as (
  select f.file_id, f.created_at
    from public.my_files(
           p_limit => 3,
           p_before => (select c.created_at from cursor_from_page1 c),
           p_before_id => (select c.file_id from cursor_from_page1 c)
         ) f
   where f.file_id in (select id from public.files where r2_key like 'audio/d1/tied%')
)
select is(
  (select count(*)::int from page2),
  3,
  'page 2 with composite cursor returns remaining 3 tied rows (no skip)' );

-- ---- a second member sees only their own single row ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select is( (select count(*)::int from public.my_files()), 1,
           'the second member sees only their own single file' );

-- ---- anon cannot execute at all -- 42501 before the body ever runs ----
set local role anon;
select throws_ok( $$ select * from public.my_files() $$, '42501', null::text,
                  'anon cannot execute my_files' );

select * from finish();
rollback;
