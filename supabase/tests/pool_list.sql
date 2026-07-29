begin;
select plan(25);

-- allowlist BEFORE auth.users; the on_auth_user_created trigger provisions
-- public.members, so members rows are only ever updated here.
insert into public.allowlist (email) values
  ('pl1@gmail.com'), ('pl2@gmail.com'), ('plx@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','pl1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2','pl2@gmail.com'),
  ('00000000-0000-0000-0000-0000000000ee','plx@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000e1',
                   '00000000-0000-0000-0000-0000000000e2');
update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000ee';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000e2');

-- Six stored files plus one failed one. Note every created_at is identical
-- (now() is transaction time), which is deliberate: it forces the file_id
-- tiebreak in the keyset to do real work.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000a1.flac',
   'Aphex Twin - Xtal.flac',        30000000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000a2.flac',
   'Goldie - Timeless.flac',        40000000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e2',
   'audio/00000000-0000-0000-0000-0000000000e2/00000000-0000-0000-0000-0000000000a3.mp3',
   'Bleep - Halfstep.mp3',           8000000, 'mp3',  'stored'),
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e2',
   'audio/00000000-0000-0000-0000-0000000000e2/00000000-0000-0000-0000-0000000000a4.mp3',
   'House - Steady.mp3',             9000000, 'mp3',  'stored'),
  ('00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e2',
   'audio/00000000-0000-0000-0000-0000000000e2/00000000-0000-0000-0000-0000000000a5.mp3',
   'Edge - Just Inside.mp3',         9000000, 'mp3',  'stored'),
  ('00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-0000000000bb',
   '00000000-0000-0000-0000-0000000000e2',
   'audio/00000000-0000-0000-0000-0000000000e2/00000000-0000-0000-0000-0000000000a6.mp3',
   'Edge - Just Outside.mp3',        9000000, 'mp3',  'stored'),
  ('00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000a9.mp3',
   'Broken - Never Landed.mp3',      1000000, 'mp3',  'failed');

