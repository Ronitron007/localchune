-- supabase/migrations/20260729131100_20_crates.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M6a Task 5 -- crates: member-curated, owner-controlled, optionally public
-- ordered lists of tracks. The substrate for M6a's "+ crate" row action and
-- the `/crates` and `/crate/[id]` pages (Tasks 6-8), and for M6c's "new
-- public crates" home-feed strip.
--
-- Two tables, same closed shape as likes/play_events/file_tags/track_stats:
-- REVOKE FIRST, grant nothing to anon/authenticated, mutate only through
-- SECURITY DEFINER functions below (migration 10's F3 explains why REVOKE
-- FIRST matters -- hosted Supabase's default privileges would otherwise hand
-- anon/authenticated full read/write the instant these tables exist).
--
-- crates.made_public_at is set by crate_set_public(true) and cleared by
-- crate_set_public(false) -- it feeds M6c's "new public crates" strip
-- (ordered by made_public_at desc), never crates.created_at.
--
-- crate_items.position is a plain int, manually managed (no reorder-by-
-- timestamp trick): crate_add appends at max(position)+1, crate_remove
-- leaves a gap (never renumbers -- cheap, and "1, 3" is a perfectly fine
-- order to render), crate_reorder is the only operation that ever rewrites
-- the full 1..n run. `unique (crate_id, position) deferrable initially
-- deferred` is what makes crate_reorder's single in-place UPDATE legal: the
-- update touches every row for the crate in one statement, and mid-statement
-- some rows temporarily share a position with others until the whole
-- statement (deferred to transaction end) is committed.
--
-- Final-review fix (I1): crate_add refuses (P0002) a file that is not
-- pool_visible_states() -- same gate as toggle_like/bump_play -- so a
-- hidden file can never enter a crate. crate_reorder's set-equality check
-- is therefore against the crate's pool-VISIBLE items only, matching what
-- crate_get actually shows the client; any item left out (a hidden one) is
-- renumbered to a position after the visible run rather than compared at
-- all, so a crate holding a hidden item can still be reordered instead of
-- permanently 22023ing.
--
-- Every mutating RPC below bumps crates.updated_at -- `/crates` sorts on it
-- and it is the one signal that a crate's *contents* changed, independent of
-- created_at (which never changes) and made_public_at (which only tracks the
-- public toggle).
--
-- Owner decision (design review, 2026-07-29): a name collision against the
-- SAME owner's existing crates auto-suffixes -- "warehouse" -> "warehouse
-- (2)" -> "warehouse (3)", loop guarded at n = 99 (22023 past it; nobody has
-- 99 warehouses). Two different owners may share a name freely -- the unique
-- constraint below is scoped to (owner_id, name), not name alone. The suffix
-- search itself lives in crate_available_name(), a private, fully-closed
-- helper (revoked from public/anon/authenticated, exactly like
-- camelot_neighbours in migration 11) shared by crate_create and
-- crate_rename so the two never drift out of sync on what "the smallest free
-- name" means.
--
-- crate_get's column list is `position int` followed by pool_get's ENTIRE
-- column list, in the same order, as of migration 19 -- so a crate's rows
-- render through the same TrackRow component the pool table already uses,
-- unchanged. It joins crate_items to pool_tracks (the same composition unit
-- pool_get itself reads) and filters to pool_visible_states() the same way
-- pool_get does: a file that was crated and later fails analysis simply
-- disappears from the crate instead of 500ing the page. crate_list's
-- owner_name uses the exact same `coalesce(m.username, split_part(m.email,
-- '@', 1))` expression pool_tracks.uploader_name uses post-migration-18 --
-- deliberately not a second lookup.
--
-- Visibility: crate_get and crate_list both apply "owner sees own crates
-- always; everyone else sees only is_public" -- crate_get raises 42501 for a
-- non-owner on a private crate (the route layer maps that to a 404 later;
-- the database's own answer is 42501, same as every other ownership check in
-- this file). crate_list simply omits rows that fail the predicate, since it
-- is a list, not a single-row fetch.
-- ============================================================

