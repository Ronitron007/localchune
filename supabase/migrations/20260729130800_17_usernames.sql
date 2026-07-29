-- supabase/migrations/20260729130800_17_usernames.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- M3 pool-UX Task 7 -- owner's verbatim ask: "every time a new user signs
-- up, they get to select their username... we use this username... pick a
-- standard way... make sure you have added validations."
--
-- The standard (decided in the plan): ^[a-z][a-z0-9_]{2,19}$ -- 3-20 chars,
-- lowercase letters/digits/underscore, must start with a letter. Input is
-- lowercased BEFORE every check, so storage is canonically lowercase and
-- uniqueness is case-insensitive by construction -- no citext, no separate
-- normalised column. Set once at claim; changing later is out of scope v1.
--
-- username_set() checks, IN THIS ORDER, each with its own distinct message
-- (never the raw Postgres wording):
--   1. lowercase the input
--   2. format (regex)                              -- 22023
--   3. reserved list (checked post-lowercase)       -- 22023
--   4. set-once (username is not null already)      -- P0001
--   5. uniqueness (23505, caught and re-raised with a friendly message)
-- Steps 4 and 5 are folded into ONE atomic UPDATE ("... where username is
-- null returning username") rather than a SELECT-then-UPDATE: a
-- check-then-act pair here would be a genuine TOCTOU race between two
-- concurrent claims for the same member, exactly the class of bug
-- migration 10's F4 finding (analysis_begin's lease) exists to avoid
-- elsewhere in this schema.
--
-- Retrofit: username is a NEW NULLABLE column on the existing members
-- table, not a new table -- every existing member (including the owner,
-- seeded by migration 04) has username = null until they next visit and
-- the middleware (src/middleware.ts) routes them through /welcome.
--
-- Three existing objects change shape because of this column:
--   * current_member() -- middleware.ts's per-request identity RPC -- must
--     return username so the middleware can decide the claim-flow redirect
--     without a second round trip. RETURNS TABLE's column list is
--     growing, so this is DROP + CREATE, not CREATE OR REPLACE (42P13,
--     "cannot change return type of existing function" -- the same rule
--     migration 15b/16 already document for pool_list/pool_get).
--   * admin_members() -- same DROP + CREATE reason, for the admin page's
--     new Username column (email stays -- it is the allowlist key, per
--     the plan).
--   * pool_tracks -- uploader_name's EXPRESSION changes
--     (coalesce(m.username, split_part(m.email,'@',1))) but its OUTPUT
--     COLUMN LIST does not, so CREATE OR REPLACE VIEW applies cleanly,
--     exactly like migration 16b's join-type change. pool_list/pool_get/
--     pool_uploaders all read uploader_name FROM the view and need no
--     changes of their own -- the swap is transparent to every caller.
-- ============================================================

-- ---- the column ----
-- The CHECK is a defense-in-depth backstop, not the primary validator --
-- username_set() below rejects a bad format with a friendly, distinct
-- message long before an UPDATE would ever reach this constraint. It
-- exists so a direct service_role write (or a future mistake) cannot leave
-- a row this schema calls invalid. NULL passes a CHECK unconditionally (the
-- expression evaluates to NULL, which SQL treats as "not violated"), so no
-- explicit "or username is null" clause is needed for the not-yet-claimed
-- case. The regex already only matches lowercase, so this single
-- constraint covers both "valid shape" and "canonically lowercase" -- no
-- separate `= lower(username)` clause needed either.
alter table public.members
  add column username text unique
  check (username ~ '^[a-z][a-z0-9_]{2,19}$');

comment on column public.members.username is
  'Set once via username_set() (self-service claim at /welcome). NULL until
   claimed -- src/middleware.ts redirects a null-username member to
   /welcome for every path outside the claim flow itself. Canonically
   lowercase (see the CHECK) so uniqueness is case-insensitive by
   construction; changing an already-set username is out of scope v1.';

-- ============================================================
-- The reserved list, as its own named function: a plain constant today, but
-- one place to extend rather than a literal array duplicated wherever the
-- check is needed.
-- ============================================================
create or replace function public.reserved_usernames()
returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'admin','owner','root','system','localchune','pool','track','upload',
    'api','auth','login','me','all','everyone','anonymous','deleted',
    'support','staff','mod','null'
  ];
