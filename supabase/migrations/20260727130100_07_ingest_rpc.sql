-- supabase/migrations/20260727130100_07_ingest_rpc.sql

-- ------------------------------------------------------------
-- The only place files.state is ever written.
--
-- Not granted to ANY role. It is reached solely from the definer functions
-- below, which run as their owner (postgres), so the EXECUTE check passes
-- for them and for nobody else. That is what makes the transition table
-- below the complete list of legal moves.
-- ------------------------------------------------------------
create or replace function public.ingest_set_state(
  p_file_id uuid, p_from text[], p_to text
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  update public.files f
     set state = p_to, state_changed_at = now()
   where f.id = p_file_id and f.state = any (p_from)
  returning f.state into v_state;

  if v_state is not null then
    return v_state;
  end if;

  select f.state into v_state from public.files f where f.id = p_file_id;
  if v_state is null then
    raise exception 'unknown file %', p_file_id using errcode = 'P0002';
  end if;
  raise exception 'illegal transition % -> %', v_state, p_to using errcode = 'P0001';
end $$;
revoke execute on function public.ingest_set_state(uuid, text[], text)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
create or replace function public.upload_batch_create(p_label text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.upload_batches (created_by, label)
  values (auth.uid(), p_label)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.upload_batch_create(text) from public, anon;
grant  execute on function public.upload_batch_create(text) to authenticated;

-- ------------------------------------------------------------
-- Creates the files + ingest_jobs pair and mints the object key.
--
-- THE SERVER MINTS THE KEY. p_file_id is a client-generated idempotency
-- token, not a path: the key is 'audio/<auth.uid()>/<file_id>.<container>',
-- so a client that reuses another member's file_id produces a DIFFERENT key
-- and hits the primary-key conflict below instead of overwriting anything.
-- Every character in that key is uuid hex, '-', '/' or a lowercase
-- extension, so the S3 request path needs no percent-encoding.
--
-- Fully idempotent: a replay returns the existing key and state rather than
-- erroring, which is what lets the browser retry a whole batch blind.
-- ------------------------------------------------------------
create or replace function public.ingest_begin(
  p_batch_id           uuid,
  p_file_id            uuid,
  p_filename           text,
  p_container          text,
  p_byte_size          bigint,
  p_client_duration_ms int,
  p_multipart          boolean,
  p_part_size          int,
  p_part_count         int
) returns table (r2_key text, state text, resumable boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_key   text;
  v_owner uuid;
  v_state text;
  v_have  text;
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_container not in ('mp3','flac','wav','aiff','m4a','ogg','opus') then
    raise exception 'unsupported container %', p_container using errcode = '22023';
  end if;
  if p_byte_size is null or p_byte_size <= 0 then
    raise exception 'empty file' using errcode = '22023';
  end if;
  if not exists (select 1 from public.upload_batches b
                  where b.id = p_batch_id and b.created_by = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select f.uploaded_by, f.state, f.r2_key
    into v_owner, v_state, v_have
    from public.files f
   where f.id = p_file_id;

  if v_owner is not null then
    -- Same error for "not yours" as for "no batch": do not build an oracle
    -- that confirms another member's file ids exist.
    if v_owner <> v_uid then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    return query select v_have, v_state, (v_state in ('pending','uploading'));
    return;
  end if;

  v_key := 'audio/' || v_uid::text || '/' || p_file_id::text || '.' || p_container;

  insert into public.files
    (id, batch_id, uploaded_by, r2_key, original_filename, byte_size, container, state)
  values
    (p_file_id, p_batch_id, v_uid, v_key, p_filename, p_byte_size, p_container, 'pending');

  insert into public.ingest_jobs
    (file_id, batch_id, user_id, declared_byte_size, client_duration_ms,
     multipart, part_size, part_count)
  values
    (p_file_id, p_batch_id, v_uid, p_byte_size, p_client_duration_ms,
     p_multipart, p_part_size, p_part_count);

  return query select v_key, 'pending'::text, true;
end $$;
revoke execute on function public.ingest_begin(uuid,uuid,text,text,bigint,int,boolean,int,int)
  from public, anon;
grant  execute on function public.ingest_begin(uuid,uuid,text,text,bigint,int,boolean,int,int)
  to authenticated;

-- ------------------------------------------------------------
create or replace function public.ingest_mark_uploading(
  p_file_id uuid, p_upload_id text default null
) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f
                  where f.id = p_file_id and f.uploaded_by = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- coalesce, never overwrite: a re-presign of parts 50-99 must not blank
  -- the UploadId the sweeper needs to abort this upload.
  update public.ingest_jobs j
     set upload_id = coalesce(p_upload_id, j.upload_id), updated_at = now()
   where j.file_id = p_file_id;

  return public.ingest_set_state(p_file_id, array['pending','uploading'], 'uploading');
end $$;
revoke execute on function public.ingest_mark_uploading(uuid, text) from public, anon;
grant  execute on function public.ingest_mark_uploading(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- Called only after the route has verified the object's real size with a
-- HEAD against R2. p_verified_byte_size is that number, not the client's.
-- ------------------------------------------------------------
create or replace function public.ingest_finalize(
  p_file_id uuid, p_verified_byte_size bigint
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f
                  where f.id = p_file_id and f.uploaded_by = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_verified_byte_size is null or p_verified_byte_size <= 0 then
    raise exception 'empty object' using errcode = '22023';
  end if;

  update public.files f
     set byte_size = p_verified_byte_size
   where f.id = p_file_id;

  -- 'received' is accepted as a source state so a retried complete is a
  -- no-op rather than an error.
  v_state := public.ingest_set_state(p_file_id, array['uploading','received'], 'received');

  -- The uploader always claims their own file. M4 adds a SECOND claim row
  -- when another member's bytes dedupe onto this file; it only ever inserts.
  insert into public.file_claims (file_id, user_id, batch_id)
  select f.id, f.uploaded_by, f.batch_id from public.files f where f.id = p_file_id
  on conflict (file_id, user_id) do nothing;

  update public.ingest_jobs j
     set last_error = null, updated_at = now()
   where j.file_id = p_file_id;

  return v_state;
end $$;
revoke execute on function public.ingest_finalize(uuid, bigint) from public, anon;
grant  execute on function public.ingest_finalize(uuid, bigint) to authenticated;

-- ------------------------------------------------------------
create or replace function public.ingest_fail(p_file_id uuid, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f
                  where f.id = p_file_id and f.uploaded_by = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.ingest_jobs j
     set last_error = left(p_reason, 500),
         attempts   = j.attempts + 1,
         updated_at = now()
   where j.file_id = p_file_id;

  return public.ingest_set_state(
    p_file_id, array['pending','uploading','failed'], 'failed');
end $$;
revoke execute on function public.ingest_fail(uuid, text) from public, anon;
grant  execute on function public.ingest_fail(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- The sweeper. Called by the maintenance Worker (Task 8) with the
-- service_role key, because there is no user session at 04:00.
--
-- Returns what the caller must abort in R2. It deliberately does NOT delete
-- the files row: PRD 10's nightly reconcile needs a record of what the key
-- was in order to recognise a leftover object as an orphan rather than an
-- unknown.
-- ------------------------------------------------------------
create or replace function public.ingest_abandon_stale(
  p_older_than interval default interval '24 hours'
) returns table (file_id uuid, r2_key text, upload_id text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with stale as (
    select f.id
      from public.files f
     where f.state in ('pending','uploading')
       and f.state_changed_at < now() - p_older_than
     limit 500
  ), upd as (
    update public.files f
       set state = 'abandoned', state_changed_at = now()
     where f.id in (select s.id from stale s)
    returning f.id as id, f.r2_key as r2_key
  )
  select u.id, u.r2_key, j.upload_id
    from upd u
    join public.ingest_jobs j on j.file_id = u.id;
end $$;
revoke execute on function public.ingest_abandon_stale(interval)
  from public, anon, authenticated;
grant  execute on function public.ingest_abandon_stale(interval) to service_role;
