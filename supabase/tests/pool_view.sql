begin;
select plan(17);

-- allowlist BEFORE auth.users: handle_new_user() raises 'not allowlisted'
-- otherwise, and the on_auth_user_created trigger provisions public.members
-- itself -- so members rows are never inserted by hand here, only updated.
insert into public.allowlist (email) values ('pv1@gmail.com'), ('pv2@gmail.com'), ('pvx@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1','pv1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000d2','pv2@gmail.com'),
  ('00000000-0000-0000-0000-0000000000de','pvx@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000d1',
                   '00000000-0000-0000-0000-0000000000d2');
update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000de';

-- ---- the pure helpers ----
select is( public.filename_stem('Aphex Twin - Xtal.flac'), 'Aphex Twin - Xtal',
           'filename_stem drops the extension' );

select is( public.display_artist('{"artist":"Autechre"}'::jsonb, 'whatever.mp3'), 'Autechre',
           'display_artist prefers the tag' );
select is( public.display_artist('{}'::jsonb, 'Aphex Twin - Xtal.flac'), 'Aphex Twin',
           'display_artist falls back to the filename before the first " - "' );
select is( public.display_artist('{}'::jsonb, 'untitled bounce.wav'), null,
           'display_artist is NULL rather than a guess when there is no separator' );

select is( public.display_title('{"title":"Xtal"}'::jsonb, 'garbage.mp3'), 'Xtal',
           'display_title prefers the tag' );
select is( public.display_title('{}'::jsonb, 'Aphex Twin - Xtal.flac'), 'Xtal',
           'display_title falls back to the filename after the first " - "' );
select is( public.display_title('{}'::jsonb, 'untitled bounce.wav'), 'untitled bounce',
           'display_title falls back to the whole stem' );
select is( public.display_title('{"title":"   "}'::jsonb, 'Real - Name.mp3'), 'Name',
           'a whitespace-only tag is treated as absent' );

select is( public.camelot_neighbours('12B'), array['12B','1B','11B','12A'],
           '12B wraps forward to 1B and back to 11B' );
select is( public.camelot_neighbours('1A'), array['1A','2A','12A','1B'],
           '1A wraps back to 12A' );
select is( public.camelot_neighbours('nope'), null,
           'an unparseable key yields NULL, so the caller can reject it' );

-- ---- the view's derived columns ----
insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000db','00000000-0000-0000-0000-0000000000d1');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-00000000df01','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/00000000-0000-0000-0000-0000000000d1/00000000-0000-0000-0000-00000000df01.flac',
   'Aphex Twin - Xtal.flac', 30000000, 'flac', 'stored'),
  ('00000000-0000-0000-0000-00000000df02','00000000-0000-0000-0000-0000000000db',
   '00000000-0000-0000-0000-0000000000d1',
   'audio/00000000-0000-0000-0000-0000000000d1/00000000-0000-0000-0000-00000000df02.mp3',
   'fake.mp3', 8000000, 'mp3', 'quarantined');

insert into public.audio_analysis (file_id, analysis_version, duration_ms, bpm, key_camelot, raw_tags)
values
  ('00000000-0000-0000-0000-00000000df01','v1', 300000, 128, '10A', '{}'::jsonb),
  ('00000000-0000-0000-0000-00000000df02','v1', 200000,   0, '2A',  '{}'::jsonb);

select is( (select camelot_sort from public.pool_tracks
             where file_id = '00000000-0000-0000-0000-00000000df01'), 100,
           'camelot_sort of 10A is 100' );
select is( (select camelot_sort from public.pool_tracks
             where file_id = '00000000-0000-0000-0000-00000000df02'), 20,
           'camelot_sort of 2A is 20 -- so 2A sorts BEFORE 10A, unlike text' );
select is( (select uploader_name from public.pool_tracks
             where file_id = '00000000-0000-0000-0000-00000000df01'), 'pv1',
           'uploader_name is the email local part, not the address' );

-- ---- audio_analysis is reachable and correctly gated ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';

-- A missing base GRANT raises 42501, NOT an empty result. lives_ok is what
-- tells the two apart.
select lives_ok( $$ select 1 from public.audio_analysis limit 1 $$,
                 'authenticated can reach audio_analysis at all (base grant present)' );
select is( (select count(*)::int from public.audio_analysis), 1,
           'a second member sees analysis for the stored file and not for the quarantined one' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000de"}';
select is( (select count(*)::int from public.audio_analysis), 0,
           'an expired member sees no analysis at all' );

select * from finish();
rollback;