-- a9 gets an analysis row too, so that the only thing excluding it from the
-- pool is `state = 'stored'` and not a missing join partner.
insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, bpm, key_camelot, quality_tier, raw_tags)
values
  ('00000000-0000-0000-0000-0000000000a1','v1', 300000, 128, '10A', 5, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a2','v1', 400000, 174, '12B', 4, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a3','v1', 200000,  87, '1B',  2, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a4','v1', 250000, 100, '2A',  3, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a5','v1', 260000, 179, '12A', 3, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a6','v1', 270000, 180, '5A',  1, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a9','v1', 100000,   0, null,  null, '{}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

-- ---- pool visibility ----
select is( (select count(*)::int from public.pool_list()), 6,
           'the uploader sees all six stored files and not their own failed one' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';
select is( (select count(*)::int from public.pool_list()), 6,
           'a second member sees the same six -- the pool is shared' );
select is( (select count(*)::int from public.pool_list(p_q => 'Never Landed')), 0,
           'a failed file is in no one''s pool, even though it has analysis' );

-- ---- text ----
select is( (select count(*)::int from public.pool_list(p_q => 'timeless')), 1,
           'search is case-insensitive and reaches the filename-derived title' );
select is( (select count(*)::int from public.pool_list(p_q => '100%')), 0,
           'a percent sign is a literal, not a wildcard' );

-- ---- bpm, half/double, +/-3% ----
select is( (select count(*)::int from public.pool_list(p_bpm_min => 86, p_bpm_max => 86)), 1,
           'a plain 86 bpm query matches only the 87 bpm track (+/-3%)' );
select is( (select count(*)::int from public.pool_list(
              p_bpm_min => 86, p_bpm_max => 86, p_half_double => true)), 2,
           'with half/double on, the 174 bpm track matches an 86 bpm query' );
select is( (select count(*)::int from public.pool_list(p_bpm_min => 174, p_bpm_max => 174)), 2,
           '+/-3% of 174 reaches 179 (upper bound 179.22)' );
select is( (select count(*)::int from public.pool_list(
              p_bpm_min => 174, p_bpm_max => 174, p_q => 'Just Outside')), 0,
           '+/-3% of 174 does NOT reach 180 -- the tolerance is a bound, not a mood' );

-- ---- key: exact vs harmonic, including the wraparound ----
select is( (select array_agg(l.key_camelot order by l.key_camelot)
              from public.pool_list(p_key => '12B') l),
           array['12B'],
           'exact key mode returns only that key' );
select is( (select array_agg(l.key_camelot order by l.key_camelot)
              from public.pool_list(p_key => '12B', p_harmonic => true) l),
           array['12A','12B','1B'],
           '12B harmonic wraps forward to 1B and includes the relative 12A' );
select is( (select count(*)::int from public.pool_list(
              p_key => '12B', p_harmonic => true, p_q => 'Steady')), 0,
           '12B harmonic does NOT include 2A -- the wheel is not an integer line' );
select is( (select array_agg(l.key_camelot order by l.key_camelot)
              from public.pool_list(p_key => '1A', p_harmonic => true) l),
           array['12A','1B','2A'],
           '1A harmonic wraps backward to 12A' );

-- ---- tier, uploader ----
select is( (select count(*)::int from public.pool_list(p_tier_min => 4)), 2,
           'tier_min excludes lower tiers and rows with no tier' );
select is( (select count(*)::int from public.pool_list(
              p_uploader => '00000000-0000-0000-0000-0000000000e1')), 2,
           'the uploader filter narrows to one member' );

-- ---- sort ----
-- row_number() over () with no ORDER BY numbers the rows in the order the
-- function scan produced them, which is the thing under test. Aggregating
-- without it would let the aggregate impose its own order and the
-- assertion would pass whatever pool_list did.
select is( (select array_agg(x.key_camelot order by x.rn)
              from (select k.key_camelot, row_number() over () as rn
                      from public.pool_list(p_sort => 'key_asc', p_limit => 3) k) x),
           array['1B','2A','5A'],
           'key_asc sorts 1B, 2A, 5A -- 10A is fourth, not second, so the composite sort works' );

-- ---- Task 8: artist_asc, case-insensitive, tie-broken by file_id ----
-- Artists (from the filename fallback, since none of these have raw_tags):
-- Aphex Twin(a1), Goldie(a2), Bleep(a3), House(a4), Edge(a5), Edge(a6).
-- Case-insensitive alpha order: Aphex Twin, Bleep, Edge, Edge, Goldie, House
-- -- a5/a6 tie on "edge" and fall back to file_id order (...a5 < ...a6).
select is( (select array_agg(x.file_id order by x.rn)
              from (select k.file_id, row_number() over () as rn
                      from public.pool_list(p_sort => 'artist_asc', p_limit => 6) k) x),
           array['00000000-0000-0000-0000-0000000000a1',
                 '00000000-0000-0000-0000-0000000000a3',
                 '00000000-0000-0000-0000-0000000000a5',
                 '00000000-0000-0000-0000-0000000000a6',
                 '00000000-0000-0000-0000-0000000000a2',
                 '00000000-0000-0000-0000-0000000000a4']::uuid[],
           'artist_asc orders case-insensitively by display_artist, tied artists tie-broken by file_id' );

-- ---- cursor paging ----
-- sk_added is fixed width, so max(row_cursor) is exactly the last row of
-- page one in (sk, file_id) order.
select is( (select count(*)::int from public.pool_list(
              p_limit => 3,
              p_cursor => (select max(l.row_cursor) from public.pool_list(p_limit => 3) l))), 3,
           'the second page returns the remaining three rows' );
select is( (select count(distinct x.file_id)::int from (
              select p.file_id from public.pool_list(p_limit => 3) p
              union all
              select n.file_id from public.pool_list(
                p_limit => 3,
                p_cursor => (select max(l.row_cursor) from public.pool_list(p_limit => 3) l)) n
            ) x), 6,
           'two pages of three cover all six rows with no overlap and no gap' );

-- ---- rejections ----
select throws_ok( $$ select * from public.pool_list(p_key => '13Q') $$,
                  '22023', null::text,
                  'an off-wheel key is rejected as invalid input, not silently ignored' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ee"}';
select throws_ok( $$ select * from public.pool_list() $$,
                  '42501', null::text,
                  'an expired member is refused in the database, not in the Worker' );

-- ---- migration 16b: LEFT JOIN null-safety ----
-- reset role first: 'authenticated' has no INSERT on files (see
-- ingest_state_machine.sql's identical comment) -- these two fixture rows
-- are written the same way every other file/analysis row in this file was,
-- just deferred so they cannot shift the "six stored files" counts every
-- earlier assertion in this file already depends on.
reset role;

-- A failed file with NO audio_analysis row at all (analysis_fail() never
-- writes one) -- confirms pool_list's exclusion is keyed on state alone
-- and never depended on an analysis row existing to filter through.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000a7.mp3',
   'Broken - No Analysis At All.mp3', 1000000, 'mp3', 'failed');

-- A 'stored' file with no audio_analysis row is a combination the ingest
-- pipeline should never produce (analysis_persist() is what sets 'stored'
-- and it always writes the row in the same transaction) -- but the sort
-- keys must be defensively correct regardless, not merely correct for the
-- shapes the pipeline happens to produce today.
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000a8','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000a8.mp3',
   'Zzz - Stored With No Analysis.mp3', 1000000, 'mp3', 'stored');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select is( (select count(*)::int from public.pool_list(p_q => 'No Analysis At All')), 0,
           'a failed file with no analysis row is still excluded from the general pool' );

-- max(row_cursor) is the last row bpm_asc actually emits (sk_bpm is fixed-
-- width and "C"-collated, so string-max and emission-order-max agree) --
-- this checks pool_list's OWN ordering, not a client-side re-sort.
select is(
  (select p.file_id from public.pool_list(p_sort => 'bpm_asc', p_limit => 100) p
    where p.row_cursor = (select max(l.row_cursor)
                             from public.pool_list(p_sort => 'bpm_asc', p_limit => 100) l)),
  '00000000-0000-0000-0000-0000000000a8'::uuid,
  'a stored file with no analysis row sorts LAST under bpm_asc, same sentinel as a null bpm' );

-- ---- Task 8: q matches display_artist specifically, not merely the
-- filename/title it is usually derived from ----
-- a10's artist comes from a raw_tags 'artist' key; its filename carries no
-- artist substring at all ("Track7.mp3"), so a p_q hit for the artist name
-- can only be explained by display_artist being part of the search, not by
-- original_filename/display_title incidentally containing the same text
-- (which is what every other fixture row in this file would let slide).
-- reset role first -- 'authenticated' (still in effect from above) has no
-- INSERT grant on files/audio_analysis, same reasoning as a7/a8 above.
reset role;
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000ba',
   '00000000-0000-0000-0000-0000000000e1',
   'audio/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000aa.mp3',
   'Track7.mp3', 5000000, 'mp3', 'stored');
insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values ('00000000-0000-0000-0000-0000000000aa','v1', 200000, 120, '6A',
        '{"artist":"Boards of Canada"}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select is( (select count(*)::int from public.pool_list(p_q => 'Boards of Canada')), 1,
           'q matches display_artist sourced from a raw_tags artist key, absent from the filename entirely' );
select is( (select count(*)::int from public.pool_list(p_q => 'Track7')), 1,
           'q still matches the filename too -- the artist match is additive, not a replacement' );

select * from finish();
rollback;
