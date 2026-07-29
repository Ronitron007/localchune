begin;
select plan(38);

-- Two active members. A (d1) owns every crate created below; B (d2) exists
-- to prove ownership/visibility gates in both directions.
insert into public.allowlist (email) values ('cra@gmail.com'), ('crb@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','cra@gmail.com'),
  ('00000000-0000-0000-0000-0000000000d2','crb@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000d1',
                   '00000000-0000-0000-0000-0000000000d2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000db','00000000-0000-0000-0000-0000000000d1');

-- cf01/cf02/cf03: the ordering fixture (crate_add x3, remove, reorder).
-- cf04: the "crated file later fails analysis" fixture -- starts stored,
-- flipped to failed mid-test.
-- cf05: the visibility fixture (lives in the crate that gets toggled public).
-- cf06: the final-review (I1b) "hidden item must not deadlock reorder"
-- fixture -- starts stored, flipped to failed mid-test, alongside cf01 in a
-- crate of its own.
-- All owned by A, all pool-visible (stored) at insert time.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000cf01','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf01.flac','One.flac',   1000,'flac','stored'),
  ('00000000-0000-0000-0000-00000000cf02','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf02.flac','Two.flac',   1000,'flac','stored'),
  ('00000000-0000-0000-0000-00000000cf03','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf03.flac','Three.flac', 1000,'flac','stored'),
  ('00000000-0000-0000-0000-00000000cf04','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf04.flac','Four.flac',  1000,'flac','stored'),
  ('00000000-0000-0000-0000-00000000cf05','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf05.flac','Five.flac',  1000,'flac','stored'),
  ('00000000-0000-0000-0000-00000000cf06','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1','audio/d1/cf06.flac','Six.flac',   1000,'flac','stored');

insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000cf01','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000cf02','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000cf03','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000cf04','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000cf05','v1', 200000, 128, '8A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000cf06','v1', 200000, 128, '8A', '{}'::jsonb);

-- Generated crate ids (crate_create/crate_rename return uuids; crates itself
-- has no base grant to authenticated) are stashed here by label so later
-- statements can look them up regardless of which role is currently active.
-- Same idea as ingest_state_machine.sql's t_batch, just keyed for reuse.
create temporary table crate_ids (label text primary key, id uuid not null);
grant all on crate_ids to authenticated;

-- ---- schema + closure ----
select has_table('public', 'crates', 'crates exists');
select has_table('public', 'crate_items', 'crate_items exists');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

select throws_ok(
  $$insert into public.crates (owner_id, name) values (auth.uid(), 'direct')$$,
  '42501', null, 'direct INSERT into crates denied' );
select throws_ok(
  $$insert into public.crate_items (crate_id, file_id, position)
    values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000cf01', 1)$$,
  '42501', null, 'direct INSERT into crate_items denied' );

-- ---- crate_create: validation ----
select throws_ok(
  $$ select public.crate_create('') $$,
  '22023', null, 'an empty name is refused' );
select throws_ok(
  format($$ select public.crate_create(%L) $$, repeat('x', 81)),
  '22023', null, 'an 81-character name is refused -- the cap is 80' );

-- ---- crate_create: trim + auto-suffix, own-name collisions only ----
insert into crate_ids (label, id) select 'a1', public.crate_create('  Warehouse  ');
select is(
  (select name from public.crate_list() where id = (select id from crate_ids where label = 'a1')),
  'Warehouse',
  'crate_create trims surrounding whitespace from the name' );

insert into crate_ids (label, id) select 'a2', public.crate_create('Warehouse');
select is(
  (select name from public.crate_list() where id = (select id from crate_ids where label = 'a2')),
  'Warehouse (2)',
  'a second same-owner crate named "Warehouse" auto-suffixes to "Warehouse (2)"' );

insert into crate_ids (label, id) select 'a3', public.crate_create('Warehouse');
select is(
  (select name from public.crate_list() where id = (select id from crate_ids where label = 'a3')),
  'Warehouse (3)',
  'a third same-owner crate named "Warehouse" auto-suffixes to "Warehouse (3)"' );

