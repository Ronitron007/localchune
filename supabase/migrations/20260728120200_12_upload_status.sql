-- supabase/migrations/20260728120200_12_upload_status.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- What the uploader's own rows are doing right now.
--
-- An RPC rather than a PostgREST embed of files -> ingest_jobs, because the
-- embedded shape (object or array) depends on how PostgREST classifies the
-- relationship, and a client that guesses wrong fails at runtime with no
-- type error. One function, one shape, one round trip.
--
-- `terminal` is computed HERE so the browser's stop condition and the
-- database's idea of "finished" cannot drift. needs_review counts as
-- terminal ON PURPOSE: it waits for a human decision in M4, so polling it
-- forever would burn a request every five seconds for nothing.
-- ============================================================
create or replace function public.upload_batch_status(p_batch_id uuid)
returns table (
  file_id           uuid,
  original_filename text,
  byte_size         bigint,
  state             text,
  state_changed_at  timestamptz,
  reason            text,
  terminal          boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select f.id, f.original_filename, f.byte_size, f.state, f.state_changed_at,
         left(j.last_error, 500),
         f.state = any (array['stored','needs_review','rejected_duration',
                              'rejected_redundant','quarantined','failed','abandoned'])
    from public.files f
    left join public.ingest_jobs j on j.file_id = f.id
   -- Own rows only, whatever batch id is supplied. A batch belongs to one
   -- member, but relying on that would make a future shared batch a data
   -- leak instead of a feature.
   where f.batch_id = p_batch_id
     and f.uploaded_by = (select auth.uid())
   order by f.created_at, f.id;
end $$;

revoke execute on function public.upload_batch_status(uuid) from public, anon;
grant  execute on function public.upload_batch_status(uuid) to authenticated;
