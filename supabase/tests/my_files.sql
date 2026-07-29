begin;
select plan(12);

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

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

-- ---- the assertion that matters: only the caller's own rows ----
select is( (select count(*)::int from public.my_files()), 3,
           'the caller sees exactly their own three files' );
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
                 '00000000-0000-0000-0000-0000000000f2'::uuid,
                 '00000000-0000-0000-0000-0000000000f1'::uuid],
           'newest first' );

-- ---- keyset pagination on (created_at, id) ----
select is( (select array_agg(x.file_id) from (select f.file_id from public.my_files(p_limit => 1) f) x),
           array['00000000-0000-0000-0000-0000000000f3'::uuid],
           'p_limit=1 returns just the newest file' );
select is( (select count(*)::int from public.my_files(
              p_before => (select f.created_at from public.files f
                            where f.id = '00000000-0000-0000-0000-0000000000f3'))),
           2,
           'p_before excludes the row it was read from and returns the older two' );

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
