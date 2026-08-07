-- supabase/tests/pool_search.sql
-- localchune — MIT licensed. See LICENSE.
--
-- Migration 37 — /pool becomes the search page.
--
-- Two behaviours are under test and they are not the same behaviour:
--
--   p_collapse -> ONE ROW PER RECORDING. The rule is migration 34's
--                 track_face_file(), and what has to be proven is not just
--                 "one row" but "the RIGHT one": preferred_file_id when
--                 that file is still stored, the newest stored file when
--                 it is not, and nothing at all when no member of the
--                 track is visible.
--   p_q_mode   -> RANKED SEARCH inside the faceted, paginated query. What
--                 has to be proven is that it COMPOSES: a typed query and
--                 a set filter narrow together, relevance PAGES, and the
--                 substring default is untouched (the /artist/808 State
--                 hazard).
--
-- The default-argument assertions are not padding either. /api/queue/
-- candidates calls pool_list() with neither new argument, and a silent
-- change to the queue's candidate source is the "wrong song plays" failure
-- class. The per-file count below is that contract, written down.
begin;
select plan(45);

insert into public.allowlist (email) values
  ('ps1@gmail.com'), ('ps2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1','ps1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000f2','ps2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000f1',
                   '00000000-0000-0000-0000-0000000000f2');
update public.members set username = 'ana'
 where user_id = '00000000-0000-0000-0000-0000000000f1';
update public.members set username = 'ben'
 where user_id = '00000000-0000-0000-0000-0000000000f2';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000f2');

-- Three recordings.
--   t1  Mochakk - Vida    — TWO files (d1 flac, d2 mp3). d1 is preferred.
--   t2  Overmono - Bby    — TWO files (d3 flac, d4 mp3). d3 is preferred
--                           but DELETED, so the face falls through to d4.
--   t3  Bicep - Glue      — ONE file (d5), no merge.
--   (d6 is trackless — the dedup backstop has not reached it yet.)
--   (d9 is a deleted file on its own track: no visible member at all.)
insert into public.tracks (id) values
  ('00000000-0000-0000-0000-0000000000d0'),
  ('00000000-0000-0000-0000-0000000000e0'),
  ('00000000-0000-0000-0000-0000000000e5'),
  ('00000000-0000-0000-0000-0000000000e9');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container,
   state, track_id, created_at)
values
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000f1',
   'audio/f1/d1.flac','Mochakk - Vida.flac', 30000000,'flac','stored',
   '00000000-0000-0000-0000-0000000000d0', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000f2',
   'audio/f2/d2.mp3','Mochakk - Vida.mp3',   8000000,'mp3','stored',
   '00000000-0000-0000-0000-0000000000d0', now() - interval '4 days'),
  ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000f1',
   'audio/f1/d3.flac','Overmono - Bby.flac',31000000,'flac','deleted',
   '00000000-0000-0000-0000-0000000000e0', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000f2',
   'audio/f2/d4.mp3','Overmono - Bby.mp3',   9000000,'mp3','stored',
   '00000000-0000-0000-0000-0000000000e0', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000d5','00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000f1',
   'audio/f1/d5.flac','Bicep - Glue.flac',  32000000,'flac','stored',
   '00000000-0000-0000-0000-0000000000e5', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000d6','00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000f2',
   'audio/f2/d6.mp3','Skee Mask - 808 Rush.mp3', 7000000,'mp3','stored',
   null,                                  now() - interval '12 hours'),
  ('00000000-0000-0000-0000-0000000000d9','00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000f1',
   'audio/f1/d9.flac','Gone - Nowhere.flac',   500000,'flac','deleted',
   '00000000-0000-0000-0000-0000000000e9', now() - interval '6 days');

update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d1'
 where id = '00000000-0000-0000-0000-0000000000d0';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d3'
 where id = '00000000-0000-0000-0000-0000000000e0';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d5'
 where id = '00000000-0000-0000-0000-0000000000e5';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d9'
 where id = '00000000-0000-0000-0000-0000000000e9';

insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, bpm, key_camelot, quality_tier, raw_tags)
values
  ('00000000-0000-0000-0000-0000000000d1','v1', 300000, 128, '8A', 5,
   '{"artist":"Mochakk","title":"Vida"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2','v1', 300000, 128, '8A', 2,
   '{"artist":"Mochakk","title":"Vida"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d3','v1', 250000, 134, '9A', 5,
   '{"artist":"Overmono","title":"Bby"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d4','v1', 250000, 134, '9A', 3,
   '{"artist":"Overmono","title":"Bby"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d5','v1', 350000, 122, '5A', 4,
   '{"artist":"Bicep","title":"Glue"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d6','v1', 400000, 160, '1A', 3,
   '{"artist":"Skee Mask","title":"808 Rush"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d9','v1', 200000, 100, '2A', 1,
   '{"artist":"Gone","title":"Nowhere"}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';

-- ══════════════ 1. the default is unchanged, which is the queue's contract
select is( (select count(*)::int from public.pool_list()), 5,
           'DEFAULT (p_collapse omitted) still lists FILES: five stored, both '
           'Mochakk encodes among them' );
select is( (select count(*)::int from public.pool_list(p_q => 'Vida')), 2,
           'the merged pair is TWO rows per-file -- /api/queue/candidates '
           'keeps exactly the window it always had' );

-- ══════════════ 2. collapse: one row per recording, and the RIGHT one
select is( (select count(*)::int from public.pool_list(p_collapse => true)), 4,
           'p_collapse => true lists RECORDINGS: 5 files become 4 rows' );
select is( (select count(*)::int
              from public.pool_list(p_collapse => true, p_q => 'Vida')), 1,
           'a merged pair yields ONE row' );
select is( (select l.file_id from public.pool_list(p_collapse => true, p_q => 'Vida') l),
           '00000000-0000-0000-0000-0000000000d1'::uuid,
           'the face is preferred_file_id when that file is stored -- the flac, '
           'not the mp3 that happens to be newer' );
select is( (select l.file_id from public.pool_list(p_collapse => true, p_q => 'Bby') l),
           '00000000-0000-0000-0000-0000000000d4'::uuid,
           'when preferred_file_id is DELETED the face falls through to the '
           'newest stored file -- a deleted encode never represents a live track' );
select is( (select count(*)::int
              from public.pool_list(p_collapse => true, p_q => 'Nowhere')), 0,
           'a track whose every file is deleted has no face and appears on no '
           'surface -- collapse is not a way back in for a tombstone' );
select is( (select count(*)::int
              from public.pool_list(p_collapse => true, p_q => '808 Rush')), 1,
           'a TRACKLESS file survives collapse: the dedup backstop has not '
           'reached it and a member who just uploaded must still find it' );

-- ══════════════ 3. tombstones, under both states
select is( (select count(*)::int from public.pool_list(p_q => 'Nowhere')), 0,
           'a deleted file is invisible per-file too (migration 33)' );
select is( (select count(*)::int from public.pool_list(p_q => 'Overmono')), 1,
           'the deleted flac is gone per-file; only the stored mp3 is listed' );

-- ══════════════ 4. the facet counts the same question as the list
select is( (select sum(u.track_count)::int from public.pool_uploaders() u), 5,
           'pool_uploaders() with no argument still counts FILES -- five' );
select is( (select sum(u.track_count)::int
              from public.pool_uploaders(p_collapse => true) u), 4,
           'pool_uploaders(true) counts RECORDINGS -- four, the same number '
           'of rows the list beside it draws' );
select is( (select u.track_count from public.pool_uploaders() u
             where u.uploader_name = 'ben'), 3,
           'per-file, ben owns three of the five' );
select is( (select u.track_count from public.pool_uploaders(p_collapse => true) u
             where u.uploader_name = 'ben'), 2,
           'collapsed, ben owns two faces: his Mochakk mp3 lost to ana''s flac' );

-- THE WRINKLE, WRITTEN DOWN RATHER THAN DISCOVERED. The face of a merged
-- track can belong to a different member from the one filtered for, so an
-- uploader filter under collapse asks "recordings whose representative
-- encode is yours", not "recordings you contributed to". This is migration
-- 34's predicate applied verbatim, as briefed. It is stated here so the
-- next reader meets it as a decision.
select is( (select count(*)::int from public.pool_list(
              p_uploader => '00000000-0000-0000-0000-0000000000f2')), 3,
           'per-file, the uploader facet finds all three of ben''s files' );
select is( (select count(*)::int from public.pool_list(
              p_collapse => true,
              p_uploader => '00000000-0000-0000-0000-0000000000f2')), 2,
           'collapsed, ben''s Mochakk mp3 is not the face, so that recording '
           'is not under his filter -- documented, not accidental' );

-- ══════════════ 5. substring mode is untouched -- the /artist/808 hazard
select is( (select count(*)::int from public.pool_list(p_q => '808')), 1,
           'DEFAULT substring mode reads `808` as a WORD: /artist/808 State '
           'and /artist/4B still search for their own names' );
select is( (select count(*)::int from public.pool_list(p_q => '128')), 0,
           'and `128` in substring mode is a word too -- no track is named it' );
select is( (select count(*)::int from public.pool_list(p_q => '100%')), 0,
           'a percent sign is still a literal, not a wildcard' );

-- ══════════════ 6. fuzzy mode: ranking, typos, tokens
select is( (select count(*)::int from public.pool_list(
              p_q => 'mochack', p_q_mode => 'fuzzy')), 2,
           'fuzzy mode carries a real typo -- `mochack` finds both Vida encodes' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'mochack', p_q_mode => 'fuzzy', p_collapse => true)), 1,
           '...and collapse applies to the ranked answer exactly as it does '
           'to the browse one' );
