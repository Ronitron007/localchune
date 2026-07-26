create table public.allowlist (
  email              text primary key check (email = lower(email)),
  note               text,
  initial_grant_days int not null default 30 check (initial_grant_days > 0),
  invited_at         timestamptz not null default now(),
  revoked_at         timestamptz
);
alter table public.allowlist enable row level security;
-- Deliberately ZERO policies for anon/authenticated => invisible to clients.
-- service_role has BYPASSRLS, so admin paths still work.

-- Auth hooks run as supabase_auth_admin, which is NOT bypassrls:
grant usage on schema public to supabase_auth_admin;
grant select on public.allowlist to supabase_auth_admin;
create policy "auth admin reads allowlist"
  on public.allowlist for select to supabase_auth_admin using (true);

create table public.members (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  email             text not null unique,
  role              text not null default 'member' check (role in ('member','owner')),
  access_expires_at timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
alter table public.members enable row level security;
create index members_expires_idx on public.members (access_expires_at);

grant select on public.members to supabase_auth_admin;
create policy "auth admin reads members"
  on public.members for select to supabase_auth_admin using (true);

-- CRITICAL: an RLS policy ON members that SELECTs FROM members recurses
-- infinitely. Postgres raises 42P17 "infinite recursion detected in policy".
-- The escape is a SECURITY DEFINER function, which bypasses RLS on its own
-- reads. This is the single most common Supabase RLS footgun.
create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members
                  where user_id = auth.uid() and role = 'owner');
$$;
revoke execute on function public.is_owner() from public, anon;
grant  execute on function public.is_owner() to authenticated;

-- Exactly one row, always. The middleware calls this instead of selecting
-- from members, because with the owner policy below a plain select returns
-- EVERY member for an owner, and .maybeSingle() then errors on >1 row.
create or replace function public.current_member()
returns table (user_id uuid, email text, role text, access_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.email, m.role, m.access_expires_at
    from public.members m
   where m.user_id = auth.uid();
$$;
revoke execute on function public.current_member() from public, anon;
grant  execute on function public.current_member() to authenticated;

create policy "members read own row"
  on public.members for select to authenticated
  using ( user_id = (select auth.uid()) );

create policy "owner reads all members"
  on public.members for select to authenticated
  using ( (select public.is_owner()) );

-- Append-only grant ledger. Idempotency is the UNIQUE constraint, not careful code.
create table public.credit_grants (
  id         bigserial primary key,
  user_id    uuid not null references public.members(user_id) on delete cascade,
  days       int  not null check (days > 0),
  reason     text not null check (reason in ('invite','track_upload','quality_upgrade','manual')),
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
alter table public.credit_grants enable row level security;
create policy "members read own grants"
  on public.credit_grants for select to authenticated
  using ( user_id = (select auth.uid()) );

create or replace function public.grant_days(
  p_user uuid, p_days int, p_reason text, p_dedupe text
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_new timestamptz;
begin
  insert into public.credit_grants(user_id, days, reason, dedupe_key)
  values (p_user, p_days, p_reason, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;

  if not found then
    select access_expires_at into v_new from public.members where user_id = p_user;
    return v_new;
  end if;

  update public.members
     set access_expires_at = greatest(access_expires_at, now())
                             + make_interval(days => p_days)
   where user_id = p_user
  returning access_expires_at into v_new;
  return v_new;
end $$;

revoke execute on function public.grant_days(uuid,int,text,text) from public, anon, authenticated;
grant  execute on function public.grant_days(uuid,int,text,text) to service_role;
