-- supabase/tests/track_formats.sql
-- localchune — MIT licensed. See LICENSE.
--
-- Migration 38 — every encode of one recording, for /track/[id]'s Formats
-- section.
--
-- What has to be proven, and why each one is here rather than assumed:
--
--   SIBLING LISTING     a merged pair must appear as TWO rows under EITHER
--                       file's id. That is the whole feature: migration 37
--                       collapsed the browse surfaces, and this is where
--                       the encode it hid has to be findable. Asking from
--                       the NON-face file matters as much as from the face
--                       — a member arrives here from a link, not from the
--                       row that won the collapse.
--   TOMBSTONE EXCLUSION migration 33's 'deleted' file never appears, and a
--                       deleted SEED returns nothing rather than its live
--                       siblings. A tombstone must not be a back door into
--                       a recording.
--   is_face             the same rule track_face_file() gives every other
--                       surface, including the fall-through when
--                       preferred_file_id is itself deleted. Exactly one
--                       true per recording.
--   THE ORDER           preferred first, then tier, then average bitrate.
--                       The client does not re-sort, so this is the only
--                       place the order is decided.
--   42501               anon cannot call it, and track_face_file() is
--                       STILL unreachable from `authenticated` — this
--                       function is what made that revoke load-bearing a
--                       second time.
begin;
select plan(25);

insert into public.allowlist (email) values
  ('tf1@gmail.com'), ('tf2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','tf1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000a2','tf2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000a1',
                   '00000000-0000-0000-0000-0000000000a2');
update public.members set username = 'tfada'
 where user_id = '00000000-0000-0000-0000-0000000000a1';
update public.members set username = 'tfbob'
 where user_id = '00000000-0000-0000-0000-0000000000a2';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a2');

-- THE MERGED-PAIR FIXTURE, and it is deliberately cross-uploader: tfada's
-- flac and tfbob's mp3 are one recording, which is the shape /member/ collapse
-- trades away and this section gives back.
--
--   e1  Mochakk - Vida     THREE files -- d1 flac (tfada, preferred, tier 5),
--                          d2 mp3 320   (tfbob, tier 3),
--                          d3 mp3 192   (tfbob, tier 2)
--   e2  Overmono - Bby     TWO files -- d4 flac DELETED (was preferred),
--                          d5 m4a stored. The face falls through.
--   e3  Gone - Nowhere     ONE file, DELETED. No visible member at all.
--   e4  Bicep - Glue       THREE files -- d7 flac (preferred, tier 5) and
--                          TWO tier-3 mp3s, d8 fat and da thin, with da the
--                          NEWER of the pair. Only the inferred bitrate can
--                          separate d8 from da, and created_at would put
--                          them the other way round.
--   d6  trackless mp3 -- the dedup backstop has not reached it.
insert into public.tracks (id) values
  ('00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000e2'),
  ('00000000-0000-0000-0000-0000000000e3'),
  ('00000000-0000-0000-0000-0000000000e4');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container,
   codec, sample_rate, bit_depth, channels, state, track_id, created_at)
values
  -- Track e1's tiers all differ, so tier alone orders it. Track e4 at the
  -- bottom is what pins the bitrate tie-break, where two rows share a tier.
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000a1','audio/a1/d1.flac','Mochakk - Vida.flac',
   30000000,'flac','flac',44100,16,2,'stored','00000000-0000-0000-0000-0000000000e1',
   now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000a2','audio/a2/d2.mp3','Mochakk - Vida 320.mp3',
   12000000,'mp3','mp3',44100,null,2,'stored','00000000-0000-0000-0000-0000000000e1',
   now() - interval '4 days'),
  ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000a2','audio/a2/d3.mp3','Mochakk - Vida 192.mp3',
   7200000,'mp3','mp3',44100,null,2,'stored','00000000-0000-0000-0000-0000000000e1',
   now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000a1','audio/a1/d4.flac','Overmono - Bby.flac',
   31000000,'flac','flac',44100,24,2,'deleted','00000000-0000-0000-0000-0000000000e2',
   now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000000d5','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000a2','audio/a2/d5.m4a','Overmono - Bby.m4a',
   9000000,'m4a','aac',44100,null,2,'stored','00000000-0000-0000-0000-0000000000e2',
   now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000d6','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000a2','audio/a2/d6.mp3','Skee Mask - 808 Rush.mp3',
   7000000,'mp3','mp3',44100,null,2,'stored', null,
   now() - interval '12 hours'),
  ('00000000-0000-0000-0000-0000000000d9','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000a1','audio/a1/d9.flac','Gone - Nowhere.flac',
   500000,'flac','flac',44100,16,2,'deleted','00000000-0000-0000-0000-0000000000e3',
   now() - interval '6 days'),
  ('00000000-0000-0000-0000-0000000000d7','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000a1','audio/a1/d7.flac','Bicep - Glue.flac',
   33000000,'flac','flac',44100,24,2,'stored','00000000-0000-0000-0000-0000000000e4',
   now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000000000d8','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000a2','audio/a2/d8.mp3','Bicep - Glue 320.mp3',
   12000000,'mp3','mp3',44100,null,2,'stored','00000000-0000-0000-0000-0000000000e4',
   now() - interval '8 days'),
  ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000a2','audio/a2/da.mp3','Bicep - Glue 256.mp3',
   9600000,'mp3','mp3',44100,null,2,'stored','00000000-0000-0000-0000-0000000000e4',
   now() - interval '7 days');

