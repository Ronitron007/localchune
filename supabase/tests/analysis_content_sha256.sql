-- supabase/tests/analysis_content_sha256.sql
-- localchune — MIT licensed. See LICENSE.
--
-- Migration 19: analysis_persist() writes files.content_sha256, PRD §6's
-- layer-0 dedup key, which has been NULL on every row since M2.
--
-- The column is UNIQUE, so the interesting cases are all about what happens
-- when two files hash the same. A collision is layer 0 FIRING, not an
-- error: it must never raise 23505 and throw away a ~45 vCPU-s analysis at
-- its very last step.

begin;
select plan(17);

insert into public.allowlist (email) values ('sha1@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','sha1@gmail.com');
insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000d1');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/00000000-0000-0000-0000-0000000000d1/00000000-0000-0000-0000-0000000000e1.flac',
   'original.flac', 40000000, 'flac', 'received'),
  -- The byte-identical re-upload. Same audio, different member's copy.
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/00000000-0000-0000-0000-0000000000d1/00000000-0000-0000-0000-0000000000e2.flac',
   'duplicate.flac', 40000000, 'flac', 'received'),
  ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/00000000-0000-0000-0000-0000000000d1/00000000-0000-0000-0000-0000000000e3.flac',
   'other.flac', 30000000, 'flac', 'received');

-- Two real-shaped digests: 64 lower-case hex characters.
create temporary view sha as select
  repeat('a1', 32) as a,
  repeat('b2', 32) as b;

-- ---- the happy path: the digest lands, and so does thumb_key ----
select is(
  public.analysis_persist(jsonb_build_object(
    'file_id', '00000000-0000-0000-0000-0000000000e1',
    'analysis_version', 'v2', 'ok', true, 'duration_ms', 360000,
    'container', 'flac', 'codec', 'flac', 'sample_rate', 44100,
    'bit_depth', 16, 'channels', 2,
    'forensics', jsonb_build_object(
      'meas_cutoff_hz', 21500, 'meas_cliff_db_500', 3.5,
      'lossy_ancestor', 'none', 'tier', 5, 'quality_score', 520.4),
    'peaks_key', 'peaks.json', 'artwork_key', 'artwork.jpg',
    'thumb_key', 'thumb.jpg', 'cpu_seconds', 48.0,
    'content_sha256', (select a from sha))),
  'stored',
  'analysis_persist stores a result carrying content_sha256' );

