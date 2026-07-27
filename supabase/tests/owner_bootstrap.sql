begin;
select plan(6);

-- 1. The bootstrap migration seeds the owner's (normalised) email into the
-- allowlist, active (not revoked).
select ok(
  exists (select 1 from public.allowlist
           where email = public.normalize_email('rohan.maliko99@gmail.com')
             and revoked_at is null),
  'owner email is present and active in the allowlist'
);

-- allowlist must exist BEFORE the auth.users insert below: handle_new_user()
-- fires as an AFTER ROW trigger on auth.users and raises 'not allowlisted'
-- if the email isn't there yet (see allowlist_gate.sql / admin_authz.sql for
-- the same ordering requirement). The owner's row is already seeded by the
-- migration; add one more allowlisted, non-owner email for comparison.
insert into public.allowlist (email) values ('other-member@gmail.com');

-- 2. Trigger path: on_auth_user_created provisions the members row (default
-- role='member'), then members_promote_owner fires AFTER INSERT on members
-- and flips it to 'owner' because the email matches.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1',
   public.normalize_email('rohan.maliko99@gmail.com'));

select is(
  (select role from public.members
    where user_id = '00000000-0000-0000-0000-0000000000d1'),
  'owner',
  'signing up as the owner email promotes the members row to owner'
);

-- 3. The trigger must not promote everyone -- only the owner's exact
-- (normalised) email. This is the assertion that matters most here.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d2', 'other-member@gmail.com');

select is(
  (select role from public.members
    where user_id = '00000000-0000-0000-0000-0000000000d2'),
  'member',
  'a different allowlisted signup is NOT promoted to owner'
);

-- 4. is_owner() reflects the promotion for the owner, and not for the member.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select ok( public.is_owner(), 'is_owner() is true for the promoted owner' );

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select ok( not public.is_owner(), 'is_owner() is false for a plain member' );

reset role;

-- 5. Idempotency: the migration's fix-up UPDATE (for an owner whose members
-- row already existed before this migration ran, as on the hosted project)
-- must be safe to re-run -- e.g. a second `db push`.
update public.members
   set role = 'owner'
 where email = public.normalize_email('rohan.maliko99@gmail.com')
   and role <> 'owner';

select is(
  (select role from public.members
    where user_id = '00000000-0000-0000-0000-0000000000d1'),
  'owner',
  're-running the owner fix-up UPDATE is idempotent (role stays owner, no error)'
);

select * from finish();
rollback;
