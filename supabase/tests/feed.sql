begin;
select plan(16);

-- Two active members. e1 (fdisc1@) is the caller for most assertions; e2
-- (fdisc2@) exists to spread plays/likes across two distinct people and to
-- prove member_resolve's P0002 on an access-expired member (case 12).
insert into public.allowlist (email) values ('fdisc1@gmail.com'), ('fdisc2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','fdisc1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','fdisc2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000e1',
                   '00000000-0000-0000-0000-0000000000e2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000eb','00000000-0000-0000-0000-0000000000e1');

-- af01/af02: today's uploads, af02 minted a minute "later" than af01 so the
-- two have distinguishable created_at within one frozen-now() transaction
-- (fresh's "newest first" would otherwise have nothing to order by).
-- af03: backdated 10 days -- outside the 7-day 'fresh'/'hot' window, but
-- still counts for 'top' (all-time). All three start as three SEPARATE
-- tracks (one file each), same as dedup_seed_tracks() would mint.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state, created_at)
values
  ('00000000-0000-0000-0000-00000000af01','00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/e1/af01.flac','Fresh-One.flac', 1000, 'flac', 'stored', now()),
  ('00000000-0000-0000-0000-00000000af02','00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000e2',
   'audio/e2/af02.flac','Fresh-Two.flac', 1000, 'flac', 'stored', now() + interval '1 minute'),
  ('00000000-0000-0000-0000-00000000af03','00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/e1/af03.flac','Old-Liked.flac', 1000, 'flac', 'stored', now() - interval '10 days');

insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000af01','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000af02','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000af03','v1', 200000, 128, '8A', '{}'::jsonb);

-- One track per file, mirroring what dedup_seed_tracks() mints for every
-- stored file with no identity yet -- required for 'hot'/'top' to see them
-- at all (feed_tracks requires files.track_id is not null there).
insert into public.tracks (id, preferred_file_id) values
  ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000af01'),
  ('00000000-0000-0000-0000-00000000b002','00000000-0000-0000-0000-00000000af02'),
  ('00000000-0000-0000-0000-00000000b003','00000000-0000-0000-0000-00000000af03');
update public.files set track_id = '00000000-0000-0000-0000-00000000b001' where id = '00000000-0000-0000-0000-00000000af01';
update public.files set track_id = '00000000-0000-0000-0000-00000000b002' where id = '00000000-0000-0000-0000-00000000af02';
update public.files set track_id = '00000000-0000-0000-0000-00000000b003' where id = '00000000-0000-0000-0000-00000000af03';

