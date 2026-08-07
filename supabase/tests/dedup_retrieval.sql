-- supabase/tests/dedup_retrieval.sql
-- localchune — MIT licensed. See LICENSE.
--
-- M4 Task 4. Candidate retrieval: layer 0 (exact bytes), layer 1 (GIN
-- overlap + duration gate + algo_version + negatives), the duration-only
-- fallback, the pending backstop, and the two SQL ports of
-- worker/app/forensics.py.
begin;
select plan(59);

-- allowlist BEFORE auth.users: the on_auth_user_created trigger aborts
-- otherwise, and it provisions public.members itself.
insert into public.allowlist (email) values ('r1@gmail.com'), ('r2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','r1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','r2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000e1',
                   '00000000-0000-0000-0000-0000000000e2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000e1');

-- ============================================================
-- The fixture.
--
--   f001  the probe.                300 s, digest \x01, items 1..10
--   f002  the near-identical twin.  302 s, digest \x02, items 1..8 + 20,21
--   f003  same length, shares no items. 300 s, digest \x03, items 900..902
--   f004  the same audio 60 s longer.   360 s, digest \x04, items 1..10
--   f005  the BYTE twin of f001. digest NULL -- see the layer-0 block for
--         why that is not a shortcut but the only shape the schema allows.
--   f006  a file that never finished analysis. No fingerprint at all.
--
-- f004 shares every item with f001 on purpose: the only thing keeping it
-- out of the candidate set is the ±10 s duration gate, so if that gate is
-- ever broken the test says so instead of passing for the wrong reason.
-- ============================================================
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
   container, duration_ms, content_sha256, state)
values
  ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/r1/f001.flac','Probe.flac', 30000000, 'flac', 300000, '\x01'::bytea, 'stored'),
  ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/r1/f002.mp3','Probe (320).mp3', 9000000, 'mp3', 302000, '\x02'::bytea, 'stored'),
  ('00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/r1/f003.mp3','Something Else.mp3', 9000000, 'mp3', 300000, '\x03'::bytea, 'stored'),
  ('00000000-0000-0000-0000-00000000f004','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/r1/f004.mp3','Probe (Extended).mp3', 11000000, 'mp3', 360000, '\x04'::bytea, 'stored'),
  ('00000000-0000-0000-0000-00000000f005','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e2',
   'audio/r2/f005.flac','Probe (reupload).flac', 30000000, 'flac', 300000, null, 'stored'),
  ('00000000-0000-0000-0000-00000000f006','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/r1/f006.mp3','Never Analysed.mp3', 9000000, 'mp3', null, null, 'stored');

insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, bpm, key_camelot, quality_tier, raw_tags)
values
  ('00000000-0000-0000-0000-00000000f001','v2', 300000, 122.0, '8A', 5, '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000f002','v2', 302000, 122.0, '8A', 3, '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000f003','v2', 300000, 174.0, '2B', 3, '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000f004','v2', 360000, 122.0, '8A', 3, '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000f005','v2', 300000, 122.0, '8A', 5, '{}'::jsonb);

insert into public.fingerprints
  (file_id, algo_version, duration_s, frame_count, fp_compressed_b64, fp_sha256, query_items)
values
  ('00000000-0000-0000-0000-00000000f001','cp-1.6.0/test2/11025', 300, 2400,
   'AQAA01','h001', array[1,2,3,4,5,6,7,8,9,10]::bigint[]),
  ('00000000-0000-0000-0000-00000000f002','cp-1.6.0/test2/11025', 302, 2416,
   'AQAA02','h002', array[1,2,3,4,5,6,7,8,20,21]::bigint[]),
  ('00000000-0000-0000-0000-00000000f003','cp-1.6.0/test2/11025', 300, 2400,
   'AQAA03','h003', array[900,901,902]::bigint[]),
  ('00000000-0000-0000-0000-00000000f004','cp-1.6.0/test2/11025', 360, 2880,
   'AQAA04','h004', array[1,2,3,4,5,6,7,8,9,10]::bigint[]),
  ('00000000-0000-0000-0000-00000000f005','cp-1.6.0/test2/11025', 300, 2400,
   'AQAA05','h005', array[1,2,3,4,5,6,7,8,9,10]::bigint[]);

