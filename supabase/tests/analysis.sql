-- supabase/tests/analysis.sql
-- localchune — MIT licensed. See LICENSE.
--
-- Migration 09: audio_analysis, fingerprints, and the four service_role
-- entry points the queue consumer drives.

begin;
select plan(38);

-- allowlist BEFORE auth.users: handle_new_user() aborts with 'not
-- allowlisted' otherwise. The on_auth_user_created trigger then provisions
-- public.members, so members must NOT be inserted by hand here.
insert into public.allowlist (email) values
  ('an1@gmail.com'), ('an2@gmail.com'), ('anexp@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','an1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000a2','an2@gmail.com'),
  ('00000000-0000-0000-0000-0000000000a3','anexp@gmail.com');

update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000a3';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-0000000000a1');

-- created_at and state_changed_at are set explicitly on the two cron
-- fixtures: the whole point of a004 vs a003 is that they differ.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container,
   state, created_at, state_changed_at)
values
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000a1',
   'audio/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c1.flac',
   'WERK - B With U.flac', 40384234, 'flac', 'received', now(), now()),
  ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000a1',
   'audio/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c2.mp3',
   'fake-flac.mp3', 8000000, 'mp3', 'quarantined', now(), now()),
  -- A 3-hour-old row that entered 'analysing' one minute ago: a long
  -- multipart upload that has only just been handed to the worker. It must
  -- NOT be swept. created_at alone would sweep it.
  ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000a1',
   'audio/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c3.wav',
   'long-upload.wav', 900000000, 'wav', 'analysing',
   now() - interval '3 hours', now() - interval '1 minute'),
  -- Genuinely stuck: it has been 'analysing' for three hours.
  ('00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000a1',
   'audio/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c4.flac',
   'stuck.flac', 30000000, 'flac', 'analysing',
   now() - interval '3 hours', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000a1',
   'audio/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c5.wav',
   'ambient-drone.wav', 12000000, 'wav', 'received', now(), now()),
  ('00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000a1',
   'audio/00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000c6.m4a',
   'corrupt.m4a', 4000000, 'm4a', 'received', now(), now());

insert into public.ingest_jobs (file_id, batch_id, user_id, declared_byte_size, multipart)
select f.id, f.batch_id, f.uploaded_by, f.byte_size, false
  from public.files f where f.batch_id = '00000000-0000-0000-0000-0000000000ba';

-- ============================================================
-- As service_role: the consumer's own role.
-- ============================================================
set local role service_role;

-- ---- analysis_begin ----
select is( public.analysis_begin('00000000-0000-0000-0000-0000000000c1'), 'analysing',
           'analysis_begin moves received -> analysing' );
select is( public.analysis_begin('00000000-0000-0000-0000-0000000000c1'), 'analysing',
           'a replayed analysis_begin is a no-op, not an error (queues are at-least-once)' );
select throws_ok(
  $$ select public.analysis_begin('00000000-0000-0000-0000-0000000000ff') $$,
  'P0002', NULL,
  'analysis_begin on an unknown file raises rather than inventing a row' );

-- ---- analysis_persist: the full, healthy result ----
select is(
  public.analysis_persist($json${
    "file_id": "00000000-0000-0000-0000-0000000000c1",
    "analysis_version": "v1",
    "ok": true,
    "error": null,
    "duration_ms": 360000,
    "container": "flac",
    "codec": "flac",
    "sample_rate": 44100,
    "bit_depth": 16,
    "channels": 2,
    "fingerprint": {
      "algo_version": "cp-1.6.0/test2/11025",
      "duration_s": 360,
      "frame_count": 2886,
      "fp_compressed_b64": "AQAAB0kkiUk",
      "fp_sha256": "8f14e45fceea167a5a36dedd4bea2543",
      "query_items": [4000000000, 12, 4294967295]
    },
    "beats": {
      "bpm": 128.0,
      "bpm_median_ibi": 130.4348,
      "beat_count": 768,
      "ibi_std_ms": 1.5,
      "beat_grid": [0.5, 0.96875, 1.4375],
      "downbeat_grid": [0.5, 2.375],
      "confidence": 0.9375
    },
    "key": {
      "key": "C", "scale": "minor", "camelot": "5A", "open_key": "12m",
      "strength": 0.75,
      "alt_profiles": {"edma": "5A", "temperley": "5A", "krumhansl": "12A"}
    },
    "loudness": {
      "integrated_lufs": -8.25, "lra_lu": 4.5, "true_peak_dbtp": 0.75,
      "replaygain_db": -5.75, "clipped_pct": 1.0
    },
    "forensics": null,
    "tags": {"artist": "WERK", "title": "B With U"},
    "peaks_key": "peaks.json",
    "preview_key": null,
    "artwork_key": "artwork.jpg",
    "cpu_seconds": 53.5
  }$json$::jsonb),
  'stored',
  'analysis_persist stores the result and moves analysing -> stored' );

