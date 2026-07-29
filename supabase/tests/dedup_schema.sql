begin;
select plan(40);

-- allowlist BEFORE auth.users: the on_auth_user_created trigger aborts
-- otherwise, and it provisions public.members itself.
insert into public.allowlist (email) values ('d1@gmail.com'), ('d2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','d1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000d2','d2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000d1',
                   '00000000-0000-0000-0000-0000000000d2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000d1');

-- ============================================================
-- THE LIVE PAIR, AS A NEGATIVE FIXTURE.
--
-- The two production "Feeling For You" files are an original and a
-- remix/edit. PRD §3 is explicit that a remix is a SEPARATE track, and the
-- owner has confirmed it: an auto-merge of this pair is an M4 failure.
--
-- They measure IDENTICAL bpm (133.0) and key (11A), which is what makes
-- them the living argument for "metadata never decides" -- any matcher that
-- let a corroborator vote would fuse them. Their fingerprints differ, and
-- that is the only thing allowed to separate them.
--
-- What this file proves is narrower and more important than what the
-- matcher will one day prove: seeding ALONE never merges anything. Two
-- stored files become two identities, and no code path from a plain
-- backfill can produce a track_merges row.
-- ============================================================
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
   container, duration_ms, state)
values
  ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/f001.mp3','Feeling For You.mp3', 9000000, 'mp3', 300000, 'stored'),
  ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/f002.mp3','Feeling For You (DJ Tool).mp3', 9500000, 'mp3', 318000, 'stored'),
  -- Not stored: proves the backfill mints identities only for files that
  -- finished analysis and therefore have something to compare.
  ('00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/f003.mp3','Still Analysing.mp3', 8000000, 'mp3', 300000, 'received');

insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000f001','v1', 300000, 133.0, '11A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000f002','v1', 318000, 133.0, '11A', '{}'::jsonb);

insert into public.fingerprints
  (file_id, algo_version, duration_s, frame_count, fp_compressed_b64, fp_sha256, query_items)
values
  ('00000000-0000-0000-0000-00000000f001','cp-1.6.0/test2/11025', 300, 2800,
   'AQAA','aa', array[11,12,13]::bigint[]),
  ('00000000-0000-0000-0000-00000000f002','cp-1.6.0/test2/11025', 318, 2960,
   'AQAB','bb', array[91,92,93]::bigint[]);

-- ---------- shape ----------
select has_table('public','tracks','tracks exists');
select has_column('public','tracks','merged_into_track_id','merge pointer exists');
-- Asked of pg_constraint rather than through pgTAP's col_is_fk(): the
-- four-text-argument overloads of that function are ambiguous about which
-- argument is the column and which is the description.
select ok(exists (select 1 from pg_constraint
                   where conname = 'files_track_fk' and contype = 'f'
                     and conrelid = 'public.files'::regclass),
  'files.track_id is a real FK now');
select has_table('public','match_decisions','match_decisions exists');
select has_table('public','review_actions','review_actions exists — the review queue is a join, not a fourth state column');
select has_table('public','dedup_negatives','dedup_negatives exists');
select has_table('public','track_merges','track_merges exists');
select has_table('public','dedup_config','dedup_config exists');

-- ---------- the backfill, and the pair that must not collapse ----------
select is(public.dedup_seed_tracks(100), 2,
          'seeding mints one track for each of the two stored files, and none for the received one');

select is((select f.track_id is null from public.files f
            where f.id = '00000000-0000-0000-0000-00000000f003'), true,
  'a file still in received gets no identity — it has no fingerprint to compare');

select isnt((select f.track_id from public.files f
              where f.id = '00000000-0000-0000-0000-00000000f001'),
            (select f.track_id from public.files f
              where f.id = '00000000-0000-0000-0000-00000000f002'),
  'the "Feeling For You" original and remix are TWO distinct tracks after seeding');

select is((select count(*)::int from public.track_merges), 0,
  'seeding alone writes no merge event — merge_tracks is never invoked implicitly');

select is((select count(distinct f.track_id)::int from public.files f
            where f.state = 'stored'), 2,
  'every stored file has an identity and no two share one');

