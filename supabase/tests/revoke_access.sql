begin;
select plan(7);

-- allowlist must exist BEFORE the auth.users insert below: handle_new_user()
-- fires as an AFTER ROW trigger and raises 'not allowlisted' otherwise (see
-- allowlist_gate.sql / admin_authz.sql for the same ordering requirement).
insert into public.allowlist (email) values ('owner@gmail.com'), ('revokeme@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner@gmail.com'),
  ('00000000-0000-0000-0000-0000000000e2', 'revokeme@gmail.com');
-- The trigger above already provisioned both members rows (default role
-- 'member'); promote the owner instead of re-inserting (would violate the
-- user_id primary key -- see rls_reachable.sql's identical note).
update public.members set role = 'owner'
 where user_id = '00000000-0000-0000-0000-0000000000e1';

select ok(
  (select access_expires_at from public.members
    where user_id = '00000000-0000-0000-0000-0000000000e2') > now(),
  'seeded member starts with an active access_expires_at (initial_grant_days default)'
);

-- As the OWNER
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select public.admin_revoke('revokeme@gmail.com');

select ok(
  (select access_expires_at from public.members
    where user_id = '00000000-0000-0000-0000-0000000000e2') <= now(),
  '[Finding 1] admin_revoke actually ends access: members.access_expires_at is no longer in the future'
);

-- allowlist has zero base grant to `authenticated` (deliberately invisible
-- to clients — see rls_reachable.sql), so reset role before reading it
-- directly; admin_revoke() itself still wrote it fine as security definer.
reset role;

select ok(
  (select revoked_at from public.allowlist where email = 'revokeme@gmail.com') is not null,
  'admin_revoke still marks allowlist.revoked_at'
);

-- The hole this closes: hook_before_user_created only consults
-- allowlist.revoked_at (never members), so a fresh signup attempt for the
-- revoked email must still be rejected after admin_revoke ran.
select is(
  public.hook_before_user_created(
    '{"user":{"email":"revokeme@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb)
    ->'error'->>'http_code', '403',
  'a fresh signup attempt for the revoked email is still rejected by the hook after admin_revoke');

-- Re-invite the revoked member. As the OWNER again.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';

select public.admin_invite('revokeme@gmail.com');

select ok(
  (select access_expires_at from public.members
    where user_id = '00000000-0000-0000-0000-0000000000e2') > now(),
  'admin_invite on a revoked member restores access: access_expires_at is back in the future'
);

reset role;

select ok(
  (select revoked_at from public.allowlist where email = 'revokeme@gmail.com') is null,
  'admin_invite clears allowlist.revoked_at'
);

-- As the (still non-owner) restored member.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e2"}';

-- 4-arg form, errmsg=null: throws_ok(sql, errcode, errmsg, description). See
-- admin_authz.sql for why the 3-arg call is wrong here.
select throws_ok( $$ select public.admin_revoke('owner@gmail.com') $$, '42501', null,
                  'a non-owner calling admin_revoke is refused in the database' );

select * from finish();
rollback;
