-- supabase/migrations/20260729170000_22_dedup_schema.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M4 Task 2. Track identity and the dedup ledger.
--
-- SHAPE ONLY. No retrieval query, no scoring, no decision logic: this file
-- creates the things the matcher writes to and the one identity it merges
-- into, so its pgTAP can assert the shape before any scorer exists.
-- Migration 23 adds the merge/undo mechanics; Tasks 4-6 add
-- dedup_candidates(), the BER scorer and dedup_resolve() on top.
--
-- NUMBERING. The plan calls this "migration 15" and that label is stale:
-- pool-ux consumed 15/16/17/18, M4.1 took 19, PR #16 took 20 (provenance,
-- applied to hosted, file lives on main), and rohan/drop-files-bitrate has
-- claimed 21. This is 22, timestamp 20260729170000, claimed in
-- .superpowers/sdd/progress.md before it was applied anywhere. The 19 -> 22
-- gap in `ls supabase/migrations/` on this branch is expected and resolves
-- at the M4 milestone merge.

-- ============================================================
-- tracks -- the canonical, format-agnostic recording identity.
--
-- One row is ONE RECORDING. PRD §3: a remix, an edit and a radio version
-- are SEPARATE tracks; only re-encodes and re-rips of one recording
-- collapse. The two production "Feeling For You" files are original and
-- remix, share a BPM (133.0) and a key (11A), and must stay two rows
-- forever -- see dedup_seed_tracks() below, which is what makes that
-- outcome the DEFAULT rather than something a matcher has to get right.
--
-- DELIBERATELY NARROW. PRD §4 draws about twenty canonical-metadata columns
-- here (artist, label, isrc, mbid, artwork_url, beat_grid...). Those are
-- M7's output. Creating them now as twenty always-NULL columns is a
-- placeholder that invites a reader, and M5 already renders artist and
-- title from raw_tags through display_artist()/display_title(). M7 adds its
-- own columns in its own migration.
-- ============================================================
create table public.tracks (
  id                   uuid primary key default gen_random_uuid(),
  preferred_file_id    uuid references public.files(id),
  merged_into_track_id uuid references public.tracks(id),
  merged_at            timestamptz,
  created_at           timestamptz not null default now(),
  constraint no_self_merge check (merged_into_track_id is distinct from id)
);
alter table public.tracks enable row level security;
create index tracks_merged_idx on public.tracks (merged_into_track_id)
  where merged_into_track_id is not null;
create index tracks_preferred_idx on public.tracks (preferred_file_id);

comment on table public.tracks is
  'One row = one RECORDING, not one file and not one release. A remix, an
   edit and a radio version are separate tracks (PRD §3); only re-encodes
   and re-rips of the same recording collapse into one. preferred_file_id
   is the encode the pool serves; every other file on the track is a kept
   alternate, never overwritten (keep-if-better, PRD §7.2).';

-- files.track_id has been a bare uuid since migration 06, whose column
-- comment says "FK added in M4 when tracks exists". This is that. Every
-- hosted row is NULL today (checked 2026-07-29: 626 files, 0 non-null), so
-- the constraint validates instantly and needs no NOT VALID dance.
alter table public.files
  add constraint files_track_fk foreign key (track_id) references public.tracks(id);
create index files_track_idx on public.files (track_id);

