-- supabase/migrations/20260727130000_06_ingest.sql

-- ============================================================
-- Helpers first: policies below depend on them.
-- ============================================================

-- Active membership, as a SECURITY DEFINER function so a policy on files can
-- ask "is the caller a live member?" without any policy on members running,
-- and without any risk of 42P17. M1 already ships is_owner() and
-- current_member() on exactly this pattern.
create or replace function public.is_active_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members
     where user_id = auth.uid() and access_expires_at > now());
$$;
revoke execute on function public.is_active_member() from public, anon;
grant  execute on function public.is_active_member() to authenticated;

-- The states in which an R2 object exists and therefore occupies bytes.
-- PRD 10 says `state = 'stored'`, which is the endpoint of the M3 pipeline;
-- taken literally it reports 0 bytes for every file until M3 ships, and 0
-- again for anything sitting in needs_review. "Occupying" means "the object
-- is in the bucket", and that is exactly the set below: everything after a
-- verified upload and before a delete.
create or replace function public.states_holding_bytes()
returns text[] language sql immutable set search_path = '' as $$
  select array['received','analysing','stored','needs_review']::text[];
$$;
revoke execute on function public.states_holding_bytes() from public, anon;
grant  execute on function public.states_holding_bytes() to authenticated;

-- The states in which a file is visible to the whole pool. Everything else
-- (a failed upload, a quarantined fake, an over-length reject) is visible
-- only to its uploader and the owner.
create or replace function public.pool_visible_states()
returns text[] language sql immutable set search_path = '' as $$
  select array['received','analysing','stored','needs_review']::text[];
$$;
revoke execute on function public.pool_visible_states() from public, anon;
grant  execute on function public.pool_visible_states() to authenticated;
-- NOTE: neither helper may be referenced from a CHECK constraint. A CHECK
-- runs under the WRITING role's privileges (unlike a trigger), so it would
-- need EXECUTE granted to every role that writes the table. files.state is
-- checked against a literal in (...) list for that reason.

-- ============================================================
-- Tables
-- ============================================================