-- Idempotent: a second seed finds nothing left to do.
select is(public.dedup_seed_tracks(100), 0,
          'a second seeding pass mints nothing — it is safe on the hourly job');

-- ---------- the merge chain, and the guard ----------
insert into public.tracks (id) values
  ('00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-00000000c003');
update public.tracks set merged_into_track_id = '00000000-0000-0000-0000-00000000c002'
 where id = '00000000-0000-0000-0000-00000000c001';
update public.tracks set merged_into_track_id = '00000000-0000-0000-0000-00000000c003'
 where id = '00000000-0000-0000-0000-00000000c002';

select is(public.canonical_track_id('00000000-0000-0000-0000-00000000c001'),
          '00000000-0000-0000-0000-00000000c003'::uuid,
          'walks a two-hop merge chain to its head');
select is(public.canonical_track_id('00000000-0000-0000-0000-00000000c003'),
          '00000000-0000-0000-0000-00000000c003'::uuid,
          'an unmerged track is its own canonical id');
select is(public.canonical_track_id(null), null::uuid,
          'null in, null out — an unassigned file is not an error');

-- A cycle cannot be created by any function in this milestone, but the
-- walker must survive one anyway: an infinite loop inside a function this
-- widely called takes the whole request down, and the depth cap is two
-- lines.
update public.tracks set merged_into_track_id = '00000000-0000-0000-0000-00000000c001'
 where id = '00000000-0000-0000-0000-00000000c003';
select isnt(public.canonical_track_id('00000000-0000-0000-0000-00000000c001'),
            null::uuid, 'a cycle terminates instead of hanging');
update public.tracks set merged_into_track_id = null
 where id = '00000000-0000-0000-0000-00000000c003';

select throws_ok(
  $$ insert into public.tracks (id, merged_into_track_id)
     values ('00000000-0000-0000-0000-00000000c009',
             '00000000-0000-0000-0000-00000000c009') $$,
  '23514', 'new row for relation "tracks" violates check constraint "no_self_merge"',
  'a track cannot merge into itself');

select throws_ok(
  $$ insert into public.track_relations (track_id, related_id, relation)
     values ('00000000-0000-0000-0000-00000000c001',
             '00000000-0000-0000-0000-00000000c001','version') $$,
  '23514', 'new row for relation "track_relations" violates check constraint "no_self_relation"',
  'a track cannot be a version of itself');

-- ---------- the ledger ----------
select ok(exists (select 1 from pg_indexes
                   where schemaname = 'public'
                     and indexname = 'match_decisions_live_uniq'),
  'the partial unique index on the live pair exists');

insert into public.match_decisions
  (probe_file_id, candidate_file_id, algo_version, layer, score, band,
   duration_delta_ms, thresholds, action)
values ('00000000-0000-0000-0000-00000000f001',
        '00000000-0000-0000-0000-00000000f002',
        'cp-1.6.0/test2/11025','ber', 0.55, 'related', 5000, '{}'::jsonb, 'new_track_related');

select throws_ok(
  $$ insert into public.match_decisions
       (probe_file_id, candidate_file_id, algo_version, layer, score, band,
        thresholds, action)
     values ('00000000-0000-0000-0000-00000000f001',
             '00000000-0000-0000-0000-00000000f002',
             'cp-1.6.0/test2/11025','ber', 0.56, 'related', '{}'::jsonb, 'x') $$,
  '23505', null,
  'two LIVE decisions for one (probe, candidate) pair are refused — reprocessing supersedes');

-- Superseding the first one frees the pair for a new live row: history is
-- kept, the current answer stays unambiguous.
update public.match_decisions set superseded_at = now()
 where probe_file_id = '00000000-0000-0000-0000-00000000f001';
select lives_ok(
  $$ insert into public.match_decisions
       (probe_file_id, candidate_file_id, algo_version, layer, score, band,
        duration_delta_ms, thresholds, action)
     values ('00000000-0000-0000-0000-00000000f001',
             '00000000-0000-0000-0000-00000000f002',
             'cp-1.6.0/test2/11025','ber', 0.56, 'related', 5000,
             '{}'::jsonb, 'new_track_related') $$,
  'a superseded decision leaves room for the next one at the same pair');

