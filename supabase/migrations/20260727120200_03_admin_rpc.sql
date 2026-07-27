create or replace function public.admin_members()
returns table (
  email             text,
  role              text,
  access_expires_at timestamptz,
  credits           int,
  invited_at        timestamptz,
  revoked_at        timestamptz,
  signed_up         boolean
)
language sql security definer set search_path = '' as $$
  select a.email,
         coalesce(m.role, 'member'),
         m.access_expires_at,
         greatest(0, ceil(extract(epoch from (m.access_expires_at - now())) / 86400.0))::int,
         a.invited_at,
         a.revoked_at,
         m.user_id is not null
    from public.allowlist a
    left join public.members m on m.email = a.email
   where public.is_owner()
   order by a.invited_at desc;
$$;

revoke execute on function public.admin_members() from public, anon;
grant  execute on function public.admin_members() to authenticated;

-- Mutations as definer functions, per the global constraint. The owner check
-- lives HERE, in the database, not only in the Worker route — so a routing
-- mistake cannot expose it.
create or replace function public.admin_invite(p_email text, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := public.normalize_email(p_email);
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_email is null then raise exception 'invalid email' using errcode = '22023'; end if;
  insert into public.allowlist (email, note)
  values (v_email, p_note)
  on conflict (email) do update set revoked_at = null, note = coalesce(excluded.note, allowlist.note);
  return v_email;
end $$;

create or replace function public.admin_revoke(p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := public.normalize_email(p_email);
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.allowlist set revoked_at = now() where email = v_email;
  return v_email;
end $$;

revoke execute on function public.admin_invite(text,text), public.admin_revoke(text) from public, anon;
grant  execute on function public.admin_invite(text,text), public.admin_revoke(text) to authenticated;