-- One drag-and-drop of N files. Exists so a batch can be reported on and
-- resumed as a unit, and so a sweeper can reason about "this whole batch was
-- abandoned" rather than N unrelated rows.
create table public.upload_batches (
  id         uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.members(user_id) on delete cascade,
  label      text,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
alter table public.upload_batches enable row level security;
create index upload_batches_creator_idx on public.upload_batches (created_by, created_at desc);

create table public.files (
  id             uuid primary key,          -- CLIENT-GENERATED. see below.
  track_id       uuid,                      -- FK added in M4 when tracks exists
  batch_id       uuid not null references public.upload_batches(id),
  uploaded_by    uuid not null references public.members(user_id),
  r2_key         text not null unique,
  original_filename text not null,
  content_sha256 bytea unique,              -- nullable: filled by M3, see below
  byte_size      bigint not null check (byte_size > 0),
  container      text,
  codec          text,
  bitrate_kbps   int,
  sample_rate    int,
  bit_depth      int,
  channels       smallint,
  duration_ms    int,        -- DECODED duration only. M3 writes it. NEVER M2.
  tags           jsonb not null default '{}',
  quality_score  real,
  quality_tier   smallint,
  state          text not null default 'pending'
    check (state in ('pending','uploading','received','analysing','stored',
                     'needs_review','rejected_duration','rejected_redundant',
                     'quarantined','failed','abandoned')),
  created_at       timestamptz not null default now(),
  state_changed_at timestamptz not null default now()
);
alter table public.files enable row level security;

comment on column public.files.id is
  'Client-generated UUID, persisted in the browser BEFORE any network call.
   This is the idempotency key: a retried upload reuses it, so a retry can
   never create a second row. It does NOT let the client pick the object
   key -- ingest_begin() mints r2_key from auth.uid() and this id, so
   reusing another member''s id yields a different key and a primary-key
   conflict rather than an overwrite.';

comment on column public.files.duration_ms is
  'DECODED duration, written only by the analysis worker (M3). The client
   pre-flight number lives in ingest_jobs.client_duration_ms and is advisory
   forever. PRD 7.1: VBR MP3s without a Xing header report wildly wrong
   container durations, and a wrong value here silently breaks M4''s +/-10s
   dedup candidate gate with no error and no alert.';

comment on column public.files.content_sha256 is
  'Layer-0 dedup key, nullable in M2 and filled by the analysis worker.
   PRD 5 forbids hashing a 200-file batch up front and Web Crypto has no
   streaming digest, so the worker -- which already downloads every file --
   is where this is free.';

comment on column public.files.state_changed_at is
  'Maintained by ingest_set_state(). M3''s stuck-job cron MUST filter on
   this, not created_at: created_at is when the row was minted, before the
   bytes moved, so a 40-minute multipart upload would be re-enqueued the
   instant it entered analysing.';

-- M3's stuck-job cron: state = 'analysing' AND state_changed_at < now() - 1h.
create index files_state_changed_idx on public.files (state, state_changed_at);
create index files_uploader_idx      on public.files (uploaded_by);
create index files_batch_idx         on public.files (batch_id);
create index files_created_idx       on public.files (created_at desc);

-- Who contributed what, decoupled from who owns the bytes. Written at
-- ingest_finalize for the uploader's own file; M4 adds a SECOND row when a
-- different member's bytes dedupe onto an existing file. That makes this the
-- single source of the "contributed" number from day one, and means M4 only
-- ever inserts.
create table public.file_claims (
  file_id    uuid not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.members(user_id) on delete cascade,
  batch_id   uuid not null references public.upload_batches(id),
  claimed_at timestamptz not null default now(),
  primary key (file_id, user_id)
);
alter table public.file_claims enable row level security;
create index file_claims_user_idx on public.file_claims (user_id);

-- Everything about the transfer itself. Split from files because it is
-- write-hot during a batch and dead afterwards, and because M3/M4 never
-- need to read it.
create table public.ingest_jobs (
  file_id            uuid primary key references public.files(id) on delete cascade,
  batch_id           uuid not null references public.upload_batches(id) on delete cascade,
  user_id            uuid not null references public.members(user_id) on delete cascade,
  declared_byte_size bigint not null check (declared_byte_size > 0),
  client_duration_ms int check (client_duration_ms is null or client_duration_ms >= 0),
  multipart          boolean not null,
  part_size          int check (part_size is null or part_size >= 5242880),
  part_count         int check (part_count is null or (part_count between 1 and 10000)),
  upload_id          text,
  attempts           int not null default 0,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- R2 validates "all non-trailing parts are the same length" only at
  -- CompleteMultipartUpload, i.e. after every byte is already uploaded.
  -- part_size is therefore decided ONCE, stored here, and every offset is
  -- derived as i * part_size. A multipart job without one is malformed.
  constraint ingest_jobs_multipart_plan check (
    (multipart      and part_size is not null and part_count is not null)
 or (not multipart  and part_size is null     and part_count is null))
);
alter table public.ingest_jobs enable row level security;
create index ingest_jobs_stale_idx on public.ingest_jobs (updated_at);

comment on column public.ingest_jobs.client_duration_ms is
  'What the browser pre-flight read out of the file header. Advisory only,
   never copied to files.duration_ms. Null is legal and means the header
   carried no usable duration (header-less VBR MP3, non-faststart M4A) --
   that is not a rejection, the size gate still applies and M3 decides.';

comment on column public.ingest_jobs.upload_id is
  'R2 multipart UploadId. Persisted server-side so the sweeper can abort an
   orphaned upload even if the browser that started it never returns.
   Completed part ETags are deliberately NOT persisted -- ListParts recovers
   them from R2 on demand, which is what makes cross-device resume free.';

-- ============================================================
-- RLS. Read policies only. Every mutation is a definer function (Task 3).
-- ============================================================

create policy "members read own batches"
  on public.upload_batches for select to authenticated
  using ( created_by = (select auth.uid()) or (select public.is_owner()) );

-- The pool is shared: any active member sees any file that made it into a
-- pool-visible state. A failed, quarantined or over-length file is visible
-- only to the person who uploaded it, and to the owner.
create policy "members read pool files"
  on public.files for select to authenticated
  using (
    (select public.is_active_member())
    and ( state = any (public.pool_visible_states())
          or uploaded_by = (select auth.uid())
          or (select public.is_owner()) )
  );

create policy "members read claims"
  on public.file_claims for select to authenticated
  using ( (select public.is_active_member()) );

create policy "members read own ingest jobs"
  on public.ingest_jobs for select to authenticated
  using ( user_id = (select auth.uid()) or (select public.is_owner()) );

-- ============================================================
-- BASE TABLE GRANTS -- without these every policy above is dead code.
-- RLS filters rows only AFTER Postgres' table-level ACL check passes, and
-- Supabase's default gives authenticated/service_role no DML on new tables.
-- service_role's BYPASSRLS skips row filtering, NOT the ACL.
-- ============================================================
grant select on public.upload_batches, public.files,
                public.file_claims,    public.ingest_jobs
  to authenticated;

grant select, insert, update, delete
   on public.upload_batches, public.files,
      public.file_claims,    public.ingest_jobs
  to service_role;
