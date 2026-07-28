begin;
select plan(18);

insert into public.allowlist (email) values ('yes@gmail.com');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"yes@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb),
  '{}'::jsonb, 'allowlisted google account passes');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"y.e.s+dj@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb),
  '{}'::jsonb, 'gmail dots and plus-tag still match the allowlist');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"no@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb)
    ->'error'->>'http_code', '403', 'non-allowlisted account is rejected');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"yes@gmail.com","app_metadata":{"provider":"github"}}}'::jsonb)
    ->'error'->>'http_code', '403', 'non-google provider is rejected');

update public.allowlist set revoked_at = now() where email = 'yes@gmail.com';
select is(
  public.hook_before_user_created(
    '{"user":{"email":"yes@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb)
    ->'error'->>'http_code', '403', 'revoked account is rejected');

-- Trigger path. hook_before_user_created only runs when GoTrue calls it over
-- the wire during a real signup -- it is not a DB trigger and calling it
-- directly (above) never touches auth.users or the provisioning trigger.
-- grant_days is execute-granted to service_role only; supabase_auth_admin
-- has none. handle_new_user works only because it is a SECURITY DEFINER
-- function owned by postgres. A test that only calls the hook would pass
-- even if that trigger, or its grant chain, were broken. So exercise the
-- real path: an actual insert into auth.users.

insert into public.allowlist (email) values ('trigger@gmail.com');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'trigger@gmail.com');

select is(
  (select count(*)::int from public.members
    where user_id = '00000000-0000-0000-0000-0000000000a1'),
  1, 'allowlisted signup provisions exactly one members row');

select ok(
  (select access_expires_at from public.members
    where user_id = '00000000-0000-0000-0000-0000000000a1')
    between now() + interval '29 days' and now() + interval '31 days',
  'new member''s access_expires_at is ~30 days out (initial_grant_days default)');

select is(
  (select count(*)::int from public.credit_grants
    where user_id = '00000000-0000-0000-0000-0000000000a1' and reason = 'invite'),
  1, 'exactly one invite credit_grants row for the new member');

-- auth.users.id is a primary key, so a genuine second signup attempt for the
-- same id is rejected before the trigger ever re-fires. throws_ok runs this
-- in a subtransaction so the failed insert does not abort the whole test.
select throws_ok(
  $$ insert into auth.users (id, email) values
      ('00000000-0000-0000-0000-0000000000a1', 'trigger@gmail.com') $$,
  '23505', null,
  'a second insert of the same user id is rejected');

select is(
  (select count(*)::int from public.credit_grants
    where user_id = '00000000-0000-0000-0000-0000000000a1'),
  1, 'the rejected duplicate insert did not create a second grant (idempotent through grant_days)');

-- [Important-1] allowlist.email must already be normalised. Without this
-- CHECK, inserting the dotted form creates a dead invite: the incoming
-- address folds to rohan@gmail.com before lookup and never matches the
-- stored dotted row, and a plain rohan@gmail.com doesn't match it either.
select throws_ok(
  $$ insert into public.allowlist (email) values ('r.o.h.a.n@gmail.com') $$,
  '23514', null,
  'un-normalised allowlist email violates the CHECK constraint');

select lives_ok(
  $$ insert into public.allowlist (email) values ('rohan@gmail.com') $$,
  'normalised allowlist email is accepted');

-- [Minor-3] normalize_email(): null/''/wrong @-count, and an empty local or
-- domain part for ANY domain (not just Gmail), must all return null.
select is( public.normalize_email(''), null, 'empty string normalises to null' );
select is( public.normalize_email('@foo.com'), null, 'empty local part normalises to null (non-Gmail)' );
select is( public.normalize_email('foo@'), null, 'empty domain part normalises to null (non-Gmail)' );
select is( public.normalize_email(null), null, 'null input normalises to null' );

-- Regression guard: Gmail dot/plus folding must be unchanged by the rewrite.
select is( public.normalize_email('r.o.h.a.n+dj@googlemail.com'), 'rohan@gmail.com',
  'gmail dot/plus folding still works after the null-handling rewrite' );

-- [Finding 5] JS String.prototype.trim() strips all Unicode whitespace, but
-- Postgres trim(text) strips only U+0020. normalize_email now uses
-- btrim(p_raw, E' \t\n\r\f\v') so a leading tab folds the same way
-- src/lib/email.ts's normalizeEmail() already does.
select is( public.normalize_email(E'\tdj@gmail.com'), 'dj@gmail.com',
  'a leading tab is stripped, matching JS trim() semantics' );

select * from finish();
rollback;
