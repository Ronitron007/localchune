-- localchune — MIT licensed. See LICENSE.
--
-- Migration 32: search_tracks(). Ranking, typo tolerance, token routing,
-- visibility and the ACL.
--
-- EVERY ASSERTION IS SCOPED TO THIS FILE'S OWN FIXTURE IDS, and that is
-- deliberate rather than fussy. search_tracks() returns a ranked TOP-N, so
-- an absolute count would silently become a test of "how much other data
-- happens to be in this database" the moment anyone seeds one — which is
-- exactly the failure mode that had ten test files red on a developer
-- laptop the day this was written. Position within the result is asserted
-- by comparing THIS fixture's ids to each other, never by index.

begin;
select plan(40);

insert into public.allowlist (email) values
  ('se1@gmail.com'), ('se2@gmail.com'), ('sex@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000ae01','se1@gmail.com'),
  ('00000000-0000-0000-0000-00000000ae02','se2@gmail.com'),
  ('00000000-0000-0000-0000-00000000ae0f','sex@gmail.com');

update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-00000000ae01',
                   '00000000-0000-0000-0000-00000000ae02');
-- An expired member: the 42501 gate is about ACTIVE membership, not merely
-- about being signed in.
update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-00000000ae0f';
update public.members set username = 'sunderland'
 where user_id = '00000000-0000-0000-0000-00000000ae01';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-00000000aeba','00000000-0000-0000-0000-00000000ae01'),
  ('00000000-0000-0000-0000-00000000aebb','00000000-0000-0000-0000-00000000ae02');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  -- c1: the ARTIST hit. Tagged, so display_artist comes from raw_tags.
  ('00000000-0000-0000-0000-00000000aec1','00000000-0000-0000-0000-00000000aeba',
   '00000000-0000-0000-0000-00000000ae01','audio/ae01/c1.mp3',
   'Mochakk - Frevo.mp3', 9000000, 'mp3', 'stored'),
  -- c2: the FILENAME hit, and nothing else. 'mocha' appears only in the
  -- filename and the file is untagged, so this is the row that must lose
  -- to c1 -- the ranking assertion this whole file exists for.
  ('00000000-0000-0000-0000-00000000aec2','00000000-0000-0000-0000-00000000aeba',
   '00000000-0000-0000-0000-00000000ae01','audio/ae01/c2.mp3',
   'ripped-from-mocha-latte-radio-show-2019.mp3', 9000000, 'mp3', 'stored'),
  -- c3: an ACCENTED artist, for unaccent.
  ('00000000-0000-0000-0000-00000000aec3','00000000-0000-0000-0000-00000000aeba',
   '00000000-0000-0000-0000-00000000ae01','audio/ae01/c3.mp3',
   'Kolsch - Grey.mp3', 9000000, 'mp3', 'stored'),
  -- c4/c5/c6: the BPM and key fixtures.
  ('00000000-0000-0000-0000-00000000aec4','00000000-0000-0000-0000-00000000aebb',
   '00000000-0000-0000-0000-00000000ae02','audio/ae02/c4.mp3',
   'Peverelist - Ashland.mp3', 9000000, 'mp3', 'stored'),
  ('00000000-0000-0000-0000-00000000aec5','00000000-0000-0000-0000-00000000aebb',
   '00000000-0000-0000-0000-00000000ae02','audio/ae02/c5.mp3',
   'Batu - So U Kno.mp3', 9000000, 'mp3', 'stored'),
  ('00000000-0000-0000-0000-00000000aec6','00000000-0000-0000-0000-00000000aebb',
   '00000000-0000-0000-0000-00000000ae02','audio/ae02/c6.mp3',
   'Objekt - Rrose.mp3', 9000000, 'mp3', 'stored'),
  -- c9: another member's FAILED file, carrying the SAME artist as c1 so a
  -- visibility leak would show up as an extra Mochakk row rather than as
  -- a query that happens to match nothing.
  ('00000000-0000-0000-0000-00000000aec9','00000000-0000-0000-0000-00000000aebb',
   '00000000-0000-0000-0000-00000000ae02','audio/ae02/c9.mp3',
   'Mochakk - Secret Dub.mp3', 9000000, 'mp3', 'failed');

insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, bpm, key_camelot, quality_tier, raw_tags)
values
  ('00000000-0000-0000-0000-00000000aec1','v1',300000,126.5,'8A',5,
   '{"artist":"Mochakk","title":"Frevo"}'::jsonb),
  ('00000000-0000-0000-0000-00000000aec2','v1',300000,129.0,'9A',3,'{}'::jsonb),
  ('00000000-0000-0000-0000-00000000aec3','v1',300000,131.0,'8B',4,
   '{"artist":"Kölsch","title":"Grey"}'::jsonb),
  ('00000000-0000-0000-0000-00000000aec4','v1',300000,139.0,'7A',4,'{}'::jsonb),
  ('00000000-0000-0000-0000-00000000aec5','v1',300000,100.0,'2A',3,'{}'::jsonb),
  ('00000000-0000-0000-0000-00000000aec6','v1',300000,128.0,'5A',3,'{}'::jsonb),
  ('00000000-0000-0000-0000-00000000aec9','v1',300000,128.0,'8A',5,
   '{"artist":"Mochakk","title":"Secret Dub"}'::jsonb);

insert into public.file_tags (file_id, tag_key, tag_display, created_by) values
  ('00000000-0000-0000-0000-00000000aec4','peaktime','Peaktime',
   '00000000-0000-0000-0000-00000000ae02');

-- ====================================================================
-- The ACL. Proved BEFORE any successful call, so a later `ok` can never
-- be read as "it was reachable all along".
-- ====================================================================
select ok( not has_function_privilege('anon', 'public.search_tracks(text, int)', 'EXECUTE'),
           'anon holds no EXECUTE on search_tracks -- revoke-first, not grant-only' );
select ok( has_function_privilege('authenticated', 'public.search_tracks(text, int)', 'EXECUTE'),
           'authenticated does hold it' );

-- The expression indexes are evaluated under the WRITING role, so the
-- three functions they name must be executable by it. This is the
-- assertion that would have caught the defect that shipped in the first
-- draft of migration 32 (see its header).
select ok( has_function_privilege('authenticated', 'public.search_norm(text)', 'EXECUTE'),
           'authenticated may execute search_norm -- or every insert into files fails' );
select ok( has_function_privilege('authenticated', 'public.display_artist(jsonb, text)', 'EXECUTE'),
           'authenticated may execute display_artist -- the audio_analysis index names it' );
select ok( has_function_privilege('authenticated', 'public.display_title(jsonb, text)', 'EXECUTE'),
           'authenticated may execute display_title -- likewise' );

-- ...and the grant above is NOT a way back to raw_tags. Migration 20/28's
-- boundary, re-proved from this file rather than assumed.
select ok( not has_column_privilege('authenticated', 'public.audio_analysis', 'raw_tags', 'SELECT'),
           'granting the tag FUNCTIONS did not re-grant the raw_tags COLUMN' );

select has_index('public', 'files',          'files_search_filename_trgm',
                 'the filename trigram index exists' );
select has_index('public', 'audio_analysis', 'audio_analysis_search_artist_trgm',
                 'the tag-artist trigram index exists' );
select has_index('public', 'audio_analysis', 'audio_analysis_search_title_trgm',
                 'the tag-title trigram index exists' );
select has_index('public', 'file_tags',      'file_tags_search_key_trgm',
                 'the tag-key trigram index exists' );

-- An anonymous caller is refused, and refused with 42501 rather than with
-- an empty result -- "no rows" and "not allowed" must never look alike.
-- The SQLSTATE only, deliberately: anon holds no EXECUTE at all, so the
-- call dies at the ACL ("permission denied for function search_tracks")
-- and never reaches the body's own `forbidden`. Both are 42501 and both
-- are correct; pinning the MESSAGE here would pin WHICH of the two layers
-- refuses anon, and either one refusing is the property under test.
set local role anon;
select throws_ok(
  $$ select * from public.search_tracks('mocha') $$,
  '42501',
  'anon calling search_tracks raises 42501' );