select is( (select l.display_title from public.pool_list(
              p_q => 'glue', p_q_mode => 'fuzzy', p_sort => 'relevance',
              p_collapse => true) l limit 1),
           'Glue',
           'relevance puts the exact title first' );
-- A WINDOW, NOT A TEXT MATCH. No file here is named `128`, and the answer
-- is four tracks whose tempos sit inside +/-6% of it -- which is the whole
-- claim, stated as the set rather than as a count that a text match could
-- also have produced.
select is( (select array_agg(l.bpm::int order by l.bpm) from public.pool_list(
              p_q => '128', p_q_mode => 'fuzzy') l),
           array[122, 128, 128, 134],
           'a two-digit number routes to the TEMPO branch in fuzzy mode: the '
           '+/-6% window around 128, not a text match' );
select is( (select array_agg(distinct l.key_camelot order by l.key_camelot)
              from public.pool_list(
                p_q => '8A', p_q_mode => 'fuzzy', p_collapse => true) l),
           array['8A','9A'],
           'a Camelot token routes to the key branch: 8A plus its harmonic '
           'neighbours, of which 9A is present' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'zzzzqqqq', p_q_mode => 'fuzzy')), 0,
           'the 0.10 score floor drops noise rather than returning the pool' );
select is( (select count(*)::int from public.pool_list(
              p_q => '...', p_q_mode => 'fuzzy')), 0,
           'punctuation routes to no token and returns nothing, never everything' );

-- ══════════════ 7. THE MERGE ITSELF: a query and a filter compose
select is( (select count(*)::int from public.pool_list(
              p_q => 'vida', p_q_mode => 'fuzzy', p_tier_min => 4)), 1,
           'query AND tier: both Vida encodes match the text, only the flac '
           'clears tier 4' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'vida', p_q_mode => 'fuzzy',
              p_uploader => '00000000-0000-0000-0000-0000000000f2')), 1,
           'query AND uploader compose' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'bicep', p_q_mode => 'fuzzy', p_key => '5A')), 1,
           'query AND key compose' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'bicep', p_q_mode => 'fuzzy', p_key => '8A')), 0,
           '...and a filter that excludes the match really excludes it' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'mochakk', p_q_mode => 'fuzzy',
              p_bpm_min => 120, p_bpm_max => 130)), 2,
           'query AND an explicit tempo window compose' );