$$;
revoke execute on function public.reserved_usernames() from public, anon;
grant  execute on function public.reserved_usernames() to authenticated;

-- ============================================================
-- username_set() -- the claim, and the ONLY way username is ever written
-- (the column has no other grant path; see the ACL note on `members`
-- itself, unchanged by this migration -- authenticated has select only,
-- so this SECURITY DEFINER function is the sole write path, same
-- discipline as grant_days()).
-- ============================================================
create or replace function public.username_set(p_username text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uname  text := lower(btrim(coalesce(p_username, '')));
  v_result text;
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_uname !~ '^[a-z][a-z0-9_]{2,19}$' then
    raise exception
      'usernames are 3-20 characters: lowercase letters, numbers, and underscore, starting with a letter'
      using errcode = '22023';
  end if;

  -- Checked AFTER lowercasing, so 'ADMIN' cannot dodge the reserved list by
  -- casing -- pgTAP proves this explicitly (supabase/tests/usernames.sql).
  if v_uname = any (public.reserved_usernames()) then
    raise exception 'that username is reserved' using errcode = '22023';
  end if;

  -- Set-once AND uniqueness in one atomic statement -- see this file's
  -- header for why a separate SELECT-then-UPDATE would race. The `where
  -- username is null` clause is what enforces set-once: if the caller
  -- already has one, zero rows match and v_result stays NULL, regardless
  -- of whether v_uname is available.
  begin
    update public.members
       set username = v_uname
     where user_id = (select auth.uid())
       and username is null
    returning username into v_result;
  exception when unique_violation then
    raise exception 'that username is already taken' using errcode = '23505';
  end;

  if v_result is null then
    raise exception 'username is already set and cannot be changed' using errcode = 'P0001';
  end if;

  return v_result;
end $$;

revoke execute on function public.username_set(text) from public, anon;
grant  execute on function public.username_set(text) to authenticated;

comment on function public.username_set(text) is
  'The self-service username claim, called from /api/welcome. Lowercases
   the input, then checks format, the reserved list, set-once and
   uniqueness in that order -- each with its own distinct, friendly
   message (never Postgres''s raw 23505 wording). Refuses a second claim
   for a member who already has a username. See this file''s header for
   why set-once and uniqueness are one atomic UPDATE, not a separate
   check-then-act pair.';

-- ============================================================
-- current_member() -- grows a `username` column so src/middleware.ts can
-- decide the claim-flow redirect from the same RPC call it already makes
-- on every request, with no second round trip. DROP + CREATE -- see header.
-- ============================================================
drop function if exists public.current_member();

create function public.current_member()
returns table (user_id uuid, email text, role text, access_expires_at timestamptz, username text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.email, m.role, m.access_expires_at, m.username
    from public.members m
   where m.user_id = auth.uid();
$$;
revoke execute on function public.current_member() from public, anon;
grant  execute on function public.current_member() to authenticated;

comment on function public.current_member() is
  'Exactly one row, always. Migration 17 appended username -- NULL until
   the member claims one at /welcome -- so the middleware can gate the
   claim-flow redirect from this same call.';

-- ============================================================
-- admin_members() -- grows a `username` column for the admin page's member
-- table. email stays the primary identity column (it is the allowlist
-- key); username is additional. DROP + CREATE -- see header.
-- ============================================================
drop function if exists public.admin_members();

create function public.admin_members()
returns table (
  email             text,
  username          text,
  role              text,
  access_expires_at timestamptz,
  credits           int,
  invited_at        timestamptz,
  revoked_at        timestamptz,
  signed_up         boolean
)
language sql security definer set search_path = '' as $$
  select a.email,
         m.username,
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

-- ============================================================
-- pool_tracks -- uploader_name now prefers the claimed username, falling
-- back to the email local part exactly as before for anyone who has not
-- claimed one yet. CREATE OR REPLACE VIEW, not DROP + CREATE: the output
-- column list is byte-for-byte unchanged from migration 16b, only this one
-- expression changed -- see this file's header and migration 16b's own
-- header for why that distinction matters (42P13 vs a clean replace).
-- pool_list()/pool_get()/pool_uploaders() all read uploader_name from this
-- view and need NO changes -- the swap is transparent to every caller.
-- ============================================================
create or replace view public.pool_tracks as
select
  f.id                                       as file_id,
  f.track_id,
  f.batch_id,
  f.uploaded_by,
  coalesce(m.username, split_part(m.email, '@', 1))
                                              as uploader_name,
  f.original_filename,
  f.r2_key,
  f.container,
  f.byte_size,
  f.created_at,
  f.state,
  coalesce(a.duration_ms, f.duration_ms)     as duration_ms,
  a.bpm,
  a.ibi_std_ms,
  a.key_camelot,
  a.key_open,
  a.key_musical,
  a.key_strength,
  a.key_alt_profiles,
  a.integrated_lufs,
  a.lra_lu,
  a.true_peak_dbtp,
  a.replaygain_db,
  a.clipped_pct,
  a.quality_tier,
  a.quality_score,
  a.lossy_ancestor,
  a.meas_cutoff_hz,
  a.preview_key,
  a.peaks_key,
  a.artwork_key,
  a.thumb_key,
  a.raw_tags,
  a.analysis_version,
  a.analyzed_at,
  coalesce(array_length(a.beat_grid, 1), 0)  as beat_count,
  d.camelot_sort,
  d.display_artist,
  d.display_title,
  ((lpad((99999999999999::bigint
          - (extract(epoch from f.created_at) * 1000)::bigint)::text, 14, '0')
   ) collate "C")                            as sk_added,
  ((case when a.bpm is null or a.bpm <= 0 then '99999999'
         else lpad(((a.bpm * 100)::int)::text, 8, '0') end) collate "C")
                                             as sk_bpm,
  ((lpad(d.camelot_sort::text, 3, '0')) collate "C")
                                             as sk_key,
  ((lower(coalesce(d.display_artist, '~'))) collate "C")
                                             as sk_artist,
  ((case when coalesce(a.duration_ms, f.duration_ms, 0) <= 0 then '99999999'
         else lpad(coalesce(a.duration_ms, f.duration_ms)::text, 8, '0') end) collate "C")
                                             as sk_duration,
  (((9 - coalesce(a.quality_tier, 0))::text) collate "C")
                                             as sk_tier,
  coalesce(ts.download_count, 0)             as download_count,
  (select count(*)::int from public.file_claims c where c.file_id = f.id)
                                             as upload_count,
  ((lpad((999999999999::bigint - coalesce(ts.download_count, 0))::text, 12, '0')
   ) collate "C")                            as sk_downloads,
  coalesce(
    (select array_agg(ft.tag_display order by ft.created_at, ft.tag_key)
       from public.file_tags ft where ft.file_id = f.id),
    '{}'::text[])                            as tags
from public.files f
-- LEFT, not JOIN: analysis_fail() (migration 09) never writes a row, so a
-- failed file has no audio_analysis partner -- see migration 16b.
left join public.audio_analysis a      on a.file_id = f.id
join public.members m                  on m.user_id  = f.uploaded_by
left join public.track_stats ts        on ts.file_id = f.id
cross join lateral (
  select
    case when a.key_camelot ~ '^([1-9]|1[0-2])[AB]$'
         then (left(a.key_camelot, length(a.key_camelot) - 1)::int) * 10
              + (case when right(a.key_camelot, 1) = 'B' then 1 else 0 end)
         else 999 end                                        as camelot_sort,
    public.display_artist(a.raw_tags, f.original_filename)    as display_artist,
    public.display_title (a.raw_tags, f.original_filename)    as display_title
) d;

revoke all on public.pool_tracks from public, anon, authenticated;

comment on view public.pool_tracks is
  'Ungranted composition unit. Reachable only from the SECURITY DEFINER
   functions pool_list/pool_get/pool_uploaders. Do NOT grant this to
   authenticated: it runs as its owner and bypasses RLS. download_count and
   upload_count added by migration 15b; tags added by migration 16; the
   audio_analysis LEFT JOIN by migration 16b. Migration 17 changed
   uploader_name to prefer members.username, falling back to the email
   local part exactly as before for a member who has not claimed one yet.';