-- ---------- the index ----------
select has_index('public','fingerprints','fingerprints_qi_gin',
                 'the GIN index on query_items exists');
select is(
  (select a.amname from pg_am a
     join pg_class c on c.relam = a.oid where c.relname = 'fingerprints_qi_gin'),
  'gin', 'and it is a GIN index, not a btree Postgres silently accepted');

-- ---------- qi_overlap ----------
select is(public.qi_overlap(array[1,2,3]::bigint[], array[2,3,4]::bigint[]), 2,
          'qi_overlap counts shared items');
select is(public.qi_overlap(array[]::bigint[], array[1]::bigint[]), 0,
          'an empty probe overlaps nothing');
select is(public.qi_overlap(array[1,1,2]::bigint[], array[1,1,3]::bigint[]), 1,
          'INTERSECT deduplicates: a repeated item is not extra evidence');

-- ============================================================
-- LAYER 0 -- exact bytes, and the reason it needs an argument.
--
-- files.content_sha256 is UNIQUE (migration 06). Migration 19 makes
-- analysis_persist() leave the SECOND of two byte-identical files NULL
-- rather than raising 23505 and discarding a finished analysis. So the
-- pair this layer exists to catch can never be expressed as two rows
-- holding the same digest -- the next two assertions prove that the
-- fixture is not being lazy, it is being accurate -- and the digest has to
-- reach the query as an ARGUMENT, from the container response the consumer
-- already holds.
-- ============================================================
select ok(exists (
  select 1 from pg_constraint
   where conrelid = 'public.files'::regclass and contype = 'u'
     and pg_get_constraintdef(oid) like '%content_sha256%'),
  'files.content_sha256 is UNIQUE — two rows can never hold the same digest');

select throws_ok(
  $$ insert into public.files
       (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
        content_sha256, state)
     values ('00000000-0000-0000-0000-00000000f0ff',
             '00000000-0000-0000-0000-0000000000bb',
             '00000000-0000-0000-0000-0000000000e1',
             'audio/r1/f0ff.flac','Impossible.flac', 1, '\x01'::bytea, 'stored') $$,
  '23505', null,
  'so a self-join on digest equality can never find a twin');

select is(
  (select count(*)::int from public.dedup_exact(
     '00000000-0000-0000-0000-00000000f001')),
  0, 'reading the digest off the probe row finds nothing — it only matches itself');

select is(
  (select x.candidate_file_id from public.dedup_exact(
     '00000000-0000-0000-0000-00000000f005', '\x01'::bytea) x),
  '00000000-0000-0000-0000-00000000f001'::uuid,
  'the caller-supplied digest is the layer-0 path, and it finds the incumbent');

select is(
  (select count(*)::int from public.dedup_exact(
     '00000000-0000-0000-0000-00000000f005')),
  0, 'no digest anywhere means no layer-0 hit, never an error');

select is(
  (select count(*)::int from public.dedup_exact(
     '00000000-0000-0000-0000-00000000f001', '\x01'::bytea)),
  0, 'a file is never its own exact match');

-- ---------- layer 1: the four gates ----------
-- Two files survive them: the 320 kbps twin, and f005 -- the byte-identical
-- reupload, whose own digest analysis_persist discarded. From f001's side
-- there is no digest to match on, so f005 arrives through the FINGERPRINT.
-- That is the whole reason layer 0 is an optimisation and not a
-- correctness requirement.
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25)),
  2, 'the twin and the byte-identical reupload survive all four gates, and nothing else');

select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f005'
      and c.via = 'gin'),
  1, 'a byte twin whose digest was discarded is still retrieved, by fingerprint');

select is(
  (select c.via from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f002'),
  'gin', 'the twin is retrieved by fingerprint overlap, and the row says so');

select is(
  (select c.shared_items from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f002'),
  8, 'carrying the overlap count the ranking used');

select is(
  (select c.duration_delta_ms from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f002'),
  2000, 'and the duration delta, signed, candidate minus probe');

select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f004'),
  0, 'the +60s file is outside the ±10s duration gate — even sharing every item');

select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f001'),
  0, 'a file is never its own candidate');

-- algo_version: change the twin's and it must vanish.
update public.fingerprints set algo_version = 'cp-1.5.1/test2/11025'
 where file_id = '00000000-0000-0000-0000-00000000f002';
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f002'),
  0, 'a fingerprint from another chromaprint build is not a candidate');