-- A TOKEN AND A CHIP ON THE SAME AXIS ARE ANDed. No precedence rule --
-- see the migration header for why one was written and thrown away.
select is( (select array_agg(l.bpm::int order by l.bpm) from public.pool_list(
              p_q => '128', p_q_mode => 'fuzzy',
              p_bpm_min => 127, p_bpm_max => 129) l),
           array[128, 128],
           'the OVERLAP case is the common one: a 127-129 chip and a `128` '
           'token intersect rather than fight' );
select is( (select count(*)::int from public.pool_list(
              p_q => '128', p_q_mode => 'fuzzy',
              p_bpm_min => 150, p_bpm_max => 165)), 0,
           'the CONTRADICTION case returns nothing -- the honest answer to a '
           '150-165 chip and a 128 token' );
select is( (select count(*)::int from public.pool_list(
              p_q => '8A', p_q_mode => 'fuzzy', p_key => '5A')), 0,
           'and the same on the key axis' );

-- ══════════════ 8. relevance PAGES -- the thing a top-N cannot do
select is( (select count(*)::int from public.pool_list(
              p_q => 'a', p_q_mode => 'fuzzy', p_sort => 'relevance',
              p_limit => 2)), 2,
           'relevance honours p_limit' );
select is( (select count(*)::int from public.pool_list(
              p_q => 'mochakk vida', p_q_mode => 'fuzzy', p_sort => 'relevance',
              p_cursor => (select l.row_cursor from public.pool_list(
                             p_q => 'mochakk vida', p_q_mode => 'fuzzy',
                             p_sort => 'relevance', p_limit => 1) l))), 1,
           'the relevance cursor returns the REST, not the same row again -- '
           'keyset pagination composes with a score' );
select is( (select count(*)::int from public.pool_list(
              p_sort => 'relevance')), 5,
           'relevance with an empty box degrades to added_desc rather than '
           'ordering the pool by uuid' );

-- ══════════════ 9. the argument surface refuses nonsense
select throws_ok(
  $$ select * from public.pool_list(p_q_mode => 'regex') $$,
  '22023', null, 'an unknown query mode is refused, not silently ignored' );
select throws_ok(
  $$ select * from public.pool_list(p_sort => 'score') $$,
  '22023', null, 'an unknown sort is still refused' );

-- ══════════════ 10. the ACL surface
-- track_face_file() STAYS REVOKED. A member-facing page now depends on it,
-- and the dependency runs INSIDE a SECURITY DEFINER body -- never from the
-- member's own role. Re-proved here rather than assumed from migration 34,
-- because this migration is what made it load-bearing.
select throws_ok(
  $$ select public.track_face_file('00000000-0000-0000-0000-0000000000d0') $$,
  '42501', 'permission denied for function track_face_file',
  'track_face_file is still unreachable from `authenticated` -- migration 37 '
  'did NOT loosen it to make /pool work' );
select throws_ok(
  $$ select * from public.search_hits('vida', '%vida%') $$,
  '42501', 'permission denied for function search_hits',
  'search_hits reads raw_tags and is definer-body only' );
select throws_ok(
  $$ select * from public.search_tokens('128 mochakk') $$,
  '42501', 'permission denied for function search_tokens',
  'search_tokens is definer-body only' );
select throws_ok(
  $$ select public.search_score('a', 'b', '{}'::text[], 'c', 'd', 'a') $$,
  '42501', 'permission denied for function search_score',
  'search_score is definer-body only, like search_field_score itself' );

set local role anon;
select throws_ok(
  $$ select * from public.pool_list(p_collapse => true, p_q_mode => 'fuzzy') $$,
  '42501', null, 'anon cannot reach pool_list, new arguments and all' );
select throws_ok(
  $$ select * from public.pool_uploaders(p_collapse => true) $$,
  '42501', null, 'anon cannot reach pool_uploaders either' );

select * from finish();
rollback;
