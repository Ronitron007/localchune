-- Chicken-and-egg: the first owner cannot be invited through the UI. Seed
-- the allowlist and promote the owner's members row to role='owner'.
--
-- The AFTER INSERT trigger below only fires when a NEW members row is
-- created, so it bootstraps a fresh database (or a `db reset`) correctly.
-- But on the hosted project the owner already signed in before this
-- migration existed: auth.users already has their row and
-- public.members already has them at the default role='member'. The
-- trigger will never fire for that existing row. So this migration also
-- runs a one-time UPDATE to fix it. The UPDATE's WHERE clause makes it
-- idempotent -- safe to re-run on every future `db push`.
--
-- The literal is always routed through normalize_email() rather than
-- hardcoded in its folded form, so this stays correct if that function's
-- normalisation rules ever change.

insert into public.allowlist (email, note, initial_grant_days)
values (public.normalize_email('rohan.maliko99@gmail.com'), 'owner', 3650)
on conflict (email) do nothing;

create or replace function public.promote_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email = public.normalize_email('rohan.maliko99@gmail.com') then
    update public.members set role = 'owner' where user_id = new.user_id;
  end if;
  return new;
end $$;

-- `create or replace trigger` (PG14+, this project is on 17) so re-running
-- this migration is idempotent, matching the pattern already established in
-- 20260727120150_02b_auth_hardening.sql for on_auth_user_created.
create or replace trigger members_promote_owner
  after insert on public.members
  for each row execute function public.promote_owner();

-- Trigger invocation does not require an EXECUTE grant (same reasoning as
-- handle_new_user in 20260727120150_02b_auth_hardening.sql), so lock the
-- function down from direct calls over PostgREST.
revoke execute on function public.promote_owner() from public, anon, authenticated;

-- Fix-up for the owner's already-existing row on the hosted project. No-op
-- on a fresh database, since no members row exists yet at this point in the
-- migration chain.
update public.members
   set role = 'owner'
 where email = public.normalize_email('rohan.maliko99@gmail.com')
   and role <> 'owner';