select is( (select count(*)::int from public.audio_analysis
             where file_id = '00000000-0000-0000-0000-0000000000c1'), 1,
           'exactly one audio_analysis row' );
select is( (select a.bpm from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'), 128.0::real,
           'bpm is the least-squares figure, stored exactly' );
select is( (select a.bpm_median_ibi from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'), 130.4348::real,
           'the median-IBI figure is kept alongside it for comparison' );
select is( (select a.beat_grid from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'),
           array[0.5, 0.96875, 1.4375]::real[],
           'beat_grid survives the jsonb round trip in order' );
select is( (select a.key_camelot from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'), '5A',
           'key_camelot is what the UI sorts on' );
select is( (select a.key_musical from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'), 'C minor',
           'key_musical is composed once, in SQL, from key + scale' );
select is( (select a.key_alt_profiles ->> 'krumhansl' from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'), '12A',
           'the two non-primary essentia profiles are kept' );
select is( (select a.peaks_key from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'), 'peaks.json',
           'the derived-artifact key is recorded, or the R2 object is an orphan' );
select ok( (select a.preview_key is null from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'),
           'a null preview_key stays null -- an mp3 gets no preview and that is not an error' );

-- ---- forensics is null today. Nothing may invent a tier. ----
select ok( (select a.quality_tier is null and a.lossy_ancestor is null
                  and a.quality_score is null and a.meas_cutoff_hz is null
              from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c1'),
           'forensics = null persists as NULLs, with no tier synthesised' );
select ok( (select f.quality_tier is null and f.quality_score is null
              from public.files f where f.id = '00000000-0000-0000-0000-0000000000c1'),
           'files.quality_tier is left null too, not defaulted to a passing grade' );

-- ---- the decoded truth is copied onto files ----
select is( (select f.duration_ms from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000c1'), 360000,
           'files.duration_ms is the DECODED duration, written only here' );
select is( (select f.sample_rate from public.files f
             where f.id = '00000000-0000-0000-0000-0000000000c1'), 44100,
           'files.sample_rate comes from the decode' );

-- ---- the fingerprint is kept, and its ints do not overflow ----
select is( (select g.query_items[3] from public.fingerprints g
             where g.file_id = '00000000-0000-0000-0000-0000000000c1'), 4294967295::bigint,
           'query_items is bigint[]: fpcalc emits UNSIGNED 32-bit ints (Task 4)' );
select is( (select g.frame_count from public.fingerprints g
             where g.file_id = '00000000-0000-0000-0000-0000000000c1'), 2886,
           'the fingerprint is stored so M4 need not re-run a 52 vCPU-s analysis' );

-- ---- replay: at-least-once must not duplicate ----
select is(
  public.analysis_persist($json${
    "file_id": "00000000-0000-0000-0000-0000000000c1",
    "analysis_version": "v1", "ok": true, "duration_ms": 360000,
    "container": "flac", "codec": "flac", "sample_rate": 44100,
    "bit_depth": 16, "channels": 2,
    "beats": {"bpm": 128.0, "bpm_median_ibi": 130.4348, "beat_count": 768,
              "ibi_std_ms": 1.5, "beat_grid": [0.5], "downbeat_grid": [0.5],
              "confidence": 0.9375},
    "key": null, "loudness": null, "forensics": null, "fingerprint": null,
    "tags": {}, "peaks_key": "peaks.json", "preview_key": null,
    "artwork_key": null, "cpu_seconds": 53.5
  }$json$::jsonb),
  'stored',
  'a replayed analysis_persist is a no-op transition, not an illegal one' );
select is( (select count(*)::int from public.audio_analysis
             where file_id = '00000000-0000-0000-0000-0000000000c1'), 1,
           'the replay updated the row rather than inserting a second one' );
select is( (select count(*)::int from public.fingerprints
             where file_id = '00000000-0000-0000-0000-0000000000c1'), 1,
           'and left the fingerprint alone rather than nulling it' );

-- ---- a degraded result is a result ----
select is( public.analysis_begin('00000000-0000-0000-0000-0000000000c5'), 'analysing',
           'the ambient track is claimed like any other' );
select is(
  public.analysis_persist($json${
    "file_id": "00000000-0000-0000-0000-0000000000c5",
    "analysis_version": "v1", "ok": true, "duration_ms": 180000,
    "container": "wav", "codec": "pcm_s16le", "sample_rate": 44100,
    "bit_depth": 16, "channels": 2,
    "beats": {"bpm": 0.0, "bpm_median_ibi": 0.0, "beat_count": 0,
              "ibi_std_ms": 0.0, "beat_grid": [], "downbeat_grid": [],
              "confidence": 0.0},
    "key": null, "loudness": null, "forensics": null, "fingerprint": null,
    "tags": {}, "peaks_key": "peaks.json", "preview_key": null,
    "artwork_key": null, "cpu_seconds": 21.0
  }$json$::jsonb),
  'stored',
  'a degraded analysis (bpm 0, confidence 0) still reaches stored' );
select is( (select a.bpm from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c5'), 0.0::real,
           'bpm 0 is stored as 0, not as null and not as a failure' );
select is( (select a.beat_grid from public.audio_analysis a
             where a.file_id = '00000000-0000-0000-0000-0000000000c5'), '{}'::real[],
           'an empty beat grid is an empty array -- "none found" is not "never computed"' );

-- ---- a failed analysis has no row ----
select throws_ok(
  $$ select public.analysis_persist('{"file_id":"00000000-0000-0000-0000-0000000000c6",
       "analysis_version":"v1","ok":false,"error":"decode failed"}'::jsonb) $$,
  '22023', NULL,
  'analysis_persist refuses an ok:false payload instead of writing a half row' );
select is( public.analysis_fail('00000000-0000-0000-0000-0000000000c6', 'decode failed'),
           'failed', 'analysis_fail moves the file to failed' );
select is( (select j.last_error from public.ingest_jobs j
             where j.file_id = '00000000-0000-0000-0000-0000000000c6'), 'decode failed',
           'and records why, where upload_batch_status() already reads it' );

-- ---- the stuck-job query filters state_changed_at, never created_at ----
select results_eq(
  $$ select s.file_id from public.analysis_stuck(interval '1 hour') s order by s.file_id $$,
  $$ values ('00000000-0000-0000-0000-0000000000c4'::uuid) $$,
  'analysis_stuck returns ONLY the row whose STATE went stale -- the 3-hour-old row that entered analysing a minute ago is not stuck' );

-- ============================================================
-- As a second active member: the analysis is readable exactly when its
-- file is.
-- ============================================================

-- One hand-written row for the quarantined file. It never went through
-- analysis_persist because a quarantined file is not in a state the
-- transition table allows; inserting it directly is the only way to prove
-- the policy hides it.
set local role postgres;
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot)
values ('00000000-0000-0000-0000-0000000000c2', 'v1', 200000, 174.0, '2A');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2"}';

-- A missing base GRANT raises 42501 "permission denied for table", NOT an
-- empty result. lives_ok is what tells the two apart, and it is the whole
-- reason this file exists: the draft schema enabled RLS and granted nothing.
select lives_ok( $$ select 1 from public.audio_analysis limit 1 $$,
                 'authenticated can reach audio_analysis at all (base grant present)' );
select is( (select count(*)::int from public.audio_analysis
             where file_id in ('00000000-0000-0000-0000-0000000000c1',
                               '00000000-0000-0000-0000-0000000000c2')), 1,
           'a second member sees the stored file''s analysis and not the quarantined one' );
select throws_ok(
  $$ select 1 from public.fingerprints limit 1 $$,
  '42501', NULL,
  'fingerprints are internal: authenticated cannot reach them at all' );
-- A hosted project's default privileges hand authenticated every privilege
-- on every new public table, so without the explicit REVOKE in migration 09
-- these two would be an ACL pass and RLS would be the only thing left. They
-- fail at the ACL, which is where they should fail.
select throws_ok(
  $$ insert into public.audio_analysis (file_id, analysis_version)
     values ('00000000-0000-0000-0000-0000000000c1', 'v2') $$,
  '42501', NULL,
  'authenticated has no INSERT on audio_analysis -- writes are service_role only' );
select throws_ok(
  $$ update public.audio_analysis set bpm = 1 $$,
  '42501', NULL,
  'nor UPDATE -- a member cannot rewrite the pool''s bpm' );
select throws_ok(
  $$ select public.analysis_persist('{}'::jsonb) $$,
  '42501', NULL,
  'authenticated cannot execute analysis_persist -- mutations are service_role only' );
select throws_ok(
  $$ select public.analysis_begin('00000000-0000-0000-0000-0000000000c1') $$,
  '42501', NULL,
  'nor analysis_begin' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3"}';
select is( (select count(*)::int from public.audio_analysis), 0,
           'an expired member sees no analysis at all' );

select * from finish();
rollback;
