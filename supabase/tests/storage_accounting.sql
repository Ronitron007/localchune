begin;
select plan(19);

-- allowlist BEFORE auth.users: handle_new_user() fires at the end of the
-- auth.users insert and raises 'not allowlisted' otherwise. The
-- on_auth_user_created trigger then provisions public.members, so members
-- rows are never inserted by hand here -- only updated.
insert into public.allowlist (email) values
  ('sowner@gmail.com'), ('s1@gmail.com'), ('s2@gmail.com'),
  ('s3@gmail.com'),     ('sgone@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c0','sowner@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c1','s1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2','s2@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c3','s3@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c9','sgone@gmail.com');

update public.members set role = 'owner'
 where user_id = '00000000-0000-0000-0000-0000000000c0';

-- Pin the access window explicitly so this test does not depend on whatever
-- the default grant length happens to be.
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000c0',
                   '00000000-0000-0000-0000-0000000000c1',
                   '00000000-0000-0000-0000-0000000000c2',
                   '00000000-0000-0000-0000-0000000000c3');
update public.members set access_expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000c9';

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000c2');

-- c1 uploads three files. Exactly ONE of them holds bytes.
--   a1  received    100 bytes  -> counts
--   a2  uploading   5 MB       -> in flight, must NOT count
--   a3  failed      7 MB       -> never landed, must NOT count
insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/00000000-0000-0000-0000-0000000000c1/00000000-0000-0000-0000-0000000000a1.flac',
   'shared.flac', 100, 'flac', 'received'),
  ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/00000000-0000-0000-0000-0000000000c1/00000000-0000-0000-0000-0000000000a2.wav',
   'inflight.wav', 5000000, 'wav', 'uploading'),
  ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/00000000-0000-0000-0000-0000000000c1/00000000-0000-0000-0000-0000000000a3.wav',
   'dead.wav', 7000000, 'wav', 'failed');

-- The claim ingest_finalize() writes for the uploader's own file.
insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000e1');

-- THE DEDUPE ROW. c2 dropped the same track, its bytes deduped onto c1's
-- file, and no second object was created. This is exactly the row M4 will
-- insert; it is inserted by hand here because M4 does not exist yet and the
-- accounting rule must be locked down before it does.
insert into public.file_claims (file_id, user_id, batch_id) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000e2');

-- Guards, as postgres, so the assertions below cannot pass vacuously.
select is( (select count(*)::int from public.files
             where uploaded_by = '00000000-0000-0000-0000-0000000000c1'), 3,
           'c1 really has three files rows' );
select is( (select sum(byte_size)::bigint from public.files
             where uploaded_by = '00000000-0000-0000-0000-0000000000c1'), 12000100::bigint,
           'c1 really has 12,000,100 bytes of rows -- the inflation risk is real' );

-- ---- as the OWNER: sees everybody ----
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c0"}';

select is( (select count(*)::int from public.member_storage()), 5,
           'the owner sees one row per member, including members who uploaded nothing' );

select is( (select s.occupying_bytes from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c1'), 100::bigint,
           'only the received file counts: in-flight and failed bytes do not inflate c1' );
select is( (select s.occupying_files from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c1'), 1,
           'c1 occupies exactly one file' );
select is( (select s.contributed_bytes from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c1'), 100::bigint,
           'c1 is credited with contributing the file they uploaded' );

-- ---- THE DECISION, ASSERTED ----
-- If someone later changes the attribution rule -- splits the bytes, moves
-- them to the most recent claimer, or counts a claim as occupancy -- these
-- four assertions fail. That is their entire purpose.
select is( (select s.occupying_bytes from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c2'), 0::bigint,
           'a deduped upload occupies ZERO bytes for the second member' );
select is( (select s.occupying_files from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c2'), 0,
           'the second member occupies no files -- no object was created for them' );
select is( (select s.contributed_bytes from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c2'), 100::bigint,
           'but the second member IS credited with contributing those bytes' );
select is( (select s.contributed_files from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c2'), 1,
           'the second member contributed one file' );

select is( (select sum(s.occupying_bytes)::bigint from public.member_storage() s), 100::bigint,
           'occupancy across the pool equals the bytes actually in the bucket' );
select is( (select sum(s.contributed_bytes)::bigint from public.member_storage() s), 200::bigint,
           'contribution across the pool deliberately exceeds it -- both members get credit' );

select is( (select count(*)::int from public.member_storage() s
             where s.member_id = '00000000-0000-0000-0000-0000000000c3'
               and s.occupying_bytes = 0 and s.contributed_bytes = 0), 1,
           'a member who uploaded nothing still appears, with zeros' );

-- ---- as a PLAIN MEMBER: sees only themselves ----
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';
select is( (select count(*)::int from public.member_storage()), 1,
           'a plain member sees exactly one row' );
select is( (select s.member_id from public.member_storage() s),
           '00000000-0000-0000-0000-0000000000c1'::uuid,
           'and it is their own' );
select is( (select s.occupying_bytes from public.my_storage() s), 100::bigint,
           'my_storage agrees with member_storage for the uploader' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2"}';
select is( (select s.occupying_bytes from public.my_storage() s), 0::bigint,
           'my_storage reports zero occupancy for the deduping member' );
select is( (select s.contributed_bytes from public.my_storage() s), 100::bigint,
           'my_storage reports their contribution' );

-- ---- an expired member gets nothing, not even zeros ----
-- 4-arg throws_ok(sql, errcode, errmsg, description). The 3-arg form binds
-- argument 3 as the expected MESSAGE and asserts nothing about the code.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c9"}';
select throws_ok( $$ select * from public.member_storage() $$, '42501', null,
                  'an expired member cannot read storage numbers at all' );

select * from finish();
rollback;