update public.fingerprints set algo_version = 'cp-1.6.0/test2/11025'
 where file_id = '00000000-0000-0000-0000-00000000f002';

-- negatives: a human said no, so it never comes back.
insert into public.dedup_negatives (file_lo, file_hi, decided_by)
select least('00000000-0000-0000-0000-00000000f001'::uuid,
             '00000000-0000-0000-0000-00000000f002'::uuid),
       greatest('00000000-0000-0000-0000-00000000f001'::uuid,
                '00000000-0000-0000-0000-00000000f002'::uuid),
       '00000000-0000-0000-0000-0000000000e1';
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f002'),
  0, 'a pair a human called different never resurfaces');

-- and the same verdict binds layer 0, which has no opinion of its own
insert into public.dedup_negatives (file_lo, file_hi, decided_by)
select least('00000000-0000-0000-0000-00000000f001'::uuid,
             '00000000-0000-0000-0000-00000000f005'::uuid),
       greatest('00000000-0000-0000-0000-00000000f001'::uuid,
                '00000000-0000-0000-0000-00000000f005'::uuid),
       '00000000-0000-0000-0000-0000000000e1';
select is(
  (select count(*)::int from public.dedup_exact(
     '00000000-0000-0000-0000-00000000f005', '\x01'::bytea)),
  0, 'never re-ask outranks byte equality — a recorded negative binds layer 0 too');
delete from public.dedup_negatives;

-- a file outside the pool's visible states is not a candidate
update public.files set state = 'rejected_redundant'
 where id = '00000000-0000-0000-0000-00000000f002';
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f002'),
  0, 'a file already merged away is not offered again');
update public.files set state = 'stored'
 where id = '00000000-0000-0000-0000-00000000f002';

-- ---------- layer 0 and layer 1 together ----------
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f005', 25, '\x01'::bytea) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f001'),
  1, 'the byte twin is returned exactly once, not once per layer');

select is(
  (select c.via from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f005', 25, '\x01'::bytea) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f001'),
  'sha256', 'and it is labelled as the exact-bytes hit, which needs no scoring');

select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f006', 25)),
  0, 'a file with no fingerprint returns nothing rather than failing');

-- ---------- the ranking ----------
-- f003 shares nothing, so it is not a GIN hit at all; give it two of the
-- probe's items and it must rank BELOW the twin's eight.
update public.fingerprints set query_items = array[1,2,900]::bigint[]
 where file_id = '00000000-0000-0000-0000-00000000f003';
-- WITH ORDINALITY, not row_number(): the ordinality column is the only
-- documented way to read a set-returning function's emission order.
select is(
  (select array_agg(d.candidate_file_id order by d.ord)
     from public.dedup_candidates('00000000-0000-0000-0000-00000000f001', 25)
       with ordinality as d(candidate_file_id, candidate_track_id,
                            fp_compressed_b64, fp_sha256, shared_items,
                            duration_delta_ms, bpm, key_camelot,
                            quality_tier, via, ord)),
  array['00000000-0000-0000-0000-00000000f005',
        '00000000-0000-0000-0000-00000000f002',
        '00000000-0000-0000-0000-00000000f003']::uuid[],
  'candidates come back strongest-overlap first: 10 items, then 8, then 2');
update public.fingerprints set query_items = array[900,901,902]::bigint[]
 where file_id = '00000000-0000-0000-0000-00000000f003';

select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 1)),
  1, 'the limit is honoured');

-- ---------- the fallback ----------
-- Strip the probe's shared items and the duration-only scan must still
-- find the in-window files.
update public.fingerprints set query_items = array[999999]::bigint[]
 where file_id = '00000000-0000-0000-0000-00000000f001';
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25)),
  3, 'with no GIN hit, the duration-only fallback returns the in-window files');
select is(
  (select count(distinct c.via)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c where c.via = 'duration'),
  1, 'and every one of them says it came from the fallback');
select is(
  (select count(*)::int from public.dedup_candidates(
     '00000000-0000-0000-0000-00000000f001', 25) c
    where c.candidate_file_id = '00000000-0000-0000-0000-00000000f004'),
  0, 'the fallback is duration-only, NOT gate-free');
