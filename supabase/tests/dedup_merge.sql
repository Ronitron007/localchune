begin;
select plan(33);

-- ============================================================
-- THE ROUND TRIP IS THE ASSERTION THAT MATTERS.
--
-- Everything else in the dedup schema is re-derivable. A merge that cannot
-- be undone has destroyed someone else's crate, silently and forever --
-- PRD §15's first named risk, whose only mitigation is this function pair
-- plus the rule that crates read through canonical_track_id().
--
-- So the shape of this file is: snapshot -> merge -> prove the fold ->
-- undo -> prove the snapshot came back.
-- ============================================================

-- allowlist BEFORE auth.users: the on_auth_user_created trigger provisions
-- public.members itself and aborts on an email that is not listed yet.
insert into public.allowlist (email) values ('m1@gmail.com'), ('m2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','m1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000d2','m2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000d1',
                   '00000000-0000-0000-0000-0000000000d2');
-- d1 is the owner: undo_merge is a human reversing a machine, so only the
-- owner may call it. The trigger already made the row -- promote it.
update public.members set role = 'owner'
 where user_id = '00000000-0000-0000-0000-0000000000d1';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000d1');

-- Four stored files across three tracks:
--   track a  <- fa1  (the winner, and its preferred file)
--   track b  <- fb1, fb2  (the loser)
--   track c  <- fc1  (only used to stack a later merge for the ordering test)
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size,
   container, duration_ms, state)
values
  ('00000000-0000-0000-0000-00000000fa01','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/fa01.flac','Winner.flac', 40000000, 'flac', 300000, 'stored'),
  ('00000000-0000-0000-0000-00000000fb01','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d2',
   'audio/d2/fb01.mp3','Loser-320.mp3', 9000000, 'mp3', 300000, 'stored'),
  ('00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d2',
   'audio/d2/fb02.mp3','Loser-128.mp3', 4000000, 'mp3', 300000, 'stored'),
  ('00000000-0000-0000-0000-00000000fc01','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/d1/fc01.flac','Third.flac', 41000000, 'flac', 300000, 'stored');

insert into public.tracks (id, preferred_file_id) values
  ('00000000-0000-0000-0000-00000000c00a','00000000-0000-0000-0000-00000000fa01'),
  ('00000000-0000-0000-0000-00000000c00b','00000000-0000-0000-0000-00000000fb01'),
  ('00000000-0000-0000-0000-00000000c00c','00000000-0000-0000-0000-00000000fc01');
update public.files set track_id = '00000000-0000-0000-0000-00000000c00a'
 where id = '00000000-0000-0000-0000-00000000fa01';
update public.files set track_id = '00000000-0000-0000-0000-00000000c00b'
 where id in ('00000000-0000-0000-0000-00000000fb01',
              '00000000-0000-0000-0000-00000000fb02');
update public.files set track_id = '00000000-0000-0000-0000-00000000c00c'
 where id = '00000000-0000-0000-0000-00000000fc01';

-- Counts on all three files, so the sum has something to sum and the undo
-- has a real split to restore.
insert into public.track_stats (file_id, download_count) values
  ('00000000-0000-0000-0000-00000000fa01', 3),
  ('00000000-0000-0000-0000-00000000fb01', 5),
  ('00000000-0000-0000-0000-00000000fb02', 7);

-- Tags chosen so the union exercises both branches: 'house' is on BOTH
-- sides (conflict -- the survivor keeps its own row and the fold must not
-- claim it), 'techno' and 'disco' are only on the loser (folded).
insert into public.file_tags (file_id, tag_display, tag_key, created_by) values
  ('00000000-0000-0000-0000-00000000fa01','House','house',
   '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-00000000fb01','house','house',
   '00000000-0000-0000-0000-0000000000d2'),
  ('00000000-0000-0000-0000-00000000fb01','Techno','techno',
   '00000000-0000-0000-0000-0000000000d2'),
  ('00000000-0000-0000-0000-00000000fb02','Disco','disco',
   '00000000-0000-0000-0000-0000000000d2');

insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-00000000fa01','00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000bb'),
  ('00000000-0000-0000-0000-00000000fb01','00000000-0000-0000-0000-0000000000d2',
   '00000000-0000-0000-0000-0000000000bb'),
  ('00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000000d2',
   '00000000-0000-0000-0000-0000000000bb');

-- ---------- the snapshots the undo has to reproduce ----------
create temp table snap_tags as
  select file_id, tag_display, tag_key, created_by, created_at from public.file_tags;
create temp table snap_downloads as
  select file_id, download_count from public.track_stats;
create temp table snap_claims as
  select file_id, user_id, batch_id from public.file_claims;

