begin;
select plan(4);

insert into public.allowlist (email) values ('us1@gmail.com'), ('us2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1','us1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2','us2@gmail.com');
update public.members set access_expires_at = now() + interval '30 days'
 where user_id in ('00000000-0000-0000-0000-0000000000c1',
                   '00000000-0000-0000-0000-0000000000c2');

insert into public.upload_batches (id, created_by) values
  ('00000000-0000-0000-0000-0000000000bc','00000000-0000-0000-0000-0000000000c1');

insert into public.files
  (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
values
  ('00000000-0000-0000-0000-0000000000e5','00000000-0000-0000-0000-0000000000bc',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/00000000-0000-0000-0000-0000000000c1/00000000-0000-0000-0000-0000000000e5.flac',
   'moving.flac', 100, 'flac', 'analysing'),
  ('00000000-0000-0000-0000-0000000000e6','00000000-0000-0000-0000-0000000000bc',
   '00000000-0000-0000-0000-0000000000c1',
   'audio/00000000-0000-0000-0000-0000000000c1/00000000-0000-0000-0000-0000000000e6.mp3',
   'dead.mp3', 100, 'mp3', 'failed');

insert into public.ingest_jobs (file_id, batch_id, user_id, declared_byte_size, multipart, last_error)
values ('00000000-0000-0000-0000-0000000000e6','00000000-0000-0000-0000-0000000000bc',
        '00000000-0000-0000-0000-0000000000c1', 100, false, 'object missing at finalize');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

select is( (select count(*)::int from public.upload_batch_status(
              '00000000-0000-0000-0000-0000000000bc')), 2,
           'the uploader sees both of their own rows in the batch' );
select is( (select s.terminal from public.upload_batch_status(
              '00000000-0000-0000-0000-0000000000bc') s
             where s.state = 'analysing'), false,
           'analysing is not terminal -- the ticker keeps polling' );
select is( (select s.reason from public.upload_batch_status(
              '00000000-0000-0000-0000-0000000000bc') s
             where s.state = 'failed'), 'object missing at finalize',
           'the recorded reason comes back with the failed row' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2"}';
select is( (select count(*)::int from public.upload_batch_status(
              '00000000-0000-0000-0000-0000000000bc')), 0,
           'another member gets nothing, even with the batch id in hand' );

select * from finish();
rollback;
