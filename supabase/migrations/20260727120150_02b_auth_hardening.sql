-- Hardening pass on the allowlist auth gate (review findings on Task 4).
--
-- [Important-1] allowlist.email had no normalisation CHECK, so a dotted
-- Gmail invite (r.o.h.a.n@gmail.com) is a dead invite: the incoming address
-- folds to rohan@gmail.com before lookup and never matches the stored form.
--
-- [Minor-1/2] normalize_email and handle_new_user were left at the default
-- PUBLIC grant -- both anonymously callable over PostgREST. normalize_email
-- is re-granted to supabase_auth_admin because the hook runs as that role
-- (security invoker) and calls it; a bare revoke would break every signup.
--
-- [Minor-3] normalize_email('') returned '@' instead of null: an empty
-- string has zero '@' characters, string_to_array('','@') is '{}', and
-- array_length('{}',1) is NULL, so `<> 2` was NULL and never fired. The
-- empty-local/empty-domain guard also only ran inside the Gmail branch, so
-- non-Gmail malformed input ('@foo.com', 'foo@') fell through untouched.
-- Redefined to mirror src/lib/email.ts's normalizeEmail() literally: same
-- trim/lower, same @-count check, same empty-part check for every domain,
-- same Gmail folding, no extra canonicalisation (no trailing-dot stripping).
--
-- [Minor-4] `create trigger` is not idempotent; switched to
-- `create or replace trigger` (supported PG14+, this project is on 17).
--
-- [Minor-5] search_path = '' added to normalize_email and
-- hook_before_user_created per the function_search_path_mutable advisor.
-- Both are security invoker so it isn't strictly required, but every
-- reference inside them was already schema-qualified (public.*), so this is
-- a no-op for behaviour.

create or replace function public.normalize_email(p_raw text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v        text := lower(trim(p_raw));
  v_local  text;
  v_domain text;
begin
  -- null, '', or anything without exactly one '@' -> null. `is distinct
  -- from` catches the NULL that array_length produces for '' (empty array
  -- has a NULL length dimension, and `NULL <> 2` is NULL, not true).
  if v is null or array_length(string_to_array(v, '@'), 1) is distinct from 2 then
    return null;
  end if;

  v_local  := split_part(v, '@', 1);
  v_domain := split_part(v, '@', 2);

  -- Empty local or domain part is invalid for every domain, not just Gmail.
  if v_local = '' or v_domain = '' then
    return null;
  end if;

  if v_domain in ('gmail.com', 'googlemail.com') then
    v_local  := replace(split_part(v_local, '+', 1), '.', '');
    v_domain := 'gmail.com';
    if v_local = '' then
      return null;
    end if;
  end if;

  return v_local || '@' || v_domain;
end $$;

revoke execute on function public.normalize_email(text) from public, anon, authenticated;
grant  execute on function public.normalize_email(text) to supabase_auth_admin;
-- The allowlist_email_normalised CHECK below calls normalize_email() too,
-- and a CHECK constraint runs under the WRITING role's own privileges (it
-- is security invoker, unlike a trigger). service_role is the role that
-- writes public.allowlist (see 20260727120050_01b_grants.sql), so it needs
-- EXECUTE here or every service_role insert/update on allowlist starts
-- throwing 42501 "permission denied for function normalize_email".
grant  execute on function public.normalize_email(text) to service_role;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_email    text := public.normalize_email(event->'user'->>'email');
  v_provider text := event->'user'->'app_metadata'->>'provider';
begin
  if v_provider is distinct from 'google' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Please sign in with Google.'));
  end if;
  if v_email is null then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'No usable email on that account.'));
  end if;
  if not exists (select 1 from public.allowlist a
                  where a.email = v_email and a.revoked_at is null) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'This email is not on the invite list.'));
  end if;
  return '{}'::jsonb;
end $$;
-- Grants on hook_before_user_created are unchanged (grant to
-- supabase_auth_admin / revoke from public,anon,authenticated already set
-- in 20260727120100_02_auth_hooks.sql); CREATE OR REPLACE preserves ACLs.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
-- No compensating grant needed: handle_new_user is fired only as a trigger
-- on auth.users, and trigger invocation does not require an EXECUTE grant.

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- [Important-1] Reject un-normalised allowlist rows outright, so an invite
-- can never be entered in a form the incoming address will never match.
-- normalize_email is immutable, so it's legal in a CHECK.
alter table public.allowlist
  add constraint allowlist_email_normalised
  check (email = public.normalize_email(email));
