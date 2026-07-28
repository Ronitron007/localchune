create or replace function public.normalize_email(p_raw text)
returns text language plpgsql immutable as $$
declare v text := lower(trim(p_raw)); v_local text; v_domain text;
begin
  if v is null or array_length(string_to_array(v,'@'),1) <> 2 then return null; end if;
  v_local  := split_part(v,'@',1);
  v_domain := split_part(v,'@',2);
  if v_domain in ('gmail.com','googlemail.com') then
    v_local  := replace(split_part(v_local,'+',1), '.', '');
    v_domain := 'gmail.com';
    if v_local = '' then return null; end if;
  end if;
  return v_local || '@' || v_domain;
end $$;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql as $$
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

grant  execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;

-- Provision on first successful signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_days int; v_email text := public.normalize_email(new.email);
begin
  select a.initial_grant_days into v_days
    from public.allowlist a
   where a.email = v_email and a.revoked_at is null;
  if v_days is null then
    raise exception 'not allowlisted';   -- belt; the hook already rejected this
  end if;

  insert into public.members(user_id, email, access_expires_at)
  values (new.id, v_email, now())
  on conflict (user_id) do nothing;

  perform public.grant_days(new.id, v_days, 'invite', 'invite');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