update public.fingerprints set query_items = array[1,2,3,4,5,6,7,8,9,10]::bigint[]
 where file_id = '00000000-0000-0000-0000-00000000f001';

-- ---------- dedup_pending / dedup_seed_tracks (migration 34) ----------
-- THE ORDER OF THESE ASSERTIONS IS THE BUG THEY EXIST TO CATCH. Before
-- migration 34, dedup_pending() keyed off `track_id is null` and
-- dedup_seed_tracks() minted a track for EVERY trackless stored file. So
-- the seeder — which the backstop runs immediately after the matcher, and
-- which has no per-run cap while the matcher has one of 300 — silently
-- emptied the matcher's own work list. 690 production files were stranded
-- unexamined that way on 2026-07-29 and nothing anywhere counted them.
select is((select count(*)::int from public.dedup_pending(10)), 0,
  'a file that reached stored a moment ago is not pending yet — the 5 minute grace');

update public.files set state_changed_at = now() - interval '1 hour'
 where id = '00000000-0000-0000-0000-00000000f001';
select is(
  (select count(*)::int from public.dedup_pending(10) p
    where p.file_id = '00000000-0000-0000-0000-00000000f001'),
  1, 'an hour later, a stored file the matcher has never examined is pending');

select is(public.dedup_seed_tracks(100), 1,
  'seeding mints an identity ONLY for the file the matcher can never match — f006, which has no fingerprint');
select is(
  (select count(*)::int from public.dedup_pending(10) p
    where p.file_id = '00000000-0000-0000-0000-00000000f001'),
  1, 'and a matchable file is STILL pending after a seed — the seeder can no longer run ahead of the matcher');

select is(public.dedup_mark_probed(array['00000000-0000-0000-0000-00000000f001']::uuid[]), 1,
  'the matcher stamps the file it examined');
select is((select count(*)::int from public.dedup_pending(10) p
            where p.file_id = '00000000-0000-0000-0000-00000000f001'), 0,
  'a stamped file leaves the queue — this, not track_id, is what makes the backstop terminate');
select is(public.dedup_mark_probed('{}'::uuid[]), 0,
  'an empty page of ids is not an error');

select is((select count(*)::int from public.track_merges), 0,
  'and retrieval has still merged nothing — it decides nothing by design');