-- ---- crate_rename: same auto-suffix search, self excluded ----
insert into crate_ids (label, id) select 'a4', public.crate_create('Crate Four');
select public.crate_rename(
  (select id from crate_ids where label = 'a4'), 'Warehouse' );
select is(
  (select name from public.crate_list() where id = (select id from crate_ids where label = 'a4')),
  'Warehouse (4)',
  'crate_rename into an own existing (suffixed-family) name auto-suffixes the same way' );

-- ---- cross-owner name freedom ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
insert into crate_ids (label, id) select 'b1', public.crate_create('Warehouse');
select is(
  (select name from public.crate_list() where id = (select id from crate_ids where label = 'b1')),
  'Warehouse',
  'a different owner may use the exact same name -- no suffix' );

-- ---- ownership: B refused on every mutating RPC against A's crate (a1) ----
select throws_ok(
  format($$ select public.crate_rename(%L, 'Hijacked') $$,
    (select id from crate_ids where label = 'a1')),
  '42501', null, 'a non-owner cannot rename another member''s crate' );
select throws_ok(
  format($$ select public.crate_delete(%L) $$,
    (select id from crate_ids where label = 'a1')),
  '42501', null, 'a non-owner cannot delete another member''s crate' );
select throws_ok(
  format($$ select public.crate_set_public(%L, true) $$,
    (select id from crate_ids where label = 'a1')),
  '42501', null, 'a non-owner cannot toggle another member''s crate public' );
select throws_ok(
  format($$ select public.crate_add(%L, '00000000-0000-0000-0000-00000000cf01'::uuid) $$,
    (select id from crate_ids where label = 'a1')),
  '42501', null, 'a non-owner cannot add to another member''s crate' );
select throws_ok(
  format($$ select public.crate_remove(%L, '00000000-0000-0000-0000-00000000cf01'::uuid) $$,
    (select id from crate_ids where label = 'a1')),
  '42501', null, 'a non-owner cannot remove from another member''s crate' );
select throws_ok(
  format($$ select public.crate_reorder(%L, array['00000000-0000-0000-0000-00000000cf01'::uuid]) $$,
    (select id from crate_ids where label = 'a1')),
  '42501', null, 'a non-owner cannot reorder another member''s crate' );

-- ---- ordering: append positions, gap on remove, full rewrite on reorder ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
insert into crate_ids (label, id) select 'a_ordered', public.crate_create('Ordered');

select public.crate_add((select id from crate_ids where label = 'a_ordered'),
                         '00000000-0000-0000-0000-00000000cf01'::uuid);
select public.crate_add((select id from crate_ids where label = 'a_ordered'),
                         '00000000-0000-0000-0000-00000000cf02'::uuid);
select public.crate_add((select id from crate_ids where label = 'a_ordered'),
                         '00000000-0000-0000-0000-00000000cf03'::uuid);

select results_eq(
  format($$ select position, file_id from public.crate_get(%L) order by position $$,
    (select id from crate_ids where label = 'a_ordered')),
  $$ values (1::int, '00000000-0000-0000-0000-00000000cf01'::uuid),
            (2::int, '00000000-0000-0000-0000-00000000cf02'::uuid),
            (3::int, '00000000-0000-0000-0000-00000000cf03'::uuid) $$,
  'three crate_add calls land at positions 1, 2, 3 in insertion order' );

select public.crate_remove((select id from crate_ids where label = 'a_ordered'),
                            '00000000-0000-0000-0000-00000000cf02'::uuid);
select results_eq(
  format($$ select position, file_id from public.crate_get(%L) order by position $$,
    (select id from crate_ids where label = 'a_ordered')),
  $$ values (1::int, '00000000-0000-0000-0000-00000000cf01'::uuid),
            (3::int, '00000000-0000-0000-0000-00000000cf03'::uuid) $$,
  'removing the middle item leaves a gap (1, 3) rather than renumbering' );

