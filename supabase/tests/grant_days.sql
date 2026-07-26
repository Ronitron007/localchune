begin;
select plan(4);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001','a@b.com');
insert into public.members (user_id, email) values ('00000000-0000-0000-0000-000000000001','a@b.com');

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