update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d1'
 where id = '00000000-0000-0000-0000-0000000000e1';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d4'
 where id = '00000000-0000-0000-0000-0000000000e2';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d9'
 where id = '00000000-0000-0000-0000-0000000000e3';
update public.tracks set preferred_file_id = '00000000-0000-0000-0000-0000000000d7'
 where id = '00000000-0000-0000-0000-0000000000e4';

-- Same duration on every Vida encode, so byte_size alone decides the
-- inferred bitrate and the ORDER BY has something unambiguous to compare.
insert into public.audio_analysis
  (file_id, analysis_version, duration_ms, bpm, key_camelot, key_open, key_musical,
   quality_tier, quality_score, meas_cutoff_hz, raw_tags)
values
  ('00000000-0000-0000-0000-0000000000d1','v1',300000,128,'8A','1m','Am',5,0.98,22050,
   '{"artist":"Mochakk","title":"Vida","apID":"buyer@example.com"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2','v1',300000,128,'8A','1m','Am',3,0.60,20000,
   '{"artist":"Mochakk","title":"Vida"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d3','v1',300000,128,'8A','1m','Am',2,0.40,16000,
   '{"artist":"Mochakk","title":"Vida"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d4','v1',250000,134,'9A','2m','Em',5,0.97,22050,
   '{"artist":"Overmono","title":"Bby"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d5','v1',250000,134,'9A','2m','Em',3,0.62,19000,
   '{"artist":"Overmono","title":"Bby"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d6','v1',400000,160,'1A','10m','Am',3,0.61,19500,
   '{"artist":"Skee Mask","title":"808 Rush"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d9','v1',200000,100,'2A','9m','Bm',1,0.20,14000,
   '{"artist":"Gone","title":"Nowhere"}'::jsonb),
  -- Track e4: ONE duration across all three, so byte_size alone decides the
  -- inferred bitrate, and d8/da share a tier so nothing else can order them.
  ('00000000-0000-0000-0000-0000000000d7','v1',300000,122,'5A','4m','Cm',5,0.96,22050,
   '{"artist":"Bicep","title":"Glue"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d8','v1',300000,122,'5A','4m','Cm',3,0.60,20000,
   '{"artist":"Bicep","title":"Glue"}'::jsonb),
  ('00000000-0000-0000-0000-00000000000a','v1',300000,122,'5A','4m','Cm',3,0.58,19000,
   '{"artist":"Bicep","title":"Glue"}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';

-- ══════════════ 1. the merged pair, from BOTH ends
select is( (select count(*)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d1')), 3,
           'the face file lists all three encodes of its recording' );
select is( (select count(*)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d3')), 3,
           'and the WORST encode lists the same three -- a member arrives here '
           'from a link, not from the row that won the collapse' );
select set_eq(
  $$ select f.file_id from public.track_formats('00000000-0000-0000-0000-0000000000d2') f $$,
  $$ values ('00000000-0000-0000-0000-0000000000d1'::uuid),
            ('00000000-0000-0000-0000-0000000000d2'::uuid),
            ('00000000-0000-0000-0000-0000000000d3'::uuid) $$,
  'the three ids are the three files of track e1 and nothing else' );
select is( (select count(distinct f.uploaded_by)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d1') f), 2,
           'the pair is CROSS-UPLOADER: tfada''s flac and tfbob''s mp3s under one '
           'recording -- the exact row /member/ collapse trades away' );

-- ══════════════ 2. is_face -- migration 34's rule, surfaced as a boolean
select is( (select f.file_id from public.track_formats(
              '00000000-0000-0000-0000-0000000000d3') f where f.is_face),
           '00000000-0000-0000-0000-0000000000d1'::uuid,
           'is_face is preferred_file_id when that file is stored -- the flac, '
           'and asking from the mp3 does not change the answer' );
select is( (select count(*)::int from public.track_formats(
              '00000000-0000-0000-0000-0000000000d3') f where f.is_face), 1,
           'exactly ONE row per recording is the face' );
select is( (select f.file_id from public.track_formats(
              '00000000-0000-0000-0000-0000000000d5') f where f.is_face),
           '00000000-0000-0000-0000-0000000000d5'::uuid,
           'when preferred_file_id is DELETED the face falls through to the '
           'newest stored file -- same fall-through pool_list collapses on' );
select is( (select f.is_current from public.track_formats(
              '00000000-0000-0000-0000-0000000000d3') f
             where f.file_id = '00000000-0000-0000-0000-0000000000d3'), true,
           'is_current marks the file whose page this is' );
select is( (select count(*)::int from public.track_formats(
              '00000000-0000-0000-0000-0000000000d3') f where f.is_current), 1,
           'and exactly one row is current' );

-- ══════════════ 3. tombstones (migration 33), both directions
select is( (select count(*)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d5')), 1,
           'the DELETED flac is not listed beside its live sibling -- a format '
           'list never offers bytes that are gone' );
select is( (select count(*)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d4')), 0,
           'and a DELETED SEED returns nothing at all, not its live siblings: '
           'a tombstone is not a back door into a recording' );
select is( (select count(*)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d9')), 0,
           'a recording whose every file is deleted has no formats' );
select is( (select count(*)::int
              from public.track_formats('99999999-9999-4999-8999-999999999999')), 0,
           'an unknown uuid is the same empty answer as a hidden one -- the '
           'function never says "exists, but not yours"' );

-- ══════════════ 4. a trackless file is its own recording
select is( (select count(*)::int
              from public.track_formats('00000000-0000-0000-0000-0000000000d6')), 1,
           'a file the dedup backstop has not reached lists exactly itself -- '
           'the section must not blink out for every new upload' );
select is( (select f.is_face from public.track_formats(
              '00000000-0000-0000-0000-0000000000d6') f), true,
           'and it is its own face, matching the `track_id is null` survival '
           'arm every collapsed surface gives it' );
select is( (select f.track_id from public.track_formats(
              '00000000-0000-0000-0000-0000000000d6') f), null::uuid,
           'its track_id is still null -- nothing here invents one' );

-- ══════════════ 5. THE ORDER, decided once, on the server
select is( (select array_agg(f.file_id order by f.ord)
              from (select f.*, row_number() over () as ord
                      from public.track_formats(
                        '00000000-0000-0000-0000-0000000000d3') f) f),
           array['00000000-0000-0000-0000-0000000000d1',
                 '00000000-0000-0000-0000-0000000000d2',
                 '00000000-0000-0000-0000-0000000000d3']::uuid[],
           'preferred first, then tier 3, then tier 2 -- and the client does '
           'not re-sort, so this ORDER BY is the only ordering authority' );
select is( (select array_agg(f.container order by f.ord)
              from (select f.*, row_number() over () as ord
                      from public.track_formats(
                        '00000000-0000-0000-0000-0000000000d3') f) f),
           array['flac','mp3','mp3'],
           'read as containers: FLAC, then the 320, then the 192' );
-- THE BITRATE TIE-BREAK, on track e4, where the two lossy encodes share a
-- tier. `da` is NEWER than `d8`, so if the sort ever fell through to
-- created_at this assertion inverts -- which is the point of building the
-- fixture that way rather than relying on insertion order.
select is( (select array_agg(f.file_id order by f.ord)
              from (select f.*, row_number() over () as ord
                      from public.track_formats(
                        '00000000-0000-0000-0000-0000000000d8') f) f),
           array['00000000-0000-0000-0000-0000000000d7',
                 '00000000-0000-0000-0000-0000000000d8',
                 '00000000-0000-0000-0000-00000000000a']::uuid[],
           'on EQUAL tiers the fatter encode wins -- byte_size/duration_ms, '
           'which is arithmetic over two true numbers, not a declared bitrate '
           '(migration 21 dropped that column and said why)' );

-- ══════════════ 6. the technical columns the pool view does not carry
select is( (select f.codec from public.track_formats(
              '00000000-0000-0000-0000-0000000000d1') f where f.is_face), 'flac',
           'codec comes off public.files -- pool_tracks has no such column' );
select is( (select f.bit_depth from public.track_formats(
              '00000000-0000-0000-0000-0000000000d1') f where f.is_face), 16,
           'and so do bit_depth...' );
select is( (select f.sample_rate from public.track_formats(
              '00000000-0000-0000-0000-0000000000d1') f where f.is_face), 44100,
           '...and sample_rate' );

-- ══════════════ 7. the grants, and migration 34's revoke re-proved
--
-- d1's raw_tags carry an `apID` — the buyer-identity atom migration 20
-- exists to keep in the database. This function returns no tag column at
-- all, which is the strongest form of that rule, and the assertion is on
-- the SHAPE rather than on a value so it cannot pass by luck.
select is( (select count(*)::int from information_schema.columns
             where table_schema = 'public'
               and table_name = 'track_formats'
               and column_name in ('raw_tags','provenance','r2_key')), 0,
           'no raw_tags, no provenance, no r2_key: migration 20''s rule, and '
           'nothing here presigns' );

select throws_ok(
  $$ select public.track_face_file('00000000-0000-0000-0000-0000000000e1') $$,
  '42501', 'permission denied for function track_face_file',
  'track_face_file is STILL unreachable from `authenticated` -- migration 38 '
  'reads it from inside a SECURITY DEFINER body and did not loosen it' );

set local role anon;
select throws_ok(
  $$ select * from public.track_formats('00000000-0000-0000-0000-0000000000d1') $$,
  '42501', null, 'anon cannot reach track_formats' );

select * from finish();
rollback;