create table public.crates (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.members(user_id),
  name           text not null,
  is_public      boolean not null default false,
  made_public_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id, name)
);
alter table public.crates enable row level security;

comment on table public.crates is
  'One row per crate. owner_id is the only writer; is_public/made_public_at
   gate cross-member visibility. updated_at is bumped by every mutating
   crate_* RPC (rename, delete leaves no row to bump, set_public, add,
   remove, reorder) and is what /crates sorts on. Reachable only through the
   crate_* SECURITY DEFINER functions below -- no role ever gets a direct
   grant here, same closed shape as likes/play_events/file_tags/track_stats.
   See migration 10''s F3 for why REVOKE FIRST matters: hosted Supabase''s
   default privileges would otherwise hand anon/authenticated full read/
   write on this table the instant it exists. unique(owner_id, name) is the
   backstop for crate_available_name()''s auto-suffix search -- the RPCs
   never actually rely on hitting it, since they compute a free name first.';

revoke all on public.crates from public, anon, authenticated;
grant select, insert, update, delete on public.crates to service_role;

create table public.crate_items (
  crate_id uuid not null references public.crates(id) on delete cascade,
  file_id  uuid not null references public.files(id),
  position int  not null,
  added_at timestamptz not null default now(),
  primary key (crate_id, file_id),
  unique (crate_id, position) deferrable initially deferred
);
alter table public.crate_items enable row level security;

comment on table public.crate_items is
  'One row per (crate, file). position is a plain, manually-managed int --
   crate_add appends at max(position)+1, crate_remove leaves a gap (never
   renumbers), crate_reorder is the only RPC that rewrites the full 1..n run.
   `unique (crate_id, position) deferrable initially deferred` is what makes
   crate_reorder''s single in-place UPDATE legal, since it touches every row
   for the crate in one statement and rows transiently share a position
   until the deferred check runs at transaction end. Reachable only through
   the crate_* SECURITY DEFINER functions below -- same closed shape as
   crates. No role ever gets a direct grant here.';

revoke all on public.crate_items from public, anon, authenticated;
grant select, insert, update, delete on public.crate_items to service_role;
create index crate_items_crate_idx on public.crate_items (crate_id, position);

-- ============================================================
-- crate_available_name() -- private helper shared by crate_create and
-- crate_rename, fully closed (revoked from public/anon/authenticated, same
-- shape as camelot_neighbours in migration 11): it is reachable only from
-- inside another SECURITY DEFINER function owned by the same owner, which
-- needs no grant of its own to call it. Finds the smallest n >= 2 such that
-- "<name> (n)" is free for p_owner, starting from the bare name itself.
-- p_exclude_crate lets crate_rename exclude the crate being renamed from the
-- collision check, so renaming a crate back to (a variant of) its own
-- current name does not suffix against itself. Loop guarded at n = 99 --
-- past that it raises 22023 rather than looping forever; nobody has 99
-- crates with the same name.
-- ============================================================
create or replace function public.crate_available_name(
  p_owner uuid, p_name text, p_exclude_crate uuid default null
)
returns text
language plpgsql stable set search_path = '' as $$
declare
  v_try text := p_name;
  v_n   int  := 1;
begin
  while exists (
    select 1 from public.crates c
     where c.owner_id = p_owner
       and c.name = v_try
       and (p_exclude_crate is null or c.id <> p_exclude_crate)
  ) loop
    v_n := v_n + 1;
    if v_n > 99 then
      raise exception 'no free name for % -- % already has 99 variants',
        p_name, p_name using errcode = '22023';
    end if;
    v_try := p_name || ' (' || v_n || ')';
  end loop;
  return v_try;
end $$;

revoke execute on function public.crate_available_name(uuid, text, uuid)
  from public, anon, authenticated;