-- An EXPIRED member is refused too: signed in is not the same as active.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ae0f"}';
select throws_ok(
  $$ select * from public.search_tracks('mocha') $$,
  '42501', 'forbidden',
  'a member whose access has lapsed raises 42501 as well' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ae01"}';

-- ====================================================================
-- RANKING
-- ====================================================================
-- The headline: an ARTIST match outranks a match that exists only inside a
-- filename. Asserted as "c1 scores strictly more than c2", which is the
-- claim itself -- an ordering assertion by array position would also pass
-- if both rows scored zero.
select ok(
  (select s.score from public.search_tracks('mocha', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec1')
  >
  (select s.score from public.search_tracks('mocha', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec2'),
  'the Mochakk track outranks the filename that merely contains "mocha"' );

select is(
  (select s.file_id from public.search_tracks('mocha', 50) s limit 1),
  '00000000-0000-0000-0000-00000000aec1'::uuid,
  '...and it is therefore the first row returned' );

select ok(
  (select count(*)::int from public.search_tracks('mocha', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec2') = 1,
  'the filename hit is still RETURNED -- ranked below, not discarded' );

-- ====================================================================
-- TYPO TOLERANCE
-- ====================================================================
select ok(
  (select count(*)::int from public.search_tracks('mochak', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec1') = 1,
  'a truncated query still finds it ("mochak")' );

-- The one that needs trigrams rather than a prefix: `mochack` is not a
-- prefix of `mochakk`, is not a substring of it, and differs by a
-- transposition. Only similarity can carry this.
select ok(
  (select count(*)::int from public.search_tracks('mochack', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec1') = 1,
  'a genuinely misspelt query still finds it ("mochack") -- prefix cannot explain this one' );

select ok(
  (select count(*)::int from public.search_tracks('zzzqqxwv', 50)) = 0,
  'a query that resembles nothing returns nothing, rather than everything' );

-- ====================================================================
-- UNACCENT
-- ====================================================================
select ok(
  (select count(*)::int from public.search_tracks('kolsch', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec3') = 1,
  'an unaccented query finds an accented artist (Kölsch)' );
select ok(
  (select count(*)::int from public.search_tracks('kölsch', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec3') = 1,
  '...and the accented spelling finds it too' );

-- ====================================================================
-- TOKEN ROUTING -- BPM
-- ====================================================================
-- 128 +/- 6 % is 120.32 .. 135.68, so 126.5, 129.0, 131.0 and 128.0 are in
-- and 139.0 / 100.0 are out.
select is(
  (select array_agg(s.file_id order by s.file_id) from public.search_tracks('128', 50) s),
  array['00000000-0000-0000-0000-00000000aec1',
        '00000000-0000-0000-0000-00000000aec2',
        '00000000-0000-0000-0000-00000000aec3',
        '00000000-0000-0000-0000-00000000aec6']::uuid[],
  '"128" is a tempo window: it takes 126.5/128/129/131 and leaves 139 and 100' );

select is(
  (select array_agg(s.file_id order by s.file_id) from public.search_tracks('128bpm', 50) s),
  array['00000000-0000-0000-0000-00000000aec1',
        '00000000-0000-0000-0000-00000000aec2',
        '00000000-0000-0000-0000-00000000aec3',
        '00000000-0000-0000-0000-00000000aec6']::uuid[],
  '"128bpm" routes identically -- the unit is noise, not a different query' );

select is(
  (select s.file_id from public.search_tracks('128', 50) s limit 1),
  '00000000-0000-0000-0000-00000000aec6'::uuid,
  'the exact 128.0 sorts first inside the window -- +/-2 before the rest' );

select ok(
  (select count(*)::int from public.search_tracks('139', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec4') = 1,
  'a different tempo selects a different track' );

-- Two digits minimum, and a plausible range: `8` is not a tempo, and a
-- number outside 40..300 stays text rather than silently vanishing.
select ok(
  (select count(*)::int from public.search_tracks('2019', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec2') = 1,
  '"2019" is not a tempo -- it stays text and matches the filename that contains it' );

-- ====================================================================
-- TOKEN ROUTING -- CAMELOT
-- ====================================================================
-- 8A's neighbours are 8A, 9A, 7A and the relative 8B. c1=8A, c2=9A,
-- c3=8B, c4=7A are in; c5=2A and c6=5A are out.
select is(
  (select array_agg(s.file_id order by s.file_id) from public.search_tracks('8A', 50) s),
  array['00000000-0000-0000-0000-00000000aec1',
        '00000000-0000-0000-0000-00000000aec2',
        '00000000-0000-0000-0000-00000000aec3',
        '00000000-0000-0000-0000-00000000aec4']::uuid[],
  '"8A" takes 8A and its harmonic neighbours 9A, 7A and 8B -- and nothing else' );

select is(
  (select s.file_id from public.search_tracks('8A', 50) s limit 1),
  '00000000-0000-0000-0000-00000000aec1'::uuid,
  'the EXACT key sorts ahead of its neighbours' );

select is(
  (select array_agg(s.file_id order by s.file_id) from public.search_tracks('8a', 50) s),
  array['00000000-0000-0000-0000-00000000aec1',
        '00000000-0000-0000-0000-00000000aec2',
        '00000000-0000-0000-0000-00000000aec3',
        '00000000-0000-0000-0000-00000000aec4']::uuid[],
  'lower case reads as the same key -- a member types what is on the deck' );

-- ====================================================================
-- TOKENS AND TEXT TOGETHER
-- ====================================================================
select is(
  (select array_agg(s.file_id) from public.search_tracks('mochakk 128', 50) s),
  array['00000000-0000-0000-0000-00000000aec1']::uuid[],
  'text and a tempo compose: the tempo filters, the text ranks' );

select ok(
  (select count(*)::int from public.search_tracks('mochakk 100', 50)) = 0,
  '...and a tempo the text does not sit in returns nothing, not the text match anyway' );

-- ====================================================================
-- OTHER FIELDS
-- ====================================================================
select ok(
  (select count(*)::int from public.search_tracks('peaktime', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec4') = 1,
  'a file_tags tag is searchable' );

select ok(
  (select count(*)::int from public.search_tracks('sunderland', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec1') = 1,
  'the uploader username is searchable' );

-- ====================================================================
-- VISIBILITY -- the point of the whole exercise
-- ====================================================================
select is(
  (select count(*)::int from public.search_tracks('Secret Dub', 50)), 0,
  'another member''s FAILED file is never returned, though it has analysis and tags' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ae02"}';
select is(
  (select count(*)::int from public.search_tracks('Secret Dub', 50)), 0,
  '...and its OWN uploader cannot find it either: a search row is a play target' );

select ok(
  (select count(*)::int from public.search_tracks('mocha', 50) s
    where s.file_id = '00000000-0000-0000-0000-00000000aec9') = 0,
  'the failed file does not sneak in through a query that matches its artist' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ae01"}';

-- ====================================================================
-- ARGUMENTS AND EDGES
-- ====================================================================
select is( (select count(*)::int from public.search_tracks('')),   0,
           'an empty query asks nothing and gets nothing -- not the whole pool' );
select is( (select count(*)::int from public.search_tracks('   ')), 0,
           'whitespace is the same as empty' );
select is( (select count(*)::int from public.search_tracks(null)), 0,
           'a null query is the same as empty' );
select is( (select count(*)::int from public.search_tracks('100%', 50)), 0,
           'a percent sign is a literal, not a wildcard' );
select is( (select count(*)::int from public.search_tracks('mocha', 1)), 1,
           'the limit is honoured' );

select * from finish();
rollback;