-- ============================================================
-- MERGE
-- ============================================================
-- Wrapped in DO blocks throughout this file: a bare SELECT would print a
-- value into the TAP stream, and psql variables (\gset, :name) are not
-- available to every runner -- a pgTAP file has to be self-contained.
do $$ begin
  perform public.merge_tracks('00000000-0000-0000-0000-00000000c00b',
                              '00000000-0000-0000-0000-00000000c00a',
                              null, 'auto');
end $$;

select is(public.canonical_track_id('00000000-0000-0000-0000-00000000c00b'),
          '00000000-0000-0000-0000-00000000c00a'::uuid,
          'before undo: the loser resolves to the winner');
select is((select f.track_id from public.files f
            where f.id = '00000000-0000-0000-0000-00000000fb01'),
          '00000000-0000-0000-0000-00000000c00a'::uuid,
          'every file on the losing track was re-pointed at the winner');
select is((select count(*)::int from public.files f
            where f.track_id = '00000000-0000-0000-0000-00000000c00a'), 3,
          'the winner now carries all three files');

-- ---------- the fold: counts ----------
select is((select download_count from public.track_stats
            where file_id = '00000000-0000-0000-0000-00000000fa01'), 15::bigint,
  'download_count is SUMMED onto the survivor: 3 + 5 + 7');
select is((select download_count from public.track_stats
            where file_id = '00000000-0000-0000-0000-00000000fb01'), 0::bigint,
  'and the source counters are zeroed, so the total is not double-counted');

-- ---------- the fold: tags ----------
select is((select count(*)::int from public.file_tags
            where file_id = '00000000-0000-0000-0000-00000000fa01'), 3,
  'tags are UNIONED onto the survivor: its own house, plus techno and disco');
select is((select tag_display from public.file_tags
            where file_id = '00000000-0000-0000-0000-00000000fa01'
              and tag_key = 'house'), 'House',
  'a tag_key the survivor already held keeps ITS display casing — first writer wins');
select is((select folded_tag_keys from public.track_merges
            where id = (select max(m.id) from public.track_merges m)), array['disco','techno']::text[],
  'the event records exactly which keys the merge created, not a blanket list');
select is((select count(*)::int from public.file_tags
            where file_id in ('00000000-0000-0000-0000-00000000fb01',
                              '00000000-0000-0000-0000-00000000fb02')), 0,
  'the moved files no longer carry the tags — a tag belongs to the track');

-- ---------- the fold: claims ----------
select is((select count(*)::int from public.file_claims
            where file_id = '00000000-0000-0000-0000-00000000fa01'), 2,
  'BOTH uploaders now hold a claim on the surviving file');
select is((select added_claim_user_ids from public.track_merges
            where id = (select max(m.id) from public.track_merges m)),
          array['00000000-0000-0000-0000-0000000000d2']::uuid[],
  'the event records which claim the fold added');
select is((select count(*)::int from public.file_claims
            where file_id = '00000000-0000-0000-0000-00000000fb01'), 1,
  'and the source claim is left in place — nothing about a claim is ever removed');

-- ---------- the undo payload was captured before anything moved ----------
select is((select array_length(moved_file_ids, 1) from public.track_merges
            where id = (select max(m.id) from public.track_merges m)), 2,
  'the event lists the files it moved');
select is((select prior_preferred_file_id from public.track_merges
            where id = (select max(m.id) from public.track_merges m)),
          '00000000-0000-0000-0000-00000000fa01'::uuid,
          'and the winner''s preferred file as it stood before the merge');
select is((select prior_download_counts from public.track_merges
            where id = (select max(m.id) from public.track_merges m)),
          jsonb_build_object('00000000-0000-0000-0000-00000000fa01', 3,
                             '00000000-0000-0000-0000-00000000fb01', 5,
                             '00000000-0000-0000-0000-00000000fb02', 7),
  'the pre-merge split is recorded in full, survivor included — the undo restores, never subtracts');

-- The keep-if-better path (Task 6) demotes a redundant file and records it
-- on the event. Simulated here so the undo's state restoration is covered:
-- the ROW comes back even though the bytes may not.
update public.files set state = 'rejected_redundant', state_changed_at = now()
 where id = '00000000-0000-0000-0000-00000000fb02';
update public.track_merges
   set reclaimed_file_ids = array['00000000-0000-0000-0000-00000000fb02']::uuid[]
 where id = (select max(m.id) from public.track_merges m);
select is((select state from public.files
            where id = '00000000-0000-0000-0000-00000000fb02'), 'rejected_redundant',
  'a reclaimed file is demoted, not deleted');

-- ============================================================
-- UNDO -- as the owner, which is the only role that may
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