comment on function public.crate_available_name(uuid, text, uuid) is
  'Private helper, fully closed (no grant to any client role) -- reachable
   only from crate_create/crate_rename, both SECURITY DEFINER and owned by
   the same owner as this function. Finds the smallest n >= 2 making
   "<name> (n)" free for p_owner; p_exclude_crate lets a rename ignore the
   crate being renamed. Raises 22023 past n = 99.';

-- ============================================================
-- crate_create() -- member gate, trim/length validate (1-80 chars after
-- trim), auto-suffix via crate_available_name(), insert, return the new id.
-- ============================================================
create or replace function public.crate_create(p_name text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_id   uuid;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'crate name must not be empty' using errcode = '22023';
  end if;
  if length(v_name) > 80 then
    raise exception 'crate name must be at most 80 characters' using errcode = '22023';
  end if;

  v_name := public.crate_available_name(auth.uid(), v_name);

  insert into public.crates (owner_id, name)
  values (auth.uid(), v_name)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.crate_create(text) from public, anon;
grant  execute on function public.crate_create(text) to authenticated;

comment on function public.crate_create(text) is
  'Creates a crate owned by the caller. Name is trimmed, must be 1-80 chars
   after trimming (22023 otherwise), and auto-suffixed via
   crate_available_name() if the trimmed name collides with one of the
   caller''s own existing crates -- "warehouse" -> "warehouse (2)" -> ... .
   Different owners may share a name freely. Returns the new crate''s id.';

-- ============================================================
-- crate_rename() -- member gate, then owner_id = auth.uid() (42501),
-- validate + auto-suffix exactly like crate_create (excluding the crate
-- being renamed from its own collision check), update, bump updated_at.
-- ============================================================
create or replace function public.crate_rename(p_crate uuid, p_name text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.crates c
                  where c.id = p_crate and c.owner_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'crate name must not be empty' using errcode = '22023';
  end if;
  if length(v_name) > 80 then
    raise exception 'crate name must be at most 80 characters' using errcode = '22023';
  end if;

  v_name := public.crate_available_name(auth.uid(), v_name, p_crate);

  update public.crates
     set name = v_name, updated_at = now()
   where id = p_crate;
end $$;

revoke execute on function public.crate_rename(uuid, text) from public, anon;
grant  execute on function public.crate_rename(uuid, text) to authenticated;

comment on function public.crate_rename(uuid, text) is
  'Renames a crate the caller owns (42501 otherwise). Same trim/length/
   auto-suffix rules as crate_create, with the crate itself excluded from
   its own collision check so renaming it back toward its current name never
   suffixes against itself. Bumps updated_at.';

-- ============================================================
-- crate_delete() -- member gate, owner check, delete (crate_items cascades
-- via its FK). No updated_at bump: the row is gone.
-- ============================================================
create or replace function public.crate_delete(p_crate uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.crates c
                  where c.id = p_crate and c.owner_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.crates where id = p_crate;
end $$;

revoke execute on function public.crate_delete(uuid) from public, anon;
grant  execute on function public.crate_delete(uuid) to authenticated;

comment on function public.crate_delete(uuid) is
  'Deletes a crate the caller owns (42501 otherwise). crate_items cascades
   via its crate_id FK.';

-- ============================================================
-- crate_set_public() -- member gate, owner check, toggle. true sets
-- made_public_at to now(); false clears it to null. Bumps updated_at.
-- ============================================================
create or replace function public.crate_set_public(p_crate uuid, p_public boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.crates c
                  where c.id = p_crate and c.owner_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.crates
     set is_public      = coalesce(p_public, false),
         made_public_at = case when coalesce(p_public, false) then now() else null end,
         updated_at      = now()
   where id = p_crate;
end $$;

revoke execute on function public.crate_set_public(uuid, boolean) from public, anon;
grant  execute on function public.crate_set_public(uuid, boolean) to authenticated;

comment on function public.crate_set_public(uuid, boolean) is
  'Toggles a crate the caller owns (42501 otherwise) public/private. true
   sets made_public_at = now(); false clears it to null -- this is the field
   M6c''s "new public crates" strip sorts on, never created_at. Bumps
   updated_at.';

-- ============================================================
-- crate_add() -- member gate, owner check, pool_visible_states() P0002 gate
-- (I1a final-review fix -- the same gate toggle_like/bump_play apply in
-- migration 19: a file that is not pool-visible cannot be added to a crate
-- in the first place, matching crate_get's own filter so a crate never
-- silently accumulates items it can never render), then append at
-- coalesce(max(position),0)+1. Bumps updated_at.
-- ============================================================
create or replace function public.crate_add(p_crate uuid, p_file uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_pos   int;
  v_state text;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.crates c
                  where c.id = p_crate and c.owner_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select f.state into v_state from public.files f where f.id = p_file;
  if v_state is null or not (v_state = any (public.pool_visible_states())) then
    raise exception 'file % is not pool-visible', p_file using errcode = 'P0002';
  end if;

  select coalesce(max(ci.position), 0) + 1 into v_pos
    from public.crate_items ci where ci.crate_id = p_crate;

  insert into public.crate_items (crate_id, file_id, position)
  values (p_crate, p_file, v_pos);

  update public.crates set updated_at = now() where id = p_crate;
end $$;

revoke execute on function public.crate_add(uuid, uuid) from public, anon;
grant  execute on function public.crate_add(uuid, uuid) to authenticated;

comment on function public.crate_add(uuid, uuid) is
  'Appends p_file to a crate the caller owns (42501 otherwise) at
   coalesce(max(position),0)+1. Refuses (P0002) on any file whose state is
   not in pool_visible_states() -- same gate as toggle_like/bump_play -- so
   a hidden file can never enter a crate to begin with. Bumps updated_at.';

-- ============================================================
-- crate_remove() -- member gate, owner check, delete the item. Leaves a gap
-- in position -- never renumbers (crate_reorder is the only RPC that
-- rewrites the full run). Bumps updated_at.
-- ============================================================
create or replace function public.crate_remove(p_crate uuid, p_file uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.crates c
                  where c.id = p_crate and c.owner_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.crate_items where crate_id = p_crate and file_id = p_file;

  update public.crates set updated_at = now() where id = p_crate;
end $$;

revoke execute on function public.crate_remove(uuid, uuid) from public, anon;
grant  execute on function public.crate_remove(uuid, uuid) to authenticated;

comment on function public.crate_remove(uuid, uuid) is
  'Removes p_file from a crate the caller owns (42501 otherwise). Positions
   of the remaining items are left as-is (a gap, not renumbered). Bumps
   updated_at.';

-- ============================================================
-- crate_reorder() -- member gate, owner check, then asserts p_files is a
-- set-equal permutation of the crate's POOL-VISIBLE items only (22023 on
-- missing, extra or duplicate ids) before rewriting those positions to the
-- array index in one UPDATE. This is the I1b final-review fix: a client
-- only ever sees pool-visible items (crate_get filters to
-- pool_visible_states(), same as crate_get itself), so it can never legally
-- construct an array that also names a hidden item -- requiring full-crate
-- set-equality against p_files would make reordering permanently
-- impossible the moment a crate held even one hidden item. A second UPDATE
-- then renumbers any hidden item(s) to positions AFTER the visible run
-- (v_n + 1, v_n + 2, ... in their existing relative order), so the
-- deferred unique(crate_id, position) check at commit never sees a
-- collision between a freshly-renumbered visible item and an untouched
-- hidden one. Bumps updated_at.
-- ============================================================
create or replace function public.crate_reorder(p_crate uuid, p_files uuid[])
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_files uuid[] := coalesce(p_files, array[]::uuid[]);
  v_n     int    := cardinality(coalesce(p_files, array[]::uuid[]));
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.crates c
                  where c.id = p_crate and c.owner_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if (select count(*) from public.crate_items ci
        join public.files f on f.id = ci.file_id
       where ci.crate_id = p_crate
         and f.state = any (public.pool_visible_states()))
     <> v_n
     or exists (select 1 from unnest(v_files) f
                left join public.crate_items ci
                  on ci.crate_id = p_crate and ci.file_id = f
                left join public.files ff
                  on ff.id = f and ff.state = any (public.pool_visible_states())
                where ci.file_id is null or ff.id is null)
     or (select count(distinct f) from unnest(v_files) f)
        <> v_n
  then raise exception 'reorder array must be a permutation of the crate''s pool-visible items'
       using errcode = '22023';
  end if;

  update public.crate_items ci
     set position = u.ord
    from unnest(v_files) with ordinality as u(file_id, ord)
   where ci.crate_id = p_crate and ci.file_id = u.file_id;

  -- Any item NOT named in p_files is, by the check above, a hidden item --
  -- renumber it past the visible run, preserving its existing relative
  -- order, so it never collides with the 1..v_n positions just written.
  update public.crate_items ci
     set position = v_n + u.ord
    from (
      select file_id, row_number() over (order by position) as ord
        from public.crate_items
       where crate_id = p_crate
         and file_id <> all (v_files)
    ) u
   where ci.crate_id = p_crate and ci.file_id = u.file_id;

  update public.crates set updated_at = now() where id = p_crate;
end $$;

revoke execute on function public.crate_reorder(uuid, uuid[]) from public, anon;
grant  execute on function public.crate_reorder(uuid, uuid[]) to authenticated;

comment on function public.crate_reorder(uuid, uuid[]) is
  'Rewrites a crate the caller owns (42501 otherwise) to the order given by
   p_files, which must be a set-equal permutation of the crate''s current
   POOL-VISIBLE file_ids only -- a missing, extra or duplicate id raises
   22023. Visible positions become the 1-based array index; any hidden item
   is renumbered to a position after the visible run, preserving its
   relative order, so it never collides with the deferred unique check at
   commit. Bumps updated_at.';

-- ============================================================
-- crate_list() -- member gate, then every crate the caller owns plus every
-- public crate from anyone. owner_name mirrors pool_tracks.uploader_name's
-- exact expression (migration 18) -- not a second lookup. track_count/
-- total_duration_ms are computed over pool-visible items only, the same
-- filter crate_get applies, so a card's count never disagrees with what
-- opening the crate actually shows.
-- ============================================================
create or replace function public.crate_list()
returns table (
  id                uuid,
  name              text,
  owner_id          uuid,
  owner_name        text,
  is_mine           boolean,
  is_public         boolean,
  track_count       int,
  total_duration_ms bigint,
  updated_at        timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.id, c.name, c.owner_id,
         coalesce(m.username, split_part(m.email, '@', 1)) as owner_name,
         (c.owner_id = auth.uid())                          as is_mine,
         c.is_public,
         coalesce(ci.track_count, 0)::int                   as track_count,
         coalesce(ci.total_duration_ms, 0)::bigint           as total_duration_ms,
         c.updated_at
    from public.crates c
    join public.members m on m.user_id = c.owner_id
    left join lateral (
      select count(*)::int as track_count,
             sum(coalesce(a.duration_ms, f.duration_ms, 0))::bigint as total_duration_ms
        from public.crate_items it
        join public.files f on f.id = it.file_id
        left join public.audio_analysis a on a.file_id = f.id
       where it.crate_id = c.id
         and f.state = any (public.pool_visible_states())
    ) ci on true
   where c.owner_id = auth.uid() or c.is_public;
end $$;

revoke execute on function public.crate_list() from public, anon;
grant  execute on function public.crate_list() to authenticated;

comment on function public.crate_list() is
  'Every crate the caller owns, plus every public crate from any owner.
   is_mine flags the caller''s own rows; a private crate never appears for
   anyone else. owner_name reuses pool_tracks.uploader_name''s exact
   expression. track_count/total_duration_ms only count items whose file is
   in pool_visible_states(), matching crate_get''s own filter.';

-- ============================================================
-- crate_get() -- member gate, then owner-or-public check on the crate
-- itself (42501 otherwise). Returns `position` followed by pool_get's
-- entire column list (migration 19), joined from crate_items to
-- pool_tracks -- the same composition unit pool_get itself reads -- filtered
-- to pool_visible_states() so a crated file that later fails analysis
-- disappears from the crate instead of 500ing the page. Ordered by
-- position.
-- ============================================================
create or replace function public.crate_get(p_crate uuid)
returns table (
  "position"        int,
  file_id           uuid,
  track_id          uuid,
  uploaded_by       uuid,
  uploader_name     text,
  original_filename text,
  r2_key            text,
  display_artist    text,
  display_title     text,
  container         text,
  byte_size         bigint,
  state             text,
  duration_ms       int,
  bpm               real,
  ibi_std_ms        real,
  beat_count        int,
  key_camelot       text,
  key_open          text,
  key_musical       text,
  key_strength      real,
  key_alt_profiles  jsonb,
  integrated_lufs   real,
  lra_lu            real,
  true_peak_dbtp    real,
  replaygain_db     real,
  clipped_pct       real,
  quality_tier      smallint,
  quality_score     real,
  lossy_ancestor    text,
  meas_cutoff_hz    int,
  preview_key       text,
  peaks_key         text,
  artwork_key       text,
  thumb_key         text,
  raw_tags          jsonb,
  analysis_version  text,
  analyzed_at       timestamptz,
  batch_id          uuid,
  batch_label       text,
  claim_names       text[],
  created_at        timestamptz,
  download_count    bigint,
  upload_count      int,
  tags              text[],
  like_count        int,
  liked_by_me       boolean,
  play_count        int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.crates cr
     where cr.id = p_crate
       and (cr.owner_id = auth.uid() or cr.is_public)
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select ci.position,
         t.file_id, t.track_id, t.uploaded_by, t.uploader_name,
         t.original_filename, t.r2_key, t.display_artist, t.display_title,
         t.container, t.byte_size, t.state, t.duration_ms,
         t.bpm, t.ibi_std_ms, t.beat_count,
         t.key_camelot, t.key_open, t.key_musical, t.key_strength, t.key_alt_profiles,
         t.integrated_lufs, t.lra_lu, t.true_peak_dbtp, t.replaygain_db, t.clipped_pct,
         t.quality_tier, t.quality_score, t.lossy_ancestor, t.meas_cutoff_hz,
         t.preview_key, t.peaks_key, t.artwork_key, t.thumb_key,
         t.raw_tags, t.analysis_version, t.analyzed_at,
         t.batch_id, ub.label, cl.claim_names, t.created_at,
         t.download_count, t.upload_count, t.tags,
         t.like_count, t.liked_by_me, t.play_count
    from public.crate_items ci
    join public.pool_tracks t on t.file_id = ci.file_id
    left join public.upload_batches ub on ub.id = t.batch_id
    cross join lateral (
      select coalesce(
               array_agg(coalesce(m2.username, split_part(m2.email, '@', 1))
                         order by m2.email),
               '{}'::text[]) as claim_names
        from public.file_claims c
        join public.members m2 on m2.user_id = c.user_id
       where c.file_id = t.file_id
    ) cl
   where ci.crate_id = p_crate
     and t.state = any (public.pool_visible_states())
   order by ci.position;
end $$;

revoke execute on function public.crate_get(uuid) from public, anon;
grant  execute on function public.crate_get(uuid) to authenticated;

comment on function public.crate_get(uuid) is
  'A crate''s items, ordered by position, as `position` followed by
   pool_get''s entire column list (migration 19) -- so a crate renders
   through the same TrackRow component the pool table uses, unchanged.
   42501 unless the caller owns the crate or it is public. Filters items to
   pool_visible_states(), the same gate pool_get applies to the file itself,
   so a crated file that later fails analysis silently drops out instead of
   500ing the page.';