-- ------------------------------------------------------------
-- The merge chain walker. EVERY read of a track id goes through this.
--
-- PRD §4: crates reference track_id and are NEVER rewritten by a merge or
-- an undo. A merge is one UPDATE, an undo is one UPDATE, and crates snap
-- back automatically because they resolve through here.
--
-- The depth cap is not decoration. No function in this milestone can build
-- a cycle, but a hand-run UPDATE can, and an unbounded loop inside a
-- function this widely called takes down every request that touches it.
-- 32 hops is far past any real chain and terminates instantly on a cycle.
-- ------------------------------------------------------------
create or replace function public.canonical_track_id(p_track_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_id   uuid := p_track_id;
  v_next uuid;
  v_hops int  := 0;
begin
  if v_id is null then
    return null;                      -- an unassigned file is not an error
  end if;
  loop
    select t.merged_into_track_id into v_next from public.tracks t where t.id = v_id;
    exit when v_next is null or v_hops >= 32;
    v_id := v_next;
    v_hops := v_hops + 1;
  end loop;
  return v_id;
end $$;
revoke execute on function public.canonical_track_id(uuid) from public, anon;
grant  execute on function public.canonical_track_id(uuid) to authenticated, service_role;

-- ============================================================
-- track_relations -- the 0.40-0.70 band's output. "These two are versions
-- of each other" is a real answer, and it is not a merge. This is where the
-- original/remix pair belongs if the scorer finds them related at all.
-- ============================================================
create table public.track_relations (
  track_id      uuid not null references public.tracks(id) on delete cascade,
  related_id    uuid not null references public.tracks(id) on delete cascade,
  relation      text not null check (relation in ('version','remix','same_release')),
  score         real,
  created_at    timestamptz not null default now(),
  primary key (track_id, related_id, relation),
  constraint no_self_relation check (track_id <> related_id)
);
alter table public.track_relations enable row level security;

-- ============================================================
-- match_decisions -- APPEND ONLY. The machine's answers, every band of
-- them, including the ones that decided nothing.
--
-- The near-miss band (0.40-0.70) is logged here for the same reason the
-- auto-merge band is: M4.8 calibrates the thresholds against real scores,
-- and a threshold you never recorded a score below cannot be calibrated.
-- dedup_near_misses (below) is the view that reads them back.
--
-- PRD §6: reprocessing SUPERSEDES rather than duplicating, and every row
-- records the exact thresholds it used, so changing a threshold cannot
-- retroactively make a past decision unexplainable.
--
-- per_second_ber is the divergence strip: one value per second, so a
-- reviewer can SEE that two tracks share a body and differ only in the
-- first thirty seconds -- a different intro edit, not a different track.
-- ============================================================
create table public.match_decisions (
  id                  bigserial primary key,
  probe_file_id       uuid not null references public.files(id) on delete cascade,
  candidate_file_id   uuid not null references public.files(id) on delete cascade,
  candidate_track_id  uuid          references public.tracks(id),
  algo_version        text not null,
  layer               text not null check (layer in ('content_sha256','fp_sha256','ber')),
  score               real not null,
  band                text not null check (band in ('same','probable','related','different')),
  best_offset_frames  int,
  overlap_frames      int,
  shared_items        int,
  duration_delta_ms   int,
  per_second_ber      real[],
  thresholds          jsonb not null,
  action              text not null,
  decided_at          timestamptz not null default now(),
  superseded_at       timestamptz
);
alter table public.match_decisions enable row level security;

comment on column public.match_decisions.band is
  'same (>= t_same, auto-merge) / probable (>= t_probable, the review queue)
   / related (>= t_related, logged as a near miss and recorded as a
   track_relation, never merged) / different (below t_related, logged and
   dropped). The related band is LOAD-BEARING for M4.8: it is the only
   record of what the scorer actually produced for pairs the shipped
   guesses called apart.';

-- One LIVE decision per (probe, candidate). Reprocessing at a new
-- algo_version sets superseded_at on the old row and inserts a new one, so
-- history is retained and the current answer is still unambiguous.
create unique index match_decisions_live_uniq
  on public.match_decisions (probe_file_id, candidate_file_id)
  where superseded_at is null;
create index match_decisions_band_idx
  on public.match_decisions (band, decided_at desc) where superseded_at is null;
create index match_decisions_probe_idx on public.match_decisions (probe_file_id);

-- ============================================================
-- review_actions -- the HUMAN's answers to the 0.70-0.90 band, kept
-- separate so match_decisions stays append-only and a re-run of the matcher
-- can never overwrite a person's verdict.
--
-- This IS the review-queue surface. M4.7 builds its UI by joining
-- match_decisions (band = 'probable', superseded_at is null) left of this
-- table: a decision with no row here is still pending, one with a row is
-- answered. There is no separate queue table and no queue state column,
-- because either would be a second source of truth for "has a person
-- looked at this yet".
-- ============================================================
create table public.review_actions (
  decision_id bigint primary key references public.match_decisions(id) on delete cascade,
  verdict     text not null check (verdict in ('same','different','version')),
  decided_by  uuid not null references public.members(user_id),
  decided_at  timestamptz not null default now(),
  note        text
);
alter table public.review_actions enable row level security;

-- ============================================================
-- dedup_negatives -- "these two files are NOT the same recording".
--
-- Keyed on the FILE pair, ordered lo < hi, NOT on (probe, candidate_track).
-- Track identity is exactly what merges and undos move around: a negative
-- recorded against a track id survives a merge and then suppresses the
-- wrong comparison. File ids never move. The ordering CHECK gives the pair
-- one spelling so the primary key does the deduplication.
--
-- This is where the "Feeling For You" pair ends up if the scorer puts it in
-- the review band and the owner answers "different" -- and it is why that
-- answer only has to be given once.
-- ============================================================
create table public.dedup_negatives (
  file_lo    uuid not null references public.files(id) on delete cascade,
  file_hi    uuid not null references public.files(id) on delete cascade,
  decided_by uuid not null references public.members(user_id),
  decided_at timestamptz not null default now(),
  primary key (file_lo, file_hi),
  constraint negatives_ordered check (file_lo < file_hi)
);
alter table public.dedup_negatives enable row level security;

-- ============================================================
-- track_merges -- the merge log carries its own undo payload.
--
-- PRD §6. Everything needed to restore the prior state is HERE, not
-- reconstructed later from the current shape of the data:
--   moved_file_ids          which files were re-pointed
--   prior_track_id_by_file  what each one pointed at before
--   prior_preferred_file_id the winner's preferred file before the merge
--   reclaimed_file_ids      which files this merge demoted to
--                           rejected_redundant (undo restores their state,
--                           NOT their bytes -- see undo_merge in 23)
--
-- The last five columns are the pool-ux carry (plan amendment 1, migrations
-- 15b and 16): counts and tags belong to the track identity, not the
-- encode, so the merge folds them onto the survivor and the undo has to be
-- able to split them apart again exactly as they were.
--   sink_file_id            the survivor's file the fold landed on
--   prior_download_counts   {file_id: count} for the sink and every moved
--                           file, BEFORE the sum
--   prior_file_tags         every file_tags row on the moved files, whole,
--                           BEFORE the union
--   folded_tag_keys         the tag_keys this merge newly created on the
--                           sink (so undo deletes exactly those and no
--                           tag the survivor already had)
--   added_claim_user_ids    the claims unioned onto the sink. AUDIT ONLY --
--                           undo does NOT remove them. The upload really
--                           did happen and PRD §10 says contributed never
--                           decreases.
-- ============================================================
create table public.track_merges (
  id                      bigserial primary key,
  loser_track_id          uuid not null references public.tracks(id),
  winner_track_id         uuid not null references public.tracks(id),
  decision_id             bigint references public.match_decisions(id),
  performed_by            text not null,        -- 'auto' or a member uuid as text
  performed_at            timestamptz not null default now(),
  moved_file_ids          uuid[] not null default '{}',
  prior_track_id_by_file  jsonb  not null default '{}'::jsonb,
  prior_preferred_file_id uuid,
  reclaimed_file_ids      uuid[] not null default '{}',
  sink_file_id            uuid,
  prior_download_counts   jsonb  not null default '{}'::jsonb,
  prior_file_tags         jsonb  not null default '[]'::jsonb,
  folded_tag_keys         text[] not null default '{}',
  added_claim_user_ids    uuid[] not null default '{}',
  undone_at               timestamptz,
  undone_by               uuid references public.members(user_id),
  constraint no_self_merge_event check (loser_track_id <> winner_track_id)
);
alter table public.track_merges enable row level security;
create index track_merges_recent_idx on public.track_merges (performed_at desc);
create index track_merges_live_idx on public.track_merges (winner_track_id, loser_track_id)
  where undone_at is null;

-- ============================================================
-- dedup_config -- the thresholds, as DATA.
--
-- PRD §6, verbatim: "These numbers are AcoustID's constants adjusted by
-- judgement, not evidence from your library." Held in code they would need
-- a deploy to change, and a threshold change would silently rewrite the
-- meaning of every past decision. Held here, calibration is an UPDATE and
-- every decision keeps a copy of what it used.
--
-- Keyed on algo_version because a fingerprint from a different chromaprint
-- build is not comparable and its thresholds are not transferable. The
-- image pins fpcalc 1.6.0 by sha256 for exactly this reason.
-- ============================================================
create table public.dedup_config (
  algo_version text primary key,
  t_same       real not null,
  t_probable   real not null,
  t_related    real not null,
  gin_mask     int  not null,
  duration_gate_s int not null,
  candidate_limit int not null,
  source       text not null,
  updated_at   timestamptz not null default now(),
  constraint bands_ordered check (t_same > t_probable and t_probable > t_related)
);
alter table public.dedup_config enable row level security;

insert into public.dedup_config
  (algo_version, t_same, t_probable, t_related, gin_mask,
   duration_gate_s, candidate_limit, source)
values
  ('cp-1.6.0/test2/11025', 0.90, 0.70, 0.40, 12, 10, 25,
   'PRD §6 constants — NOT calibrated');

-- ============================================================
-- dedup_near_misses -- the vinyl-drift tripwire, as a view.
--
-- PRD §6 accepts that vinyl rips at a different playback speed will never
-- match, and PRD §15 names the signal that would justify revisiting it:
-- near-miss pairs clustering in the 0.40-0.70 band with a 1-3% duration
-- delta. That signature IS speed drift. Every such pair is already a
-- match_decisions row; the only thing missing is the delta as a
-- percentage, which is one expression. A separate table would be the same
-- facts written twice.
--
-- The view is NOT security_invoker, so it reads audio_analysis as its owner
-- (postgres). That matters: migration 20 replaced audio_analysis's
-- table-level SELECT for authenticated with a COLUMN grant that omits
-- raw_tags. Nothing here selects raw_tags, and no client role can reach
-- this view at all -- the revoke below leaves it service_role only.
-- ============================================================
create or replace view public.dedup_near_misses as
select d.id, d.probe_file_id, d.candidate_file_id, d.score,
       d.duration_delta_ms, d.decided_at,
       case when coalesce(a.duration_ms, 0) > 0
            then round((d.duration_delta_ms::numeric / a.duration_ms) * 100, 3)
       end as duration_delta_pct
  from public.match_decisions d
  join public.audio_analysis a on a.file_id = d.probe_file_id
 where d.band = 'related' and d.superseded_at is null;
revoke all on public.dedup_near_misses from public, anon, authenticated;
grant select on public.dedup_near_misses to service_role;

-- ============================================================
-- Candidate-retrieval indexes.
--
-- The INDEXES only. dedup_candidates() and its four gates are Task 4's;
-- these are here because they are storage, they are what makes that query
-- possible at all, and the opclass choice below is a decision that should
-- be recorded once rather than rediscovered.
--
-- array_ops, NOT gin__int_ops. PRD §6 writes `gin (query_items
-- gin__int_ops)`, but gin__int_ops belongs to the intarray extension and
-- accepts int4[] only -- the shipped column is bigint[] and the create
-- would fail outright.
--
-- The masked items are all < 2^20 and WOULD fit int4: the bigint[] choice
-- in migration 09 was made for the RAW fingerprint values, which M3 Task 4
-- measured above 2^31 (fpcalc 1.6.0 emits them unsigned). Reaching intarray
-- from here would mean a second, generated int4[] column -- the same data
-- written twice to win a constant factor on a table of two thousand rows.
-- PRD §6 forbids exactly that class of optimisation, and array_ops supports
-- && on any array type.
--
-- TRIPWIRE: if the pool ever passes ~100k fingerprints AND the candidate
-- query stops being sub-10ms, revisit -- in that order. Not before.
-- ============================================================
create index if not exists fingerprints_qi_gin
  on public.fingerprints using gin (query_items array_ops);
create index if not exists fingerprints_dur_idx
  on public.fingerprints (duration_s);

-- ------------------------------------------------------------
-- dedup_seed_tracks -- one track per stored file that has none.
--
-- THE BACKFILL, AS A FUNCTION rather than a bare statement in this file.
-- Two reasons, and the second is the important one:
--
--  1. New files keep arriving. A statement that runs once at migration time
--     leaves every later 'stored' file identity-less until the matcher
--     happens to touch it; a function is something the hourly job and
--     Task 5's matcher can both call.
--  2. It is the assertion that the "Feeling For You" pair stays two tracks.
--     Seeding mints ONE track PER FILE and calls nothing else -- no
--     scoring, no merge_tracks, no track_merges row. Two files that a
--     matcher might one day confuse are two separate identities the moment
--     they are stored, and it takes a deliberate, recorded, reversible
--     merge to make them one. The default outcome is "distinct", which is
--     the outcome PRD §3 wants for an original and its remix.
--
-- 'stored' only. A file that never finished analysing has no fingerprint,
-- so minting an identity for it would create a track that can never be
-- compared to anything. Those get their track when they reach 'stored'.
-- (Checked against hosted 2026-07-29: 527 stored, 54 received, 8
-- analysing -- and BOTH "Feeling For You" files are in 'received', so the
-- initial backfill does not even reach them.)
--
-- p_limit caps one call so a first run over a large pool is chunked rather
-- than one long transaction.
-- ------------------------------------------------------------
create or replace function public.dedup_seed_tracks(p_limit int default 1000)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  with due as (
    select f.id from public.files f
     where f.state = 'stored' and f.track_id is null
     order by f.created_at
     limit greatest(coalesce(p_limit, 1000), 0)
  ), minted as (
    insert into public.tracks (preferred_file_id)
    select d.id from due d
    returning id, preferred_file_id
  ), assigned as (
    update public.files f set track_id = m.id
      from minted m where m.preferred_file_id = f.id
    returning f.id
  )
  select count(*)::int into v_n from assigned;
  return v_n;
end $$;
revoke execute on function public.dedup_seed_tracks(int)
  from public, anon, authenticated;
grant  execute on function public.dedup_seed_tracks(int) to service_role;

-- Discharge it once, here, for everything already in the pool.
select public.dedup_seed_tracks(100000);

-- ------------------------------------------------------------
-- analysis_requeue -- reopen stored files for re-analysis.
--
-- Needed because M4 Task 1 changed what an analysis PRODUCES (forensics,
-- content_sha256), and the only way to fill those on an existing row is to
-- run the container again. analysis_begin() accepts 'received' and
-- 'analysing' only, so a 'stored' file is unreachable without this.
--
-- stored -> 'received', not straight to 'analysing': 'received' is the
-- state that MEANS "needs analysis", and the maintenance Worker's existing
-- :31 cron already re-enqueues anything sitting in it. No new producer, no
-- new queue, no new cron.
--
-- The cost of a requeue is real -- about 45 vCPU-s per file -- and the file
-- leaves pool_list() (which filters state = 'stored') until it returns.
-- p_file_ids is explicit, never a predicate: "requeue everything" is one
-- typo away from re-analysing the whole pool.
-- ------------------------------------------------------------
create or replace function public.analysis_requeue(p_file_ids uuid[])
returns table (file_id uuid, r2_key text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(array_length(p_file_ids, 1), 0) = 0 then
    return;
  end if;
  if array_length(p_file_ids, 1) > 500 then
    raise exception 'analysis_requeue: refusing % files in one call', array_length(p_file_ids, 1)
      using errcode = '22023';
  end if;
  -- The UPDATE sits in a CTE rather than directly after RETURN QUERY:
  -- plpgsql accepts a data-modifying statement there only as a CTE, and the
  -- CTE form also keeps the RETURNING column names from colliding with the
  -- RETURNS TABLE output parameters of the same name.
  return query
    with requeued as (
      update public.files f
         set state = 'received', state_changed_at = now()
       where f.id = any (p_file_ids) and f.state = 'stored'
      returning f.id, f.r2_key
    )
    select r.id, r.r2_key from requeued r;
end $$;
revoke execute on function public.analysis_requeue(uuid[]) from public, anon, authenticated;
grant  execute on function public.analysis_requeue(uuid[]) to service_role;

-- ============================================================
-- REVOKE FIRST. Not belt-and-braces.
--
-- A hosted Supabase project ships an ALTER DEFAULT PRIVILEGES granting
-- anon, authenticated AND service_role arwdDxtm on every new table in
-- public. `supabase start` locally does not. Verified 2026-07-29 by
-- diffing pg_class.relacl on both. A bare `grant select` below would
-- therefore be a NO-OP against production, and the real ACL there would be
-- "everything", with RLS as the only thing standing between a member and a
-- forged merge event. Migrations 09 and 10 carry the same note; this is the
-- fifth time it would have bitten.
--
-- The same default covers SEQUENCES, so the two bigserials get the same
-- treatment -- an authenticated role holding UPDATE on a sequence can
-- advance it, which is not a hole but is not intended either.
-- ============================================================
revoke all on public.tracks, public.track_relations, public.match_decisions,
              public.review_actions, public.dedup_negatives,
              public.track_merges, public.dedup_config
  from public, anon, authenticated;
revoke all on sequence public.match_decisions_id_seq, public.track_merges_id_seq
  from public, anon, authenticated;

grant select on public.tracks, public.track_relations, public.match_decisions,
                public.review_actions, public.dedup_negatives,
                public.track_merges, public.dedup_config
  to authenticated;
grant select, insert, update, delete
   on public.tracks, public.track_relations, public.match_decisions,
      public.review_actions, public.dedup_negatives,
      public.track_merges, public.dedup_config
  to service_role;
grant usage, select on sequence public.match_decisions_id_seq to service_role;
grant usage, select on sequence public.track_merges_id_seq to service_role;

-- Read policies only. Every mutation is a definer function -- merge_tracks
-- and undo_merge in migration 23, dedup_resolve in Task 6's.
-- Note what each policy references: NEVER its own table (42P17).
create policy "members read tracks" on public.tracks
  for select to authenticated using ( (select public.is_active_member()) );
create policy "members read relations" on public.track_relations
  for select to authenticated using ( (select public.is_active_member()) );
create policy "members read decisions" on public.match_decisions
  for select to authenticated using ( (select public.is_active_member()) );
create policy "members read review actions" on public.review_actions
  for select to authenticated using ( (select public.is_active_member()) );
create policy "members read negatives" on public.dedup_negatives
  for select to authenticated using ( (select public.is_active_member()) );
create policy "members read merges" on public.track_merges
  for select to authenticated using ( (select public.is_active_member()) );
create policy "members read thresholds" on public.dedup_config
  for select to authenticated using ( (select public.is_active_member()) );