select lives_ok(
  $$ select public.undo_merge((select max(id) from public.track_merges)) $$,
  'undo_merge runs for the owner');

reset role;

select is(public.canonical_track_id('00000000-0000-0000-0000-00000000c00b'),
          '00000000-0000-0000-0000-00000000c00b'::uuid,
          'after undo: the loser is its own canonical id again — every crate snaps back');
select is((select f.track_id from public.files f
            where f.id = '00000000-0000-0000-0000-00000000fb01'),
          '00000000-0000-0000-0000-00000000c00b'::uuid,
          'every moved file went back to the track the payload says it came from');
select is((select t.preferred_file_id from public.tracks t
            where t.id = '00000000-0000-0000-0000-00000000c00a'),
          '00000000-0000-0000-0000-00000000fa01'::uuid,
          'preferred_file_id was restored from the merge payload');
select is((select state from public.files
            where id = '00000000-0000-0000-0000-00000000fb02'), 'stored',
          'a reclaimed file returns to stored — the ROW is restorable even when the bytes are not');

-- ---------- THE ROUND TRIP ----------
select set_eq(
  $$ select file_id, download_count from public.track_stats $$,
  $$ select file_id, download_count from snap_downloads $$,
  'every download_count is back at its pre-merge value, exactly');
select set_eq(
  $$ select file_id, tag_display, tag_key, created_by, created_at from public.file_tags $$,
  $$ select file_id, tag_display, tag_key, created_by, created_at from snap_tags $$,
  'every file_tags row is back exactly as it was — file, display, key, author and timestamp');
select set_has(
  $$ select file_id, user_id, batch_id from public.file_claims $$,
  $$ select file_id, user_id, batch_id from snap_claims $$,
  'no claim was rolled back: the upload really did happen (PRD §10, contributed never decreases)');
select is((select count(*)::int from public.file_claims
            where file_id = '00000000-0000-0000-0000-00000000fa01'), 2,
  'and the claim the fold added SURVIVES the undo, on purpose — this is the one fold that is not reversed');

select is((select undone_at is not null from public.track_merges
            where id = (select max(m.id) from public.track_merges m)), true,
  'the merge event is marked undone, not deleted');
select is((select undone_by from public.track_merges where id = (select max(m.id) from public.track_merges m)),
          '00000000-0000-0000-0000-0000000000d1'::uuid,
          'and it records who pulled the lever');

-- ---------- idempotent, and ordered ----------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select throws_ok(
  $$ select public.undo_merge((select max(id) from public.track_merges)) $$,
  'P0001', 'merge already undone',
  'undoing twice is an error, not a second silent no-op');
reset role;

-- Re-merge b -> a, then stack a -> c on top. Unwinding must be newest
-- first: undoing the earlier one out of order does not fail later, it
-- silently produces a chain nobody intended.
do $$ begin
  perform public.merge_tracks('00000000-0000-0000-0000-00000000c00b',
                              '00000000-0000-0000-0000-00000000c00a');
  perform public.merge_tracks('00000000-0000-0000-0000-00000000c00a',
                              '00000000-0000-0000-0000-00000000c00c');
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select throws_ok(
  -- the earlier of the two live merges: m1 is already undone, so the
  -- minimum un-undone id is the b -> a re-merge with a -> c stacked on it.
  $$ select public.undo_merge(
       (select min(m.id) from public.track_merges m where m.undone_at is null)) $$,
  'P0001', 'a later merge depends on this one',
  'undo refuses out of order rather than corrupting the chain');

-- ---------- authz ----------
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select throws_ok(
  $$ select public.undo_merge((select max(m.id) from public.track_merges m)) $$,
  '42501', 'forbidden',
  'a member who is not the owner cannot undo a merge');
select throws_ok(
  $$ select public.merge_tracks(gen_random_uuid(), gen_random_uuid()) $$,
  '42501', 'permission denied for function merge_tracks',
  'and no member may merge at all — every collapse comes from the matcher or the owner');
reset role;

-- ---------- degenerate inputs ----------
select throws_ok(
  $$ select public.merge_tracks('00000000-0000-0000-0000-00000000c00c',
                                '00000000-0000-0000-0000-00000000c00c') $$,
  'P0001', 'merge_tracks: nothing to merge',
  'a track cannot be merged into itself');
select throws_ok(
  $$ select public.merge_tracks('00000000-0000-0000-0000-00000000c00b',
                                '00000000-0000-0000-0000-00000000c00c') $$,
  'P0001', 'merge_tracks: nothing to merge',
  'nor into a track it has already collapsed into — both sides resolve through the chain first');

select * from finish();
rollback;