-- The near-miss log is the M4.8 calibration input: a 0.40-0.70 pair with a
-- small duration delta is the vinyl-drift signature PRD §15 names.
select is((select count(*)::int from public.dedup_near_misses), 1,
  'the live related-band decision appears in the near-miss log');
select is((select duration_delta_pct from public.dedup_near_misses),
          1.667::numeric,
          'and it carries the duration delta as a percentage, which is the drift signal');

-- ---------- negatives are keyed on the FILE pair, ordered ----------
select throws_ok(
  $$ insert into public.dedup_negatives (file_lo, file_hi, decided_by)
     values ('00000000-0000-0000-0000-00000000f002',
             '00000000-0000-0000-0000-00000000f001',
             '00000000-0000-0000-0000-0000000000d1') $$,
  '23514', 'new row for relation "dedup_negatives" violates check constraint "negatives_ordered"',
  'the pair must be stored lo < hi, so one pair has exactly one spelling');

-- ---------- thresholds, honestly labelled ----------
select is((select source from public.dedup_config where algo_version = 'cp-1.6.0/test2/11025'),
          'PRD §6 constants — NOT calibrated',
          'the shipped thresholds say plainly that they are guesses');
select is((select t_same from public.dedup_config where algo_version = 'cp-1.6.0/test2/11025'),
          0.90::real, 'auto-merge band seeded at 0.90');
select throws_ok(
  $$ update public.dedup_config set t_probable = 0.95
      where algo_version = 'cp-1.6.0/test2/11025' $$,
  '23514', null,
  'a calibration UPDATE cannot invert the bands');

-- ---------- candidate retrieval index ----------
select ok(exists (select 1 from pg_indexes
                   where schemaname = 'public' and tablename = 'fingerprints'
                     and indexname = 'fingerprints_qi_gin'),
  'the index on fingerprints.query_items exists');
select is((select a.amname from pg_am a
             join pg_class c on c.relam = a.oid
            where c.relname = 'fingerprints_qi_gin'),
          'gin',
          'and it is GIN with the built-in array_ops, not a btree Postgres silently accepted');

-- ---------- requeue ----------
select is((select count(*)::int from public.analysis_requeue(
            array['00000000-0000-0000-0000-00000000f001']::uuid[])), 1,
  'analysis_requeue reopens a stored file and returns its r2_key');
select is((select state from public.files
            where id = '00000000-0000-0000-0000-00000000f001'), 'received',
  'and the file is back in received, where the :31 cron already re-enqueues it');

-- ---------- REVOKE FIRST ----------
-- A hosted project grants authenticated arwdDxtm on every new table by
-- default, so the grants in the migration are a no-op there unless the
-- revoke ran first. Local `supabase start` does not reproduce that, which
-- is exactly why these assertions exist.
set local role authenticated;
select throws_ok(
  $$ insert into public.tracks (id) values (gen_random_uuid()) $$,
  '42501', 'permission denied for table tracks',
  'a member cannot write tracks directly');
select throws_ok(
  $$ insert into public.track_merges (loser_track_id, winner_track_id, performed_by)
     values (gen_random_uuid(), gen_random_uuid(), 'auto') $$,
  '42501', 'permission denied for table track_merges',
  'a member cannot forge a merge event');
select throws_ok(
  $$ update public.match_decisions set band = 'same' $$,
  '42501', 'permission denied for table match_decisions',
  'a member cannot rewrite the machine''s answer');
select throws_ok(
  $$ update public.dedup_config set t_same = 0.10 $$,
  '42501', 'permission denied for table dedup_config',
  'a member cannot move the auto-merge threshold');
select throws_ok(
  $$ select * from public.dedup_near_misses $$,
  '42501', null,
  'the near-miss log is service_role only');
select throws_ok(
  $$ select public.analysis_requeue(array[]::uuid[]) $$,
  '42501', 'permission denied for function analysis_requeue',
  'requeue is service_role only — 45 vCPU-s per file is not a member''s to spend');
select lives_ok(
  $$ select count(*) from public.tracks $$,
  'a member can read tracks');
reset role;

select * from finish();
rollback;
