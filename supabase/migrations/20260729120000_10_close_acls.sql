-- supabase/migrations/20260729120000_10_close_acls.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M3 final-review Finding F3 (HIGH): migration 09's follow-up note named
-- FOUR tables still carrying hosted Supabase's default open ACL -- files,
-- upload_batches, file_claims, ingest_jobs (migration 06) -- and left out
-- the three from migrations 01/01b: allowlist, credit_grants, members.
-- Live `pg_class.relacl` on hosted, checked 2026-07-29, showed
-- `anon=arwdDxtm` / `authenticated=arwdDxtm` on all SEVEN. members is the
-- authorization table and allowlist is the signup gate -- the two most
-- dangerous tables in the project were the two the note forgot.
--
-- RLS has held the whole time: every policy on every one of these seven
-- tables is SELECT-only, so there is no permissive insert/update/delete
-- policy for `anon` or `authenticated` to ride. But "RLS alone, with the
-- table ACL wide open underneath it" is one careless future
-- `create policy ... for insert` away from a real hole, and it is not what
-- migrations 01, 01b and 06 believed they were writing -- 01b's own grants
-- are a no-op against hosted, for the exact reason migration 09's comment
-- documents. This migration finishes what 09 started: the same
-- revoke-first shape, all seven tables.
--
-- NUMBERING NOTE: migration 09 reserved the filename "migration 10" for
-- M5's pool-listing migration (docs/superpowers/plans/
-- 2026-07-28-05-pool-ui.md, "Prerequisites" and throughout). This file
-- takes that slot instead, because F3 is a live production security gap and
-- M5 has not started implementation. M5's own migration must be renumbered
-- to 11 (and its in-plan references to "migration 10" bumped along with it)
-- when that milestone begins -- see the note left in migration 09 and in
-- the plan's Prerequisites section.
--
-- Also folds in Finding F4 (MEDIUM): analysis_begin()'s duplicate-delivery
-- lease. See the second half of this file.

-- ============================================================
-- F3 -- revoke first, then grant exactly what the existing policies need.
--
-- REVOKE FIRST is not belt-and-braces (see migration 09's comment for the
-- full mechanism, and CLAUDE.md's "Hosted Supabase grants every table"
-- section). A bare `grant select` is a no-op against hosted Supabase's
-- `ALTER DEFAULT PRIVILEGES`, which hands anon/authenticated/service_role
-- every privilege (arwdDxtm) on every new public table. Only a REVOKE makes
-- the GRANT that follows mean the same thing on both databases.
--
-- `public` is revoked alongside anon and authenticated, defensively -- it is
-- extremely unlikely any of these seven ever picked up a PUBLIC-pseudo-role
-- grant, but the cost of checking is one extra role name.
--
-- supabase_auth_admin's reads (migration 01, on allowlist and members) and
-- every service_role grant are untouched by the revokes below: neither role
-- is ever named in a REVOKE here. Each is still re-granted explicitly next
-- to its REVOKE, so this file is a complete, self-checking record of what
-- every role can do to every one of these seven tables, not just a diff.
-- ============================================================

revoke all on public.files, public.upload_batches,
                public.file_claims, public.ingest_jobs
  from public, anon, authenticated;

revoke all on public.allowlist, public.credit_grants, public.members
  from public, anon, authenticated;

-- ---- migration 06's four tables: same shape as before, made explicit ----
grant select on public.files, public.upload_batches,
                public.file_claims, public.ingest_jobs
  to authenticated;
grant select, insert, update, delete
   on public.files, public.upload_batches,
      public.file_claims, public.ingest_jobs
  to service_role;

-- ---- migration 01/01b's three tables ----
-- allowlist gets NO grant to authenticated: it has zero policies for that
-- role and must stay invisible to clients, reached only through the
-- SECURITY DEFINER admin_invite()/admin_revoke() functions and the
-- before_user_created auth hook. supabase_auth_admin's read grant
-- (migration 01) is untouched by the revoke above.
grant select, insert, update, delete on public.allowlist to service_role;

-- members and credit_grants both have member-facing SELECT policies
-- ("members read own row" / "owner reads all members" / "members read own
-- grants"), so authenticated needs select here same as it always has.
-- supabase_auth_admin's read grant on members (migration 01) is likewise
-- untouched.
grant select on public.credit_grants, public.members to authenticated;
grant select, insert, update, delete
   on public.credit_grants, public.members to service_role;

-- ============================================================
-- F4 -- close the duplicate-delivery window in analysis_begin().
--
-- Queues is at-least-once, and the previous version treated a row already
-- 'analysing' as "carry on": it re-entered the transition (a no-op against
-- ingest_set_state's allowed-source-states list) and returned 'analysing',
-- which the consumer reads as "run the analysis". A redelivery landing
-- inside the ~45s the first attempt was still working ran a second full
-- container analysis on the same file, in the same serialised container
-- slot, for nothing -- ~45 wasted vCPU-s.
--
-- Fix: a row already 'analysing' is only reclaimable once its 10-minute
-- lease has expired. Inside the lease, a second claim returns 'busy' and
-- touches nothing -- no state transition, no wasted work. The consumer's
-- job on 'busy' is to retry the message, never to analyse
-- (workers/analysis/src/consumer.ts); Queues' own backoff there comfortably
-- outlasts a ~45-55s container run.
--
-- Past the lease, this is exactly today's behaviour, unchanged: the claim
-- proceeds through ingest_set_state and returns 'analysing', which is the
-- same reclaim the stuck-job cron already relies on for a genuinely dead
-- consumer (analysis_stuck(), one hour, below). Ten minutes sits
-- comfortably above the ~45-55s p99 for one track and comfortably below the
-- cron's one-hour sweep, so the lease only ever fires on an in-flight
-- duplicate and never on a healthy long-running analysis.
-- ============================================================
create or replace function public.analysis_begin(p_file_id uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_state   text;
  v_changed timestamptz;
begin
  select f.state, f.state_changed_at into v_state, v_changed
    from public.files f where f.id = p_file_id;
  if v_state is null then
    raise exception 'unknown file %', p_file_id using errcode = 'P0002';
  end if;

  if v_state = 'analysing' and v_changed > now() - interval '10 minutes' then
    return 'busy';
  end if;

  if v_state in ('received','analysing') then
    return public.ingest_set_state(p_file_id, array['received','analysing'], 'analysing');
  end if;
  return v_state;
end $$;
-- create or replace preserves the grants migration 09 set (revoked from
-- public/anon/authenticated, granted to service_role); re-declared below
-- anyway so this file is a complete record of who can call it.
revoke execute on function public.analysis_begin(uuid) from public, anon, authenticated;
grant  execute on function public.analysis_begin(uuid) to service_role;

comment on function public.analysis_begin(uuid) is
  'Claims a file for analysis. Returns the state AFTER the call: the
   consumer proceeds only on ''analysing''. ''busy'' (added in migration 10,
   Finding F4) means another delivery already claimed this file inside the
   10-minute lease and is presumably still running it -- the consumer must
   retry the message, not analyse. Past the lease, a still-''analysing'' row
   is reclaimed exactly like the stuck-job cron would (analysis_stuck()),
   which is what makes a genuinely abandoned analysis recoverable.';