select is( (select f.content_sha256 from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e1'),
           decode(repeat('a1', 32), 'hex'),
           'the hex digest is decoded into the bytea column, not stored as text' );

-- MIGRATION-14 REGRESSION PIN. Migration 19 re-creates analysis_persist from
-- migration 14's body, not migration 09's. Starting from 09 would silently
-- drop the thumb_key write and every pool row would render the empty box
-- with no error anywhere. This assertion is the only thing that would say so.
select is( (select a.thumb_key from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000e1'), 'thumb.jpg',
           'migration 19 carried migration 14''s thumb_key write, not migration 09''s body' );

-- Forensics is real now, so the tier written alongside it is too.
select is( (select f.quality_tier from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e1'), 5::smallint,
           'a real forensics verdict writes a real tier onto files' );

-- ---- the collision: layer 0 firing, not an error ----
select lives_ok(
  $$ select public.analysis_persist(jsonb_build_object(
       'file_id', '00000000-0000-0000-0000-0000000000e2',
       'analysis_version', 'v2', 'ok', true, 'duration_ms', 360000,
       'container', 'flac', 'codec', 'flac', 'sample_rate', 44100,
       'channels', 2, 'peaks_key', 'peaks.json', 'cpu_seconds', 47.0,
       'content_sha256', repeat('a1', 32))) $$,
  'a byte-identical re-upload does NOT raise 23505 at the last step of a 45 vCPU-s analysis' );

select ok( (select f.content_sha256 is null from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e2'),
           'the second row keeps a NULL digest -- dedup_resolve reads the collision off the incumbent' );

select is( (select f.content_sha256 from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e1'),
           decode(repeat('a1', 32), 'hex'),
           'and the incumbent''s digest is untouched by the collision' );

select is( (select f.state from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e2'), 'stored',
           'the colliding file still reaches stored -- its analysis was perfectly good' );

-- ---- a payload with no digest must not ERASE one ----
select is(
  public.analysis_persist(jsonb_build_object(
    'file_id', '00000000-0000-0000-0000-0000000000e1',
    'analysis_version', 'v2', 'ok', true, 'duration_ms', 360000,
    'container', 'flac', 'codec', 'flac', 'sample_rate', 44100,
    'channels', 2, 'peaks_key', 'peaks.json', 'cpu_seconds', 48.0)),
  'stored',
  'an OLD container answering the NEW function is a normal, storable result' );

select is( (select f.content_sha256 from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e1'),
           decode(repeat('a1', 32), 'hex'),
           'a missing content_sha256 leaves the stored digest alone rather than nulling it' );

-- The empty string is the dangerous one: decode('', 'hex') is a valid EMPTY
-- bytea, not NULL, so two such rows would collide on the UNIQUE index for a
-- reason that has nothing to do with their audio.
select is(
  public.analysis_persist(jsonb_build_object(
    'file_id', '00000000-0000-0000-0000-0000000000e3',
    'analysis_version', 'v2', 'ok', true, 'duration_ms', 300000,
    'container', 'flac', 'codec', 'flac', 'sample_rate', 44100,
    'channels', 2, 'peaks_key', 'peaks.json', 'cpu_seconds', 44.0,
    'content_sha256', '')),
  'stored',
  'an empty content_sha256 is storable' );

select ok( (select f.content_sha256 is null from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e3'),
           'an empty digest is NOT decoded into an empty bytea that would collide with the next one' );

-- ---- a malformed digest is no digest ----
select is(
  public.analysis_persist(jsonb_build_object(
    'file_id', '00000000-0000-0000-0000-0000000000e3',
    'analysis_version', 'v2', 'ok', true, 'duration_ms', 300000,
    'container', 'flac', 'codec', 'flac', 'sample_rate', 44100,
    'channels', 2, 'peaks_key', 'peaks.json', 'cpu_seconds', 44.0,
    'content_sha256', 'NOTHEX' || repeat('a1', 29))),
  'stored',
  'a malformed digest does not raise -- decode() would have thrown 22023 mid-analysis' );

select ok( (select f.content_sha256 is null from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000e3'),
           'and a half-decoded digest never reaches a UNIQUE column' );

-- ---- a genuinely different digest is stored alongside ----
select is(
  public.analysis_persist(jsonb_build_object(
    'file_id', '00000000-0000-0000-0000-0000000000e3',
    'analysis_version', 'v2', 'ok', true, 'duration_ms', 300000,
    'container', 'flac', 'codec', 'flac', 'sample_rate', 44100,
    'channels', 2, 'peaks_key', 'peaks.json', 'cpu_seconds', 44.0,
    'content_sha256', repeat('b2', 32))),
  'stored',
  'a re-analysis fills in the digest the previous run could not' );

-- ---- the ACL, restated because migration 19 restates it ----
-- create or replace preserves a function's ACL, so this would pass even if
-- migration 19 had dropped its revoke/grant pair. It is asserted anyway: a
-- hosted project grants execute on new functions to everyone, and the day
-- someone replaces this with `drop function` + `create function` is the day
-- it stops being true.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select throws_ok(
  $$ select public.analysis_persist('{}'::jsonb) $$,
  '42501', NULL,
  'authenticated cannot execute analysis_persist -- mutations are service_role only' );
select throws_ok(
  $$ update public.files set content_sha256 = decode(repeat('c3', 32), 'hex') $$,
  '42501', NULL,
  'nor write the dedup key directly -- a member could otherwise claim another file''s bytes' );

select * from finish();
rollback;