select public.crate_reorder(
  (select id from crate_ids where label = 'a_ordered'),
  array['00000000-0000-0000-0000-00000000cf03'::uuid,
        '00000000-0000-0000-0000-00000000cf01'::uuid] );
select results_eq(
  format($$ select position, file_id from public.crate_get(%L) order by position $$,
    (select id from crate_ids where label = 'a_ordered')),
  $$ values (1::int, '00000000-0000-0000-0000-00000000cf03'::uuid),
            (2::int, '00000000-0000-0000-0000-00000000cf01'::uuid) $$,
  'crate_reorder rewrites positions to 1..n in the given order' );

-- ---- crate_reorder: non-set-equal arrays (current items: cf03, cf01) ----
select throws_ok(
  format($$ select public.crate_reorder(%L, array['00000000-0000-0000-0000-00000000cf03'::uuid]) $$,
    (select id from crate_ids where label = 'a_ordered')),
  '22023', null, 'crate_reorder rejects an array missing one of the crate''s current items' );
select throws_ok(
  format($$ select public.crate_reorder(%L,
              array['00000000-0000-0000-0000-00000000cf03'::uuid,
                    '00000000-0000-0000-0000-00000000cf01'::uuid,
                    '00000000-0000-0000-0000-00000000cf02'::uuid]) $$,
    (select id from crate_ids where label = 'a_ordered')),
  '22023', null, 'crate_reorder rejects an array containing a file that is not in the crate' );
select throws_ok(
  format($$ select public.crate_reorder(%L,
              array['00000000-0000-0000-0000-00000000cf03'::uuid,
                    '00000000-0000-0000-0000-00000000cf03'::uuid]) $$,
    (select id from crate_ids where label = 'a_ordered')),
  '22023', null, 'crate_reorder rejects an array with a duplicate id' );

-- ---- visibility + made_public_at/updated_at ----
insert into crate_ids (label, id) select 'a_toggle', public.crate_create('Toggle Me');
select public.crate_add((select id from crate_ids where label = 'a_toggle'),
                         '00000000-0000-0000-0000-00000000cf05'::uuid);

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select throws_ok(
  format($$ select public.crate_get(%L) $$, (select id from crate_ids where label = 'a_toggle')),
  '42501', null, 'a non-owner cannot crate_get a private crate' );

-- Backdate updated_at so the later "bumped" assertion actually distinguishes
-- "rewritten to now()" from "left untouched" -- the whole test file is one
-- transaction, so now() is frozen and two `now()`-derived values are only
-- meaningfully different if one of them was captured before this backdate.
reset role;
update public.crates set updated_at = now() - interval '1 hour'
 where id = (select id from crate_ids where label = 'a_toggle');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select public.crate_set_public((select id from crate_ids where label = 'a_toggle'), true);

reset role;
select ok(
  (select made_public_at is not null from public.crates
    where id = (select id from crate_ids where label = 'a_toggle')),
  'crate_set_public(true) sets made_public_at' );
select ok(
  (select updated_at > (now() - interval '5 minutes') from public.crates
    where id = (select id from crate_ids where label = 'a_toggle')),
  'crate_set_public bumps updated_at' );

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select results_eq(
  format($$ select position, file_id, download_count, tags, like_count
              from public.crate_get(%L) $$,
    (select id from crate_ids where label = 'a_toggle')),
  $$ values (1::int, '00000000-0000-0000-0000-00000000cf05'::uuid, 0::bigint, '{}'::text[], 0::int) $$,
  'crate_get renders pool_get-shaped columns for a now-public crate viewed by a non-owner' );

select is(
  (select is_mine from public.crate_list() where id = (select id from crate_ids where label = 'a_toggle')),
  false,
  'crate_list as a non-owner shows the (now public) crate with is_mine = false' );