-- e1 claims af01 and af02 (member_resolve's track_count, case 10). af03's
-- claim is deliberately left unset -- track_count must read 2, not 3.
insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-00000000af01','00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000eb'),
  ('00000000-0000-0000-0000-00000000af02','00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000eb');

-- ---- schema ----
select has_function('public', 'feed_tracks', array['text','int'], 'feed_tracks exists');   -- 1

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

-- af01 gets one like today (hot score 1, top score 1); af02 gets two plays
-- today from two different members (hot score 2, top score 0 -- plays never
-- count toward 'top'); af03 gets two likes from both members, then its like
-- rows are backdated below so they count for 'top' but not 'hot'.
select public.toggle_like('00000000-0000-0000-0000-00000000af01');
select public.toggle_like('00000000-0000-0000-0000-00000000af03');
select public.bump_play('00000000-0000-0000-0000-00000000af02');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select public.toggle_like('00000000-0000-0000-0000-00000000af03');
select public.bump_play('00000000-0000-0000-0000-00000000af02');

reset role;
update public.likes set created_at = now() - interval '10 days'
 where file_id = '00000000-0000-0000-0000-00000000af03';

-- ---- feed_tracks('fresh') ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select set_eq(
  $$ select file_id from public.feed_tracks('fresh', 10) $$,
  $$ values ('00000000-0000-0000-0000-00000000af01'::uuid),
            ('00000000-0000-0000-0000-00000000af02'::uuid) $$,
  'fresh returns af01 and af02 (stored within 7 days), not af03 (10 days old)' );   -- 2

select ok(
  (select array_position(array_agg(x.file_id order by x.rn), '00000000-0000-0000-0000-00000000af02'::uuid)
        < array_position(array_agg(x.file_id order by x.rn), '00000000-0000-0000-0000-00000000af01'::uuid)
     from (select k.*, row_number() over () as rn
             from public.feed_tracks('fresh', 10) k) x),
  'fresh orders newest first -- af02 (minted a minute later) before af01' );   -- 3

-- ---- feed_tracks('hot') before any merge: af02 (2 plays) outranks af01
-- (1 like); af03 is excluded entirely (its likes are outside the 7-day
-- window, so its hot score is 0) ----
select results_eq(
  $$ select file_id from public.feed_tracks('hot', 10) $$,
  $$ values ('00000000-0000-0000-0000-00000000af02'::uuid),
            ('00000000-0000-0000-0000-00000000af01'::uuid) $$,
  'hot ranks af02 (2 plays) above af01 (1 like); af03''s backdated likes score 0 and are excluded' );   -- 4

-- ---- merge af01's track into af02's, mirroring merge_tracks()'s effect on
-- files.track_id/tracks.merged_into_track_id (not calling it directly --
-- this test has no need for its download_count/tag/claim folding) ----
reset role;
update public.tracks set merged_into_track_id = '00000000-0000-0000-0000-00000000b002', merged_at = now()
 where id = '00000000-0000-0000-0000-00000000b001';
update public.files set track_id = '00000000-0000-0000-0000-00000000b002'
 where id = '00000000-0000-0000-0000-00000000af01';

-- af04: a control track/file with its own 2-play hot score (equal to af02's
-- PRE-merge score) and a high download_count tiebreak. If the merged row's
-- rank reflected only af02's own signal (2, unsummed) rather than af01's
-- like + af02's plays SUMMED (3), af04 would out-tiebreak and rank first.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state, created_at)
values
  ('00000000-0000-0000-0000-00000000af04','00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/e1/af04.flac','Control.flac', 1000, 'flac', 'stored', now());
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values ('00000000-0000-0000-0000-00000000af04','v1', 200000, 128, '8A', '{}'::jsonb);
insert into public.tracks (id, preferred_file_id) values
  ('00000000-0000-0000-0000-00000000b004','00000000-0000-0000-0000-00000000af04');
update public.files set track_id = '00000000-0000-0000-0000-00000000b004'
 where id = '00000000-0000-0000-0000-00000000af04';
insert into public.track_stats (file_id, download_count) values
  ('00000000-0000-0000-0000-00000000af04', 50);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select public.bump_play('00000000-0000-0000-0000-00000000af04');
select public.bump_play('00000000-0000-0000-0000-00000000af04');

select results_eq(
  $$ select file_id from public.feed_tracks('hot', 10) $$,
  $$ values ('00000000-0000-0000-0000-00000000af02'::uuid),
            ('00000000-0000-0000-0000-00000000af04'::uuid) $$,
  'hot returns ONE row for the merged af01/af02 pair (winner af02, score 3 = af01''s like + af02''s plays), outranking af04''s equal-but-unmerged score of 2' );   -- 5

-- ---- feed_tracks('top'): af03 (2 all-time likes) outranks the merged
-- track (1 all-time like, from af01 -- af02 itself was never liked); af04
-- has 0 likes and is excluded ----
select results_eq(
  $$ select file_id from public.feed_tracks('top', 10) $$,
  $$ values ('00000000-0000-0000-0000-00000000af03'::uuid),
            ('00000000-0000-0000-0000-00000000af02'::uuid) $$,
  'top orders by all-time likes -- af03 (2) above the merged track (1, from af01)' );   -- 6

select throws_ok(
  $$ select public.feed_tracks('nonsense') $$,
  '22023', null, 'feed_tracks raises 22023 on an unknown section' );   -- 7

-- ---- feed_new_crates ----
create temporary table crate_ids (label text primary key, id uuid not null);
grant all on crate_ids to authenticated;

insert into crate_ids (label, id) select 'pub', public.crate_create('Public Discovery');
insert into crate_ids (label, id) select 'priv', public.crate_create('Private Discovery');
select public.crate_set_public((select id from crate_ids where label = 'pub'), true);

select results_eq(
  format($$ select id from public.feed_new_crates(10) where id in (%L, %L) $$,
    (select id from crate_ids where label = 'pub'),
    (select id from crate_ids where label = 'priv')),
  format($$ values (%L::uuid) $$, (select id from crate_ids where label = 'pub')),
  'feed_new_crates returns the public crate, not the private one' );   -- 8

select is(
  (select owner_name from public.feed_new_crates(10)
    where id = (select id from crate_ids where label = 'pub')),
  (select coalesce(m.username, split_part(m.email, '@', 1)) from public.members m
    where m.user_id = '00000000-0000-0000-0000-0000000000e1'),
  'feed_new_crates owner_name matches pool_tracks.uploader_name''s convention' );   -- 9

-- ---- member_resolve ----
select public.username_set('membera');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select public.username_set('memberb');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select results_eq(
  $$ select user_id, username, track_count from public.member_resolve('membera') $$,
  $$ values ('00000000-0000-0000-0000-0000000000e1'::uuid, 'membera'::text, 2::bigint) $$,
  'member_resolve returns e1''s row -- track_count 2 (af01, af02; af03 unclaimed)' );   -- 10

select throws_ok(
  $$ select public.member_resolve('no-such-user') $$,
  'P0002', null, 'member_resolve raises P0002 for a username nobody holds' );   -- 11

reset role;
update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000e2';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select throws_ok(
  $$ select public.member_resolve('memberb') $$,
  'P0002', null, 'member_resolve raises P0002 for a member whose access has expired' );   -- 12

-- ---- anon: 42501 before any body runs ----
set local role anon;
select throws_ok(
  $$ select public.feed_tracks('fresh') $$,
  '42501', null, 'anon cannot execute feed_tracks' );   -- 13
select throws_ok(
  $$ select public.feed_new_crates() $$,
  '42501', null, 'anon cannot execute feed_new_crates' );   -- 14
select throws_ok(
  $$ select public.member_resolve('membera') $$,
  '42501', null, 'anon cannot execute member_resolve' );   -- 15

-- ---- likes stays unreadable directly, even though feed_tracks carries
-- like_count -- the closed shape migration 26 established is unchanged.
-- Runs as authenticated (not anon), same distinction likes_plays.sql draws:
-- this is about the closed-table shape, not the membership gate. ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select throws_ok(
  $$ select * from public.likes $$,
  '42501', null, 'direct SELECT from likes stays denied -- feed_tracks'' like_count never required opening it' );   -- 16

select * from finish();
rollback;
