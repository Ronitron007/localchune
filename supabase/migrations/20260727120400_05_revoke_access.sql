-- Whole-branch review, Finding 1 (CRITICAL): admin_revoke only set
-- allowlist.revoked_at. allowlist gates ACCOUNT CREATION only (see
-- hook_before_user_created) -- it is never consulted again after a user has
-- signed up. A member who already has a session keeps full access forever:
-- the session cookie stays valid and the refresh token keeps rotating. The
-- admin page relabels the row "revoked" while access is untouched.
--
-- The fix is public.members.access_expires_at, the field middleware.ts's
-- current_member() RPC actually reads on every request. Setting it to now()
-- is what ends access. Do NOT delete the auth.users row or its members row
-- -- the PRD requires a revoked member to keep their data (uploads stay
-- attributed to them); deleting auth.users would cascade members and
-- credit_grants.
--
-- Finding 5 (normalisation divergence) is fixed in the same migration since
-- it touches the same function file: JS String.prototype.trim() strips all
-- Unicode whitespace, but Postgres trim(text) strips only U+0020 (plain
-- space). btrim(text, text) with an explicit character set of space, tab,
-- newline, CR, form feed, vertical tab mirrors what src/lib/email.ts does.
-- Nothing else about normalize_email changes.

create or replace function public.normalize_email(p_raw text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v        text := lower(btrim(p_raw, E' \t\n\r\f\v'));
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
-- Grants unchanged: CREATE OR REPLACE preserves ACLs, and this signature is
-- identical to the one defined in 20260727120150_02b_auth_hardening.sql
-- (revoke from public/anon/authenticated, grant to supabase_auth_admin and
-- service_role).

-- admin_revoke now actually revokes. Guard, normalisation, and the
-- allowlist.revoked_at write are unchanged; the members update is new.
create or replace function public.admin_revoke(p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := public.normalize_email(p_email);
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.allowlist set revoked_at = now() where email = v_email;
  -- This is the actual access cut-off: middleware.ts's current_member() RPC
  -- reads access_expires_at fresh from Postgres on every request (no JWT
  -- claim caching involved), so the effect is immediate, not delayed until
  -- next token refresh.
  update public.members set access_expires_at = now() where email = v_email;
  return v_email;
end $$;

-- admin_invite: re-inviting a revoked member must restore access, not just
-- clear allowlist.revoked_at (which alone does nothing for someone who
-- already has a members row -- allowlist is only consulted at signup).
-- Guard, normalisation, and the existing on-conflict behaviour (clearing
-- revoked_at) are unchanged.
create or replace function public.admin_invite(p_email text, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_email text := public.normalize_email(p_email);
  v_days  int;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_email is null then raise exception 'invalid email' using errcode = '22023'; end if;

  insert into public.allowlist (email, note)
  values (v_email, p_note)
  on conflict (email) do update set revoked_at = null, note = coalesce(excluded.note, allowlist.note)
  returning initial_grant_days into v_days;

  -- Only a member who already has a members row is affected: a brand-new
  -- invite has no members row yet (handle_new_user() provisions it and
  -- grants initial_grant_days on first signup), so this UPDATE matches zero
  -- rows and is a no-op for that case. greatest(...) means re-inviting an
  -- already-active member never shortens their remaining access.
  update public.members
     set access_expires_at = greatest(access_expires_at, now() + make_interval(days => v_days))
   where email = v_email;

  return v_email;
end $$;
-- Grants on admin_invite/admin_revoke unchanged: CREATE OR REPLACE preserves
-- ACLs, and both signatures are identical to 20260727120200_03_admin_rpc.sql
-- (revoke from public/anon, grant to authenticated -- the is_owner() check
-- inside the function is the real gate).
