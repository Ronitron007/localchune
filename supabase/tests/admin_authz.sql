begin;
select plan(6);

-- allowlist must exist BEFORE the auth.users insert below: handle_new_user()
-- fires as an AFTER ROW trigger at the end of that insert statement and
-- raises 'not allowlisted' if the email isn't there yet (see
-- supabase/tests/allowlist_gate.sql and rls_reachable.sql for the same
-- ordering). The brief's original ordering had auth.users first, which
-- aborts the whole transaction with that exception before any assertion
-- below ever runs.
insert into public.allowlist (email) values ('owner@gmail.com'), ('member@gmail.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa','owner@gmail.com'),
  ('00000000-0000-0000-0000-0000000000bb','member@gmail.com');
-- The trigger above already provisioned both members rows (default role
-- 'member'); promote the owner instead of re-inserting (would violate the
-- user_id primary key -- see rls_reachable.sql's identical note).
update public.members set role = 'owner'
 where user_id = '00000000-0000-0000-0000-0000000000aa';

-- As the OWNER
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa"}';

select ok( public.is_owner(), 'owner is recognised' );

-- The regression test for 42P17: with two members present, an owner selecting
-- from members must return both rows and MUST NOT recurse.
select is( (select count(*)::int from public.members), 2,
           'owner reads all members without infinite recursion' );

select is( (select count(*)::int from public.current_member()), 1,
           'current_member returns exactly one row even for an owner' );

select is( public.admin_invite('New.Person+tag@gmail.com'), 'newperson@gmail.com',
           'admin_invite normalises and returns the email' );

-- As a plain MEMBER
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000bb"}';

select ok( not public.is_owner(), 'plain member is not an owner' );

-- 4-arg form, errmsg=null: throws_ok(sql, errcode, errmsg, description). The
-- brief's original 3-arg call resolves to (sql, errcode, errmsg) instead --
-- pgTAP treats a 5-byte 2nd arg as errcode and then binds the 3rd arg as the
-- expected error MESSAGE, not a description, so it wanted a raised message
-- of 'a non-owner calling admin_invite is refused in the database' and got
-- 'forbidden' instead. See supabase/tests/allowlist_gate.sql for the same
-- 4-arg pattern.
select throws_ok( $$ select public.admin_invite('sneaky@gmail.com') $$, '42501', null,
                  'a non-owner calling admin_invite is refused in the database' );

select * from finish();
rollback;
