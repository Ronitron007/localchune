begin;
select plan(13);

-- ============================================================
-- Migration 20: the raw_tags privacy boundary.
--
-- The fixture below is a faithful iTunes purchase: alongside the safe
-- release metadata it carries the BUYER'S identity (apid/account_id =
-- the purchaser's Apple ID email, ownr, xid), the binary normalization
-- atoms (itunnorm/itunsmpb) and lyrics. Every forbidden value embeds
-- the marker string POISON, so one regex over the ENTIRE serialized
-- pool_get row proves no forbidden value escapes by any column — the
-- test that matters.
-- ============================================================

-- ---- provenance_from_tags(): the allowlist, at the unit level ----
-- (EXECUTE is revoked from client roles, so these run as postgres —
-- the same pattern pool_view.sql uses for display_artist/tag_value.)

select is(
  public.provenance_from_tags('{
    "title": "Gold", "artist": "Q",
    "purchase_date": "2023-11-06 06:55:31",
    "copyright": "℗ 2017 QUESTION EVERYTHING",
    "date": "2017-06-09",
    "genre": "Hip-Hop/Rap",
    "label": "EMPIRE",
    "encoder": "Lavf60.3.100",
    "itunnorm": "ITUNNORM-POISON",
    "itunsmpb": "ITUNSMPB-POISON",
    "apid": "buyer-POISON@example.com",
    "account_id": "buyer-POISON@example.com",
    "ownr": "OWNR-POISON",
    "xid": "XID-POISON",
    "lyrics": "LYRICS-POISON"
  }'::jsonb),
  '{"apple": true,
    "genre": "Hip-Hop/Rap",
    "label": "EMPIRE",
    "encoder": "Lavf60.3.100",
    "copyright": "℗ 2017 QUESTION EVERYTHING",
    "release_date": "2017-06-09",
    "purchase_date": "2023-11-06 06:55:31"}'::jsonb,
  'the full iTunes fixture curates to exactly the six allowlisted values plus the apple flag — nothing else' );

select is(
  public.provenance_from_tags('{"PURCHASE_DATE": "2020-01-02 03:04:05"}'::jsonb),
  '{"purchase_date": "2020-01-02 03:04:05"}'::jsonb,
  'key matching is case-insensitive — the output key is always the canonical lowercase form' );

select is( public.provenance_from_tags('{}'::jsonb), '{}'::jsonb,
           'no tags in, empty object out' );

select is( public.provenance_from_tags(null), '{}'::jsonb,
           'NULL raw_tags (a failed file) curates to an empty object, not NULL' );

select is(
  public.provenance_from_tags('{
    "apid": "buyer@example.com", "account_id": "buyer@example.com",
    "ownr": "o", "xid": "x", "lyrics": "la la la"
  }'::jsonb),
  '{}'::jsonb,
  'buyer-identity-only input yields nothing — and apid does not sneak in through the itun% presence check' );

select is(
  public.provenance_from_tags('{"itunnorm": " 00000150 binary blob "}'::jsonb),
  '{"apple": true}'::jsonb,
  'Apple atoms surface as presence only — the blob value itself is never copied' );

select is(
  public.provenance_from_tags(
    '{"originaldate": "2016-01-01", "date": "2017-06-09"}'::jsonb) ->> 'release_date',
  '2017-06-09',
  'release_date prefers date over originaldate — first named key wins, as tag_value_ci promises' );

-- ---- fixture: one active member, one stored file, poisoned raw_tags ----
insert into public.allowlist (email) values ('prov1@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'prov1@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id = '00000000-0000-0000-0000-0000000000e1';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000eb', '00000000-0000-0000-0000-0000000000e1');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000ef01', '00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/e1/ef01.m4a', '02 GOLD.m4a', 9000000, 'm4a', 'stored');

insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000ef01', 'v1', 300000, 128, '10A', '{
    "title": "Gold", "artist": "Q",
    "purchase_date": "2023-11-06 06:55:31",
    "copyright": "℗ 2017 QUESTION EVERYTHING",
    "date": "2017-06-09",
    "genre": "Hip-Hop/Rap",
    "label": "EMPIRE",
    "encoder": "Lavf60.3.100",
    "itunnorm": "ITUNNORM-POISON",
    "itunsmpb": "ITUNSMPB-POISON",
    "apid": "buyer-POISON@example.com",
    "account_id": "buyer-POISON@example.com",
    "ownr": "OWNR-POISON",
    "xid": "XID-POISON",
    "lyrics": "LYRICS-POISON"
  }'::jsonb);

-- ---- the boundary, as a member sees it ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select is(
  (select g.provenance from public.pool_get('00000000-0000-0000-0000-00000000ef01') g),
  '{"apple": true,
    "genre": "Hip-Hop/Rap",
    "label": "EMPIRE",
    "encoder": "Lavf60.3.100",
    "copyright": "℗ 2017 QUESTION EVERYTHING",
    "release_date": "2017-06-09",
    "purchase_date": "2023-11-06 06:55:31"}'::jsonb,
  'pool_get returns the curated provenance object for a pool-visible file' );

-- The assertion that matters: serialize the ENTIRE row a member
-- receives and prove no forbidden value appears anywhere in it.
select ok(
  (select to_jsonb(g)::text from public.pool_get('00000000-0000-0000-0000-00000000ef01') g)
    !~* 'poison',
  'no buyer-identity, Apple-atom or lyrics value appears ANYWHERE in the pool_get row' );

select ok(
  not (select to_jsonb(g) from public.pool_get('00000000-0000-0000-0000-00000000ef01') g)
        ? 'raw_tags',
  'the raw_tags column itself is gone from pool_get''s output shape' );

-- Path 2: the direct PostgREST read. Migration 11's table-level SELECT
-- is now a column list that omits raw_tags — the ACL denies the column
-- before RLS is ever consulted.
select throws_ok(
  $$ select raw_tags from public.audio_analysis $$,
  '42501', null,
  'authenticated cannot select audio_analysis.raw_tags — closed at the ACL, not by RLS' );

select lives_ok(
  $$ select bpm, key_camelot, quality_tier from public.audio_analysis limit 1 $$,
  'every other audio_analysis column is still readable by authenticated' );

-- ---- grants were re-established after DROP + CREATE ----
set local role anon;
select throws_ok(
  $$ select * from public.pool_get('00000000-0000-0000-0000-00000000ef01') $$,
  '42501', null,
  'anon still cannot execute pool_get — the DROP + CREATE re-established the grants' );

set local role postgres;
select * from finish();
rollback;
