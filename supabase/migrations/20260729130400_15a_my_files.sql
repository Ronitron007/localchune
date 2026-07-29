-- supabase/migrations/20260729130400_15a_my_files.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- "What have I uploaded" -- the answer to the owner's verbatim complaint
-- that there is no way to see the status of a track once it is dropped, or
-- even a full list of what was ever dropped. upload_batch_status()
-- (migration 13) only ever knows about the batch the ticker is currently
-- polling and stops mattering the moment the tab closes; this is the
-- permanent, whole-history record for one uploader.
--
-- SECURITY DEFINER, scoped to `f.uploaded_by = auth.uid()` IN THE BODY --
-- never trust a caller-supplied filter for "whose rows", same discipline as
-- upload_batch_status(). RLS on files already limits a non-owner to
-- pool-visible states, but this function's whole point is showing an
-- uploader their OWN failed/pending/quarantined rows too, so the visibility
-- rule here is intentionally the auth.uid() predicate alone, not RLS.
--
-- Keyset pagination on (created_at, id), both descending. Only the
-- created_at half of the keyset is a parameter (p_before) -- there is no
-- p_before_id twin. A tie on created_at inside one page is exercised by
-- nothing in this product: rows are minted one HTTP round trip apart even
-- inside a bulk drop (each gets its own /api/upload/presign call), so two
-- files landing at the identical microsecond is not a real scenario the way
-- it is for pool_list()'s cross-member ordering. `id desc` is still the
-- documented tiebreak so the ORDER BY is deterministic either way.
-- ============================================================
create or replace function public.my_files(
  p_limit  int         default 200,
  p_before timestamptz default null
)
returns table (
  file_id           uuid,
  original_filename text,
  state             text,
  last_error        text,
  byte_size         bigint,
  created_at        timestamptz,
  batch_id          uuid,
  batch_label       text,
  bpm               real,
  key_camelot       text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if not public.is_active_member() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select f.id, f.original_filename, f.state, j.last_error, f.byte_size,
         f.created_at, f.batch_id, ub.label,
         a.bpm, a.key_camelot
    from public.files f
    left join public.ingest_jobs    j  on j.file_id  = f.id
    left join public.upload_batches ub on ub.id      = f.batch_id
    left join public.audio_analysis a  on a.file_id  = f.id
   where f.uploaded_by = (select auth.uid())
     and (p_before is null or f.created_at < p_before)
   order by f.created_at desc, f.id desc
   limit v_limit;
end $$;

-- Supports the keyset predicate and ORDER BY above without a sort. files
-- already carries files_uploader_idx (uploaded_by alone) and
-- files_created_idx (created_at desc alone) from migration 06; neither
-- serves "my rows, newest first" without an extra sort step once one
-- uploader has more than a page of history.
create index if not exists files_uploader_created_idx
  on public.files (uploaded_by, created_at desc, id desc);

revoke execute on function public.my_files(int, timestamptz) from public, anon;
grant  execute on function public.my_files(int, timestamptz) to authenticated;

comment on function public.my_files(int, timestamptz) is
  'One uploader''s whole history: every file they ever dropped, in every
   state, newest first. last_error comes through verbatim from
   ingest_jobs so a failure like "empty_decode" is visible instead of
   silent. bpm/key_camelot are null until audio_analysis exists for the
   file. Keyset-paginated on (created_at, id) via p_before.';
