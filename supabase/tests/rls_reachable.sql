begin;
select plan(9);

insert into public.allowlist (email) values ('m1@gmail.com'), ('m2@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1','m1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2','m2@gmail.com');
-- Task 4's on_auth_user_created trigger provisions both members rows as a
-- side effect of the inserts above; a manual insert here would now conflict
-- on the user_id primary key.

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

-- If the base GRANT is missing these raise 42501 "permission denied for
-- table", NOT an empty result. lives_ok distinguishes the two.
select lives_ok( $$ select 1 from public.members limit 1 $$,
                 'authenticated can reach members at all (base grant present)' );
select is( (select count(*)::int from public.members), 1,
           'members RLS returns exactly the caller''s own row' );
select lives_ok( $$ select 1 from public.credit_grants limit 1 $$,
                 'authenticated can reach credit_grants' );

-- allowlist stays invisible: it has NO base grant to authenticated at all
-- (not merely an empty policy), so the ACL check itself denies the query
-- before RLS ever runs -- 42501, not a 0-row result. throws_ok, not is(),
-- for the same reason lives_ok is used above: the failure mode is an error.
select throws_ok( $$ select 1 from public.allowlist limit 1 $$, '42501', NULL,
                  'allowlist is invisible to authenticated (no base grant)' );

-- [F3] Migration 10 closed hosted Supabase's default open ACL on these
-- three tables (migration 09 already covered audio_analysis/fingerprints).
-- Locally the default privileges never granted INSERT to authenticated in
-- the first place, so these pass with or without migration 10 -- the value
-- is as a regression guard: if a future migration ever adds
-- `grant insert ... to authenticated` here by mistake, this is what catches
-- it, exactly as analysis.sql already does for audio_analysis.
select throws_ok(
  $$ insert into public.members (user_id, email) values
     (gen_random_uuid(), 'nope@gmail.com') $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into members -- the authorization table' );
select throws_ok(
  $$ insert into public.allowlist (email) values ('nope@gmail.com') $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into allowlist -- the signup gate' );
select throws_ok(
  $$ insert into public.credit_grants (user_id, days, reason, dedupe_key)
     values ('00000000-0000-0000-0000-0000000000c1', 1, 'manual', 'x') $$,
  '42501', NULL,
  '[F3] authenticated cannot insert into credit_grants' );

reset role;
set local role service_role;
select lives_ok( $$ insert into public.allowlist (email) values ('svc@gmail.com') $$,
                 'service_role can write allowlist (BYPASSRLS does not grant ACL)' );
select lives_ok( $$ update public.members set role = 'member'
                     where user_id = '00000000-0000-0000-0000-0000000000c1' $$,
                 'service_role can update members' );

select * from finish();
rollback;
