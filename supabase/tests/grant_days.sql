begin;
select plan(4);

insert into public.allowlist (email) values ('a@b.com');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001','a@b.com');
-- Task 4's on_auth_user_created trigger already provisioned this member and
-- granted an 'invite' credit as a side effect of the insert above. Reset
-- both so this file keeps testing grant_days() in isolation, exactly as
-- before that trigger existed.
delete from public.credit_grants where user_id = '00000000-0000-0000-0000-000000000001';
update public.members set access_expires_at = now()
 where user_id = '00000000-0000-0000-0000-000000000001';

select ok(
  public.grant_days('00000000-0000-0000-0000-000000000001', 30, 'invite', 'invite')
    > now() + interval '29 days',
  'first grant extends by 30 days');

select ok(
  public.grant_days('00000000-0000-0000-0000-000000000001', 30, 'invite', 'invite')
    < now() + interval '31 days',
  'replayed grant with the same dedupe_key is a no-op');

select is( (select count(*)::int from public.credit_grants), 1,
  'replayed grant inserted no second ledger row');

select ok(
  public.grant_days('00000000-0000-0000-0000-000000000001', 1, 'track_upload', 'track:abc')
    > now() + interval '30 days',
  'a different dedupe_key does extend');

select * from finish();
rollback;