select is(
  (select count(*)::int from public.crate_list()
    where id = (select id from crate_ids where label = 'a_ordered')),
  0,
  'crate_list as a non-owner never includes another member''s private crate' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select public.crate_set_public((select id from crate_ids where label = 'a_toggle'), false);

reset role;
select ok(
  (select made_public_at is null from public.crates
    where id = (select id from crate_ids where label = 'a_toggle')),
  'crate_set_public(false) clears made_public_at' );

-- ---- a crated file that later fails analysis drops out, not 500s ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
insert into crate_ids (label, id) select 'a_fade', public.crate_create('Fade');
select public.crate_add((select id from crate_ids where label = 'a_fade'),
                         '00000000-0000-0000-0000-00000000cf04'::uuid);
select is(
  (select count(*)::int from public.crate_get((select id from crate_ids where label = 'a_fade'))),
  1,
  'crate_get returns the crated file while it is still pool-visible (stored)' );

reset role;
update public.files set state = 'failed'
 where id = '00000000-0000-0000-0000-00000000cf04';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select is(
  (select count(*)::int from public.crate_get((select id from crate_ids where label = 'a_fade'))),
  0,
  'a crated file that later fails analysis silently drops out of crate_get instead of raising' );

-- ---- final-review I1a: crate_add refuses a non-pool-visible file ----
-- cf04 is already 'failed' from the a_fade block above -- reuse it directly
-- rather than adding a fourth file to the fixture.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
insert into crate_ids (label, id) select 'a_hidden_add', public.crate_create('Hidden Add');
select throws_ok(
  format($$ select public.crate_add(%L, '00000000-0000-0000-0000-00000000cf04'::uuid) $$,
    (select id from crate_ids where label = 'a_hidden_add')),
  'P0002', null, 'crate_add refuses a file whose state is not pool-visible (failed)' );

-- ---- final-review I1b: a hidden item must not deadlock crate_reorder ----
-- cf06 is added FIRST (position 1), cf01 SECOND (position 2); cf06 then
-- flips to failed, so this crate's pool-visible items are {cf01} alone. The
-- array a real client can even construct only ever contains what
-- crate_get shows it (pool-visible items) -- under the OLD full-crate
-- set-equality check this array could never satisfy crate_reorder (its
-- length would always be short by the hidden item), permanently 22023ing
-- any reorder of a crate holding a hidden item.
insert into crate_ids (label, id) select 'a_reorder_hidden', public.crate_create('Reorder Hidden');
select public.crate_add((select id from crate_ids where label = 'a_reorder_hidden'),
                         '00000000-0000-0000-0000-00000000cf06'::uuid);
select public.crate_add((select id from crate_ids where label = 'a_reorder_hidden'),
                         '00000000-0000-0000-0000-00000000cf01'::uuid);

reset role;
update public.files set state = 'failed'
 where id = '00000000-0000-0000-0000-00000000cf06';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select lives_ok(
  format($$ select public.crate_reorder(%L, array['00000000-0000-0000-0000-00000000cf01'::uuid]) $$,
    (select id from crate_ids where label = 'a_reorder_hidden')),
  'crate_reorder succeeds given only the crate''s pool-visible items, even though it also holds a hidden (failed) one' );

select results_eq(
  format($$ select position, file_id from public.crate_get(%L) $$,
    (select id from crate_ids where label = 'a_reorder_hidden')),
  $$ values (1::int, '00000000-0000-0000-0000-00000000cf01'::uuid) $$,
  'crate_get shows only the visible item, renumbered to position 1' );

reset role;
select is(
  (select position from public.crate_items
    where crate_id = (select id from crate_ids where label = 'a_reorder_hidden')
      and file_id = '00000000-0000-0000-0000-00000000cf06'),
  2,
  'the hidden item is renumbered to a position after n (n=1) instead of colliding with the deferred unique constraint at commit' );

-- ---- anon cannot execute at all -- 42501 before the body ever runs ----
set local role anon;
select throws_ok(
  $$ select public.crate_create('Anon Crate') $$,
  '42501', null, 'anon cannot execute crate_create' );
select throws_ok(
  $$ select public.crate_get('00000000-0000-0000-0000-000000000000'::uuid) $$,
  '42501', null, 'anon cannot execute crate_get' );

select * from finish();
rollback;