-- ============================================================
-- dedup_quality_score / dedup_is_upgrade replay worker/app/forensics.py's
-- OWN vectors. The numbers below are what worker/tests/test_forensics.py's
-- _f() fixture produces; if the SQL port and the Python ever drift, these
-- four assertions fail rather than a merge quietly choosing the wrong file.
-- ============================================================
select is(public.dedup_quality_score(
  '{"tier":3,"cutoff_hz":19500,"eff_bits":16,"eff_sr":44100,"inferred_kbps":320,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), 325.6::real,
  'a real 320 kbps mp3 scores exactly what forensics.py scores it');
select is(public.dedup_quality_score(
  '{"tier":5,"cutoff_hz":21500,"eff_bits":16,"eff_sr":44100,"inferred_kbps":0,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), 517.2::real,
  'and so does a real lossless file');
select is(public.dedup_quality_score(
  '{"tier":1,"cutoff_hz":16000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":128,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), 116.8::real,
  'a 128 kbps incumbent');
select is(public.dedup_quality_score(
  '{"tier":2,"cutoff_hz":16000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":320,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), 222.8::real,
  'and the same file before the lame-tag penalty is applied');
select is(public.dedup_quality_score(
  '{"tier":2,"cutoff_hz":16000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":320,
    "lame_disagrees":true,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), 216.8::real,
  'a bitstream that disagrees with the audio costs exactly 6 points');
select is(public.dedup_quality_score('{}'::jsonb), 0::real,
  'an empty forensics object scores zero rather than NULL');

select is(public.dedup_is_upgrade(
  '{"tier":2,"cutoff_hz":16800,"eff_bits":16,"eff_sr":44100,"inferred_kbps":128,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb,
  '{"tier":5,"cutoff_hz":22000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":0,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), true,
  'a real lossless file upgrades a 128 kbps incumbent');

select is(public.dedup_is_upgrade(
  '{"tier":5,"cutoff_hz":22000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":0,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb,
  '{"tier":1,"cutoff_hz":16000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":128,
    "lame_disagrees":true,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), false,
  'a fake FLAC never upgrades a real one');

select is(public.dedup_is_upgrade(
  '{"tier":3,"cutoff_hz":19500,"eff_bits":16,"eff_sr":44100,"inferred_kbps":320,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb,
  '{"tier":2,"cutoff_hz":16000,"eff_bits":16,"eff_sr":44100,"inferred_kbps":320,
    "lame_disagrees":true,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), false,
  'a fake 320 does not beat a real 320 (test_forensics.py, same vector)');

select is(public.dedup_is_upgrade(
  '{"tier":3,"cutoff_hz":19500,"eff_bits":16,"eff_sr":44100,"inferred_kbps":320,
    "lame_disagrees":false,"clipped_pct":0,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb,
  '{"tier":5,"cutoff_hz":21500,"eff_bits":16,"eff_sr":44100,"inferred_kbps":0,
    "lame_disagrees":false,"clipped_pct":0.5,"true_peak":-1,"mono_vs_stereo":false,
    "decode_errors":false}'::jsonb), false,
  'a clipped candidate is never an upgrade, however good its bandwidth');

select is(public.dedup_is_upgrade(null, '{"tier":5}'::jsonb), false,
  'NULL forensics is never an upgrade — it is an absence of evidence');
select is(public.dedup_is_upgrade('{"tier":5}'::jsonb, null), false,
  'and neither is a NULL candidate');
select is(public.dedup_is_upgrade(
  '{"cutoff_hz":16000}'::jsonb, '{"tier":5,"cutoff_hz":22000}'::jsonb), false,
  'a forensics object with no tier is an absence of evidence too');

-- ============================================================
-- AUTHZ. Retrieval is service_role only: a member has no business reading
-- fingerprints, and migration 09 gives authenticated no grant on that
-- table for the same reason.
--
-- Hosted Supabase grants EXECUTE on a new function to PUBLIC, and PUBLIC
-- includes authenticated -- so every one of these passes only because the
-- migration revoked first.
-- ============================================================
set local role authenticated;
select throws_ok(
  $$ select * from public.dedup_candidates(
       '00000000-0000-0000-0000-00000000f001', 25) $$,
  '42501', 'permission denied for function dedup_candidates',
  'retrieval is service_role only — a member has no business reading fingerprints');
select throws_ok(
  $$ select * from public.dedup_exact('00000000-0000-0000-0000-00000000f001') $$,
  '42501', 'permission denied for function dedup_exact',
  'nor may a member probe the pool for byte-identical uploads');
select throws_ok(
  $$ select * from public.dedup_pending(10) $$,
  '42501', 'permission denied for function dedup_pending',
  'nor read the backstop queue');
select throws_ok(
  $$ select public.qi_overlap(array[1]::bigint[], array[1]::bigint[]) $$,
  '42501', 'permission denied for function qi_overlap',
  'nor compare two fingerprints by hand');
select throws_ok(
  $$ select public.dedup_quality_score('{"tier":5}'::jsonb) $$,
  '42501', 'permission denied for function dedup_quality_score',
  'the quality port is not a member-facing calculator');
select throws_ok(
  $$ select public.dedup_is_upgrade('{"tier":1}'::jsonb, '{"tier":5}'::jsonb) $$,
  '42501', 'permission denied for function dedup_is_upgrade',
  'and neither is the upgrade rule');
-- Migration 34's two new functions, same rule. dedup_mark_probed writes
-- files, so a member holding it could hide any upload from the matcher
-- for ever; track_face_file leaks nothing but has no member-facing use.
select throws_ok(
  $$ select public.dedup_mark_probed(array['00000000-0000-0000-0000-00000000f001']::uuid[]) $$,
  '42501', 'permission denied for function dedup_mark_probed',
  'a member cannot mark a file examined — that would hide it from the backstop for ever');
select throws_ok(
  $$ select public.track_face_file('00000000-0000-0000-0000-0000000000a1') $$,
  '42501', 'permission denied for function track_face_file',
  'the face rule is called inside definer bodies, never by a member');
reset role;

select * from finish();
rollback;
