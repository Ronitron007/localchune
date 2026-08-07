begin;
select plan(12);

-- ============================================================
-- Migration 35 -- art_file_ids on crate_list() and feed_new_crates().
--
-- The column feeds the crate card's stacked-sleeve artwork, so what has to
-- hold is: crate ORDER, artworked files ONLY, a cap of four, never null,
-- and both functions agreeing exactly. Everything migrations 27 and 31
-- already guaranteed about those two functions is asserted in crates.sql
-- and feed.sql; this file only covers what 35 added, plus the ACL, which
-- a DROP + CREATE re-arms from the hosted default and would silently hand
-- back to `anon` if the revoke were ever dropped.
-- ============================================================

insert into public.allowlist (email) values ('cart1@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1','cart1@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id = '00000000-0000-0000-0000-0000000000c1';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000cb','00000000-0000-0000-0000-0000000000c1');

-- Six stored files. ca02 and ca05 deliberately have NO artwork: the stack
-- must skip them rather than draw an empty sleeve, and skipping them is
-- also what proves the cap counts artworked files rather than positions.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
select id, '00000000-0000-0000-0000-0000000000cb',
       '00000000-0000-0000-0000-0000000000c1',
       'audio/c1/' || id || '.flac', 'T.flac', 1000, 'flac', 'stored'
  from (values
    ('00000000-0000-0000-0000-00000000ca01'::uuid),
    ('00000000-0000-0000-0000-00000000ca02'::uuid),
    ('00000000-0000-0000-0000-00000000ca03'::uuid),
    ('00000000-0000-0000-0000-00000000ca04'::uuid),
    ('00000000-0000-0000-0000-00000000ca05'::uuid),
    ('00000000-0000-0000-0000-00000000ca06'::uuid)
  ) as f(id);

insert into public.audio_analysis (file_id, analysis_version, duration_ms, raw_tags, thumb_key)
values
  ('00000000-0000-0000-0000-00000000ca01','v1', 200000, '{}'::jsonb, 'thumb.jpg'),
  ('00000000-0000-0000-0000-00000000ca02','v1', 200000, '{}'::jsonb, null),
  ('00000000-0000-0000-0000-00000000ca03','v1', 200000, '{}'::jsonb, 'thumb.jpg'),
  ('00000000-0000-0000-0000-00000000ca04','v1', 200000, '{}'::jsonb, 'thumb.jpg'),
  ('00000000-0000-0000-0000-00000000ca05','v1', 200000, '{}'::jsonb, null),
  ('00000000-0000-0000-0000-00000000ca06','v1', 200000, '{}'::jsonb, 'thumb.jpg');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

-- One public crate holding all six, and one empty private crate.
select public.crate_create('Stacked') as id \gset stacked_
select public.crate_create('Hollow')  as id \gset hollow_

-- Added in a deliberately NON-id order so "crate position order" and "file
-- id order" cannot be satisfied by the same answer: ca06 goes in first.
select public.crate_add(:'stacked_id', '00000000-0000-0000-0000-00000000ca06');
select public.crate_add(:'stacked_id', '00000000-0000-0000-0000-00000000ca02');
select public.crate_add(:'stacked_id', '00000000-0000-0000-0000-00000000ca01');
select public.crate_add(:'stacked_id', '00000000-0000-0000-0000-00000000ca03');
select public.crate_add(:'stacked_id', '00000000-0000-0000-0000-00000000ca04');
select public.crate_add(:'stacked_id', '00000000-0000-0000-0000-00000000ca05');
select public.crate_set_public(:'stacked_id', true);

reset role;

-- ---- schema ----
select has_function('public', 'crate_list', array[]::text[],
  'crate_list still exists after the drop/recreate');                          -- 1
select has_function('public', 'feed_new_crates', array['int'],
  'feed_new_crates still exists after the drop/recreate');                     -- 2

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

-- ---- crate order, artworked only, capped ----
select is(
  (select art_file_ids from public.crate_list() where id = :'stacked_id'),
  array['00000000-0000-0000-0000-00000000ca06',
        '00000000-0000-0000-0000-00000000ca01',
        '00000000-0000-0000-0000-00000000ca03',
        '00000000-0000-0000-0000-00000000ca04']::uuid[],
  'crate_list art_file_ids: crate position order, artless files skipped, capped at four' );  -- 3

select is(
  (select array_length(art_file_ids, 1) from public.crate_list() where id = :'stacked_id'),
  4,
  'crate_list art_file_ids never exceeds four even with six items' );          -- 4

-- ca02 and ca05 have no thumb_key. If the filter were dropped they would
-- appear at positions 2 and 6, and the first four would be ca06, ca02,
-- ca01, ca03 -- so this is a different assertion from the ordering one
-- above, not a restatement of it.
select ok(
  not (:'stacked_id'::uuid in (
    select id from public.crate_list()
     where '00000000-0000-0000-0000-00000000ca02'::uuid = any (art_file_ids))),
  'crate_list art_file_ids never includes a file with no artwork' );           -- 5

-- ---- an empty crate is '{}', never null ----
select is(
  (select art_file_ids from public.crate_list() where id = :'hollow_id'),
  '{}'::uuid[],
  'crate_list art_file_ids is an empty array for an empty crate, not null' );  -- 6

select ok(
  (select art_file_ids is not null from public.crate_list() where id = :'hollow_id'),
  'an empty crate''s art_file_ids is NOT NULL -- a card branches on length' ); -- 7

-- ---- the feed agrees, column for column ----
select is(
  (select art_file_ids from public.feed_new_crates(50) where id = :'stacked_id'),
  (select art_file_ids from public.crate_list()      where id = :'stacked_id'),
  'feed_new_crates art_file_ids is identical to crate_list''s for the same crate' ); -- 8

select is(
  (select art_file_ids from public.feed_new_crates(50) where id = :'stacked_id'),
  array['00000000-0000-0000-0000-00000000ca06',
        '00000000-0000-0000-0000-00000000ca01',
        '00000000-0000-0000-0000-00000000ca03',
        '00000000-0000-0000-0000-00000000ca04']::uuid[],
  'feed_new_crates art_file_ids: same order, same filter, same cap' );         -- 9

-- ---- migration 27/31's own guarantees survived the recreate ----
select is(
  (select track_count from public.crate_list() where id = :'stacked_id'),
  6,
  'crate_list track_count is unchanged by migration 35' );                     -- 10

reset role;

-- ---- the ACL, which a DROP re-arms from the hosted default ----
set local role anon;
select throws_ok(
  $$ select public.crate_list() $$,
  '42501', null, 'anon cannot execute crate_list after the recreate' );        -- 11
select throws_ok(
  $$ select public.feed_new_crates() $$,
  '42501', null, 'anon cannot execute feed_new_crates after the recreate' );   -- 12
reset role;

select * from finish();
rollback;
