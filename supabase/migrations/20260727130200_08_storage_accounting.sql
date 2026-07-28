-- supabase/migrations/20260727130200_08_storage_accounting.sql
--
-- Storage accounting. Two numbers, both stable, both explainable in a
-- tooltip, neither needing a counter cache.
--
--   occupying   -- bytes of MY files that are actually in the bucket.
--                  Attributed by files.uploaded_by, set once at
--                  ingest_begin and never moved. A member whose upload
--                  deduped onto someone else's file caused no object to
--                  exist and therefore occupies nothing.
--   contributed -- bytes I brought to the pool, from file_claims. Both the
--                  original uploader and every later deduping member are
--                  credited. Insert-only, so it never decreases.
--
-- sum(occupying) is the bucket. sum(contributed) is larger. That gap IS the
-- dedup saving, and it is the reason these are two columns and not one.

-- ------------------------------------------------------------
-- SECURITY DEFINER, because the aggregates must read rows the caller cannot
-- see: a member's own total includes files that RLS hides from them (a
-- quarantined file belonging to someone else is not in the caller's
-- occupancy anyway, but the JOIN still has to traverse the table). The
-- function returns only rows the caller is entitled to -- their own, or all
-- of them for the owner -- so no definer bypass leaks outward.
--
-- Output columns are member_id / member_email, NOT user_id / email. In a
-- plpgsql `returns table`, output columns are declared as variables; an
-- output named user_id would be ambiguous against members.user_id and
-- file_claims.user_id inside the body, and Postgres raises
-- 42702 "column reference is ambiguous" at RUNTIME, not at create time.
-- ------------------------------------------------------------
create or replace function public.member_storage()
returns table (
  member_id         uuid,
  member_email      text,
  occupying_bytes   bigint,
  occupying_files   int,
  contributed_bytes bigint,
  contributed_files int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- The owner keeps reading even if their own access window lapses; that is
  -- how M1's admin page already behaves. Everyone else must be live.
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select m.user_id,
         m.email,
         coalesce(occ.total_bytes, 0)::bigint,
         coalesce(occ.total_files, 0)::int,
         coalesce(con.total_bytes, 0)::bigint,
         coalesce(con.total_files, 0)::int
    from public.members m
    -- OCCUPYING: my files, in a state where the object is in the bucket.
    -- states_holding_bytes() is received/analysing/stored/needs_review.
    -- pending and uploading are bytes that may never arrive; failed,
    -- abandoned and rejected_* are bytes that arrived and were thrown away.
    -- Neither may inflate anyone's number.
    left join lateral (
      select sum(f.byte_size) as total_bytes, count(*) as total_files
        from public.files f
       where f.uploaded_by = m.user_id
         and f.state = any (public.states_holding_bytes())
    ) occ on true
    -- CONTRIBUTED: every claim, no state filter, on purpose. Claims are
    -- written only by ingest_finalize (i.e. after a HEAD-verified upload)
    -- and are never deleted, so this can only grow. Filtering by state here
    -- would make the social metric decrease when a track is later
    -- quarantined -- the precise UI behaviour PRD 10 rejected.
    left join lateral (
      select sum(f.byte_size) as total_bytes, count(*) as total_files
        from public.file_claims c
        join public.files f on f.id = c.file_id
       where c.user_id = m.user_id
    ) con on true
   where m.user_id = auth.uid()
      or public.is_owner()
   order by m.email;
end $$;

revoke execute on function public.member_storage() from public, anon;
grant  execute on function public.member_storage() to authenticated;
-- Deliberately NOT granted to service_role: the maintenance Worker
-- reconciles against public.files directly and has no business reading
-- per-member numbers.

-- ------------------------------------------------------------
-- The one-row convenience wrapper the upload page uses. For the owner,
-- member_storage() returns everyone, so the filter matters here too.
-- ------------------------------------------------------------
create or replace function public.my_storage()
returns table (
  occupying_bytes   bigint,
  occupying_files   int,
  contributed_bytes bigint,
  contributed_files int
)
language sql stable security definer set search_path = '' as $$
  select s.occupying_bytes, s.occupying_files, s.contributed_bytes, s.contributed_files
    from public.member_storage() s
   where s.member_id = auth.uid();
$$;

revoke execute on function public.my_storage() from public, anon;
grant  execute on function public.my_storage() to authenticated;

comment on function public.member_storage() is
  'Per-member storage. occupying = bytes of files this member uploaded that
   are still in the bucket. contributed = bytes this member brought to the
   pool, including files whose bytes deduped onto an existing object. A
   deduped upload adds a file_claims row and ZERO occupying bytes: no object
   was created, so "your files occupy N GB" has exactly one honest answer.
   sum(contributed) - sum(occupying) is the dedup saving.';
