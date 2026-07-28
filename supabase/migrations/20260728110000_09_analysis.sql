-- supabase/migrations/20260728110000_09_analysis.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- Where the analysis container's answer lands, and the four service_role
-- entry points the queue consumer (workers/analysis/) drives it through.
--
-- The filename is pinned by M5's plan (docs/superpowers/plans/
-- 2026-07-28-05-pool-ui.md, "Prerequisites"): M5's migration 10 re-declares
-- the artifact-key columns, the SELECT policy and the grants below with
-- `if not exists` / `drop policy if exists`, so whichever milestone lands
-- first wins and the other is a no-op. Landing this one first is the
-- preferred order, and this file is what makes M5's copies redundant.

-- ============================================================
-- Tables
-- ============================================================

create table public.audio_analysis (
  file_id          uuid primary key references public.files(id) on delete cascade,
  analysis_version text not null,
  duration_ms      int,

  -- Beats. bpm is the least-squares fit over beat index; bpm_median_ibi is
  -- the naive number kept only so the two can be compared (M3 Task 3
  -- measured 128.000 vs 130.43 on the same track). Never display the median.
  bpm              real,
  bpm_median_ibi   real,
  beat_grid        real[],
  downbeat_grid    real[],
  ibi_std_ms       real,
  beat_confidence  real,

  -- Key. key_camelot is the one the UI sorts on; key_musical is the human
  -- reading ('C minor') and key_scale the machine-readable half of it.
  -- key_alt_profiles holds the other two Essentia profiles Task 5 found are
  -- computed in the same run (temperley, krumhansl) as camelot codes.
  key_camelot      text,
  key_open         text,
  key_musical      text,
  key_scale        text check (key_scale is null or key_scale in ('major','minor')),
  key_strength     real,
  key_alt_profiles jsonb,

  integrated_lufs  real,
  lra_lu           real,
  true_peak_dbtp   real,
  replaygain_db    real,
  clipped_pct      real,

  -- Forensics. ALL NULL today and that is not a bug: the container measures
  -- cutoff and cliff and logs them, but nothing in worker/app/ produces
  -- hf_ref_delta_db or a measured effective bit depth, so classify_ancestor
  -- has no input and AnalyzeResponse.forensics is None. A tier must never be
  -- synthesised from a container's DECLARED bit depth — that is precisely
  -- the lie the forensics pass exists to catch.
  meas_cutoff_hz   int,
  meas_cliff_db    real,
  lossy_ancestor   text check (lossy_ancestor is null or
                     lossy_ancestor in ('none','suspected','confirmed','abstain')),
  quality_tier     smallint check (quality_tier is null or quality_tier between 1 and 5),
  quality_score    real,

  raw_tags         jsonb not null default '{}'::jsonb,

  -- Basenames inside derived/<file_id>/ in R2, written by the Durable
  -- Object in workers/analysis/src/index.ts. NULL means the object was
  -- never written — either the container produced none (an mp3 gets no
  -- preview, most files have no cover art) or the DO skipped it because its
  -- Content-Length was missing or over the per-artifact ceiling. Either way
  -- a NULL here and a missing object always agree: the DO nulls the key in
  -- the same pass it records artifact_skipped.
  preview_key      text,
  peaks_key        text,
  artwork_key      text,

  cpu_seconds      real,
  analyzed_at      timestamptz not null default now()
);

-- The plan's draft also carried `unique (file_id, analysis_version)`. It is
-- deliberately NOT here: file_id is already the PRIMARY KEY, so that index
-- could never reject a row the primary key does not reject first, and a
-- second unique index costs a write on every upsert for nothing. The
-- idempotency contract "(file_id, analysis_version) inserts at most one row"
-- is satisfied strictly more strongly by the primary key alone.
-- Consequence for future callers: `on conflict (file_id, analysis_version)`
-- has no constraint to match and will raise 42P10 — use
-- `on conflict (file_id)`, as analysis_persist() below does.
create index audio_analysis_track_idx on public.audio_analysis (quality_score desc);

alter table public.audio_analysis enable row level security;

comment on column public.audio_analysis.preview_key is
  'Basename of the Opus preview inside derived/<file_id>/. NULL means no
   preview exists and the player must stream the original -- which is the
   correct behaviour for an mp3 and the fallback behaviour for a FLAC.';
comment on column public.audio_analysis.peaks_key is
  'Basename of the peaks JSON inside derived/<file_id>/. NULL means the
   waveform renders flat. Immutable per file, so it is served with a
   one-year cache-control.';
comment on column public.audio_analysis.clipped_pct is
  'A clipping SUSPICION signal derived from how often the absolute peak
   recurs, not a literal count of clipped samples: ffmpeg 8 astats has no
   clipped-samples field at all (M3 Task 6). Measured ~1% on clean material
   and ~33% on clipped. Threshold on it; never print it as a percentage.';

-- ------------------------------------------------------------
-- Chromaprint output. Raw only: no dedupe index, no calibration, no
-- candidate query. M4 owns all of that and will add whatever index its
-- retrieval needs on top of these columns.
--
-- It exists NOW because the fingerprint is computed inside the same
-- ~52 vCPU-s /analyze call as everything else. Dropping it on the floor
-- would mean re-running the entire analysis of every track in the pool to
-- get it back — the fingerprint is not the expensive part, but it is only
-- reachable by paying for the expensive part again.
--
-- query_items is bigint[], NOT int[]. fpcalc 1.6.0 emits UNSIGNED 32-bit
-- integers and M3 Task 4 measured real values above 2^31 on the first
-- fixture it tried; int4 would overflow on a routine track.
--
-- RLS is on with NO policy and no grant to `authenticated`, on purpose.
-- That is not the M1 dead-policy bug in disguise: there is no policy here
-- because nothing in any UI reads a fingerprint. Contrast audio_analysis
-- below, which has both a policy AND the base grant a policy needs to be
-- anything other than dead code.
-- ------------------------------------------------------------
create table public.fingerprints (
  file_id           uuid primary key references public.files(id) on delete cascade,
  algo_version      text not null,
  duration_s        int,
  frame_count       int,
  fp_compressed_b64 text not null,
  fp_sha256         text not null,
  query_items       bigint[] not null default '{}'::bigint[],
  created_at        timestamptz not null default now()
);
alter table public.fingerprints enable row level security;
create index fingerprints_algo_idx on public.fingerprints (algo_version);

comment on column public.fingerprints.algo_version is
  'Derived at runtime by the container as cp-<fpcalc version>/<algorithm>/
   <sample rate>, e.g. cp-1.6.0/test2/11025. It is the recompute key: two
   fingerprints with different algo_versions are not comparable, which is
   why the container image pins fpcalc 1.6.0 by sha256 rather than taking
   whatever apt ships.';

-- ============================================================
-- RLS + BASE GRANTS.
--
-- The grant is not optional. RLS filters rows only AFTER the table-level
-- ACL check passes, and Supabase gives authenticated no DML on a new table,
-- so a policy without a grant is dead code and every read raises 42501
-- "permission denied for table". Migrations 01 and 06 carry the same
-- warning; this is the third time it would have bitten.
--
-- The policy reads public.files, NOT public.audio_analysis -- a policy on X
-- that selects from X raises 42P17. Referencing files is the point: files'
-- own RLS runs inside this subquery, so an analysis row is visible exactly
-- when its file is, and the visibility rule has exactly one definition.
-- ============================================================

drop policy if exists "members read analysis for visible files" on public.audio_analysis;
create policy "members read analysis for visible files"
  on public.audio_analysis for select to authenticated
  using (
    (select public.is_active_member())
    and exists (select 1 from public.files f where f.id = audio_analysis.file_id)
  );

-- REVOKE FIRST, and this is not belt-and-braces.
--
-- A hosted Supabase project ships an ALTER DEFAULT PRIVILEGES that grants
-- anon, authenticated AND service_role every privilege (arwdDxtm) on every
-- new table in public. `supabase start` locally does not. Verified on
-- 2026-07-29 by comparing pg_class.relacl on both: hosted showed
-- `authenticated=arwdDxtm` on files, audio_analysis and fingerprints, local
-- showed `authenticated=rDxtm` / `Dxtm`.
--
-- So a bare `grant select` below would be a no-op against production and the
-- real ACL there would be "everything", with RLS as the only thing standing
-- between a member and an UPDATE. RLS does hold that line -- there is no
-- permissive policy for insert, update or delete on either table, and RLS
-- default-denies what no policy allows -- but "the ACL says all privileges
-- and we rely entirely on RLS" is not what the two migrations before this
-- one believed they were writing. Revoking first makes the grant below mean
-- the same thing on both databases.
--
-- NOTE FOR A FOLLOW-UP: files, upload_batches, file_claims and ingest_jobs
-- (migration 06) have the same open ACL in production for the same reason.
-- Narrowing those is M2 surface and is deliberately not done here.
revoke all on public.audio_analysis from anon, authenticated;
revoke all on public.fingerprints   from anon, authenticated;

grant select on public.audio_analysis to authenticated;
grant select, insert, update, delete on public.audio_analysis to service_role;
grant select, insert, update, delete on public.fingerprints   to service_role;

-- ============================================================
-- jsonb -> array helpers.
--
-- Granted to nobody, like ingest_set_state() in migration 07: they are
-- reached only from the SECURITY DEFINER function below, which runs as its
-- owner (postgres) and therefore passes its own EXECUTE check. Postgres
-- grants EXECUTE to PUBLIC by default on every new function, so the REVOKE
-- is what makes that true.
--
-- An empty JSON array becomes '{}', never NULL: array_agg over zero rows
-- returns NULL, and "no beats were found" and "beats were never computed"
-- are different facts. A degraded analysis (M3 Task 3: fewer than two
-- beats, bpm 0, confidence 0) is a legal result that must be stored as
-- itself, not as an absence.
-- ============================================================

create or replace function public.jsonb_real_array(p jsonb)
returns real[] language sql immutable set search_path = '' as $$
  select case
    when p is null or jsonb_typeof(p) <> 'array' then null
    else coalesce((select array_agg(v::real order by ord)
                     from jsonb_array_elements_text(p) with ordinality as t(v, ord)),
                  '{}'::real[])
  end;
$$;
revoke execute on function public.jsonb_real_array(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.jsonb_bigint_array(p jsonb)
returns bigint[] language sql immutable set search_path = '' as $$
  select case
    when p is null or jsonb_typeof(p) <> 'array' then null
    else coalesce((select array_agg(v::bigint order by ord)
                     from jsonb_array_elements_text(p) with ordinality as t(v, ord)),
                  '{}'::bigint[])
  end;
$$;
revoke execute on function public.jsonb_bigint_array(jsonb)
  from public, anon, authenticated, service_role;

-- ============================================================
-- The four service_role entry points.
--
-- All SECURITY DEFINER, all revoked from every client role and granted to
-- service_role alone. The consumer in workers/analysis/ is route-less and
-- has no user session, exactly like the maintenance Worker's sweeper -- it
-- is the same exception, for the same reason, and it is the ONLY caller.
-- ============================================================

-- ------------------------------------------------------------
-- Claim a file for analysis.
--
-- Returns the file's state AFTER the call. The consumer proceeds only on
-- 'analysing'; anything else means somebody else already finished this file
-- or the state machine moved it somewhere terminal, and the message should
-- be acked rather than retried.
--
-- 'analysing' is accepted as a SOURCE state on purpose: Queues is
-- at-least-once, and the stuck-job cron re-enqueues rows that are already
-- 'analysing' by definition. A replay must be a no-op, not an error.
-- ------------------------------------------------------------
create or replace function public.analysis_begin(p_file_id uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  select f.state into v_state from public.files f where f.id = p_file_id;
  if v_state is null then
    raise exception 'unknown file %', p_file_id using errcode = 'P0002';
  end if;
  if v_state in ('received','analysing') then
    return public.ingest_set_state(p_file_id, array['received','analysing'], 'analysing');
  end if;
  return v_state;
end $$;
revoke execute on function public.analysis_begin(uuid) from public, anon, authenticated;
grant  execute on function public.analysis_begin(uuid) to service_role;

-- ------------------------------------------------------------
-- Store one AnalyzeResponse and move the file to 'stored'.
--
-- Takes the whole response as jsonb rather than thirty parameters. The
-- container's schema is worker/app/models.py and it will grow; a positional
-- signature would have to be migrated in lockstep with it, and a missing
-- field would land silently in the wrong column.
--
-- IDEMPOTENT. Queues is at-least-once, so this WILL be called twice for the
-- same file. `on conflict (file_id) do update` makes the second call
-- overwrite with identical values instead of raising, and 'stored' is
-- accepted as a source state so the transition is a no-op the second time.
--
-- A DEGRADED result is a normal result. bpm = 0 with confidence = 0 is what
-- M3 Task 3 returns for ambient or near-silent material; forensics = null is
-- what every track returns today. Both are stored as themselves. Neither is
-- a failure, and nothing here invents a quality tier to fill the hole.
-- ------------------------------------------------------------
create or replace function public.analysis_persist(p_result jsonb)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_file_id uuid;
  v_version text;
  v_beats   jsonb;
  v_key     jsonb;
  v_loud    jsonb;
  v_for     jsonb;
  v_fp      jsonb;
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'analysis_persist: payload must be a json object'
      using errcode = '22023';
  end if;
  -- A failed analysis has no row to write. analysis_fail() is its path, and
  -- routing it here instead would leave a half-empty row behind claiming the
  -- track was analysed.
  if coalesce((p_result ->> 'ok')::boolean, false) is not true then
    raise exception 'analysis_persist: refusing to store a failed analysis (ok is not true)'
      using errcode = '22023';
  end if;

  v_file_id := (p_result ->> 'file_id')::uuid;
  v_version := p_result ->> 'analysis_version';
  if v_file_id is null or coalesce(v_version, '') = '' then
    raise exception 'analysis_persist: file_id and analysis_version are required'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.files f where f.id = v_file_id) then
    raise exception 'unknown file %', v_file_id using errcode = 'P0002';
  end if;

  -- JSON null and SQL NULL are different values: `p_result -> 'beats'` on a
  -- null member yields the jsonb scalar 'null', which is not NULL and whose
  -- ->> lookups all return NULL anyway -- but nullif keeps the intent
  -- readable and makes the `is null` tests below mean what they say.
  v_beats := nullif(p_result -> 'beats',       'null'::jsonb);
  v_key   := nullif(p_result -> 'key',         'null'::jsonb);
  v_loud  := nullif(p_result -> 'loudness',    'null'::jsonb);
  v_for   := nullif(p_result -> 'forensics',   'null'::jsonb);
  v_fp    := nullif(p_result -> 'fingerprint', 'null'::jsonb);

  insert into public.audio_analysis as a (
    file_id, analysis_version, duration_ms,
    bpm, bpm_median_ibi, beat_grid, downbeat_grid, ibi_std_ms, beat_confidence,
    key_camelot, key_open, key_musical, key_scale, key_strength, key_alt_profiles,
    integrated_lufs, lra_lu, true_peak_dbtp, replaygain_db, clipped_pct,
    meas_cutoff_hz, meas_cliff_db, lossy_ancestor, quality_tier, quality_score,
    raw_tags, preview_key, peaks_key, artwork_key, cpu_seconds, analyzed_at
  ) values (
    v_file_id,
    v_version,
    (p_result ->> 'duration_ms')::int,

    (v_beats ->> 'bpm')::real,
    (v_beats ->> 'bpm_median_ibi')::real,
    public.jsonb_real_array(v_beats -> 'beat_grid'),
    public.jsonb_real_array(v_beats -> 'downbeat_grid'),
    (v_beats ->> 'ibi_std_ms')::real,
    (v_beats ->> 'confidence')::real,

    v_key ->> 'camelot',
    v_key ->> 'open_key',
    -- 'C' + 'minor' -> 'C minor'. Composed here rather than in the consumer
    -- so every writer of this table spells it the same way.
    case when v_key is null then null
         else btrim(concat_ws(' ', v_key ->> 'key', v_key ->> 'scale')) end,
    v_key ->> 'scale',
    (v_key ->> 'strength')::real,
    nullif(v_key -> 'alt_profiles', 'null'::jsonb),

    (v_loud ->> 'integrated_lufs')::real,
    (v_loud ->> 'lra_lu')::real,
    (v_loud ->> 'true_peak_dbtp')::real,
    (v_loud ->> 'replaygain_db')::real,
    (v_loud ->> 'clipped_pct')::real,

    (v_for ->> 'meas_cutoff_hz')::int,
    (v_for ->> 'meas_cliff_db_500')::real,
    v_for ->> 'lossy_ancestor',
    (v_for ->> 'tier')::smallint,
    (v_for ->> 'quality_score')::real,

    coalesce(nullif(p_result -> 'tags', 'null'::jsonb), '{}'::jsonb),
    p_result ->> 'preview_key',
    p_result ->> 'peaks_key',
    p_result ->> 'artwork_key',
    (p_result ->> 'cpu_seconds')::real,
    now()
  )
  on conflict (file_id) do update set
    analysis_version = excluded.analysis_version,
    duration_ms      = excluded.duration_ms,
    bpm              = excluded.bpm,
    bpm_median_ibi   = excluded.bpm_median_ibi,
    beat_grid        = excluded.beat_grid,
    downbeat_grid    = excluded.downbeat_grid,
    ibi_std_ms       = excluded.ibi_std_ms,
    beat_confidence  = excluded.beat_confidence,
    key_camelot      = excluded.key_camelot,
    key_open         = excluded.key_open,
    key_musical      = excluded.key_musical,
    key_scale        = excluded.key_scale,
    key_strength     = excluded.key_strength,
    key_alt_profiles = excluded.key_alt_profiles,
    integrated_lufs  = excluded.integrated_lufs,
    lra_lu           = excluded.lra_lu,
    true_peak_dbtp   = excluded.true_peak_dbtp,
    replaygain_db    = excluded.replaygain_db,
    clipped_pct      = excluded.clipped_pct,
    meas_cutoff_hz   = excluded.meas_cutoff_hz,
    meas_cliff_db    = excluded.meas_cliff_db,
    lossy_ancestor   = excluded.lossy_ancestor,
    quality_tier     = excluded.quality_tier,
    quality_score    = excluded.quality_score,
    raw_tags         = excluded.raw_tags,
    preview_key      = excluded.preview_key,
    peaks_key        = excluded.peaks_key,
    artwork_key      = excluded.artwork_key,
    cpu_seconds      = excluded.cpu_seconds,
    analyzed_at      = excluded.analyzed_at
  where a.file_id = excluded.file_id;

  if v_fp is not null and coalesce(v_fp ->> 'fp_compressed_b64', '') <> '' then
    insert into public.fingerprints as g (
      file_id, algo_version, duration_s, frame_count,
      fp_compressed_b64, fp_sha256, query_items
    ) values (
      v_file_id,
      v_fp ->> 'algo_version',
      (v_fp ->> 'duration_s')::int,
      (v_fp ->> 'frame_count')::int,
      v_fp ->> 'fp_compressed_b64',
      v_fp ->> 'fp_sha256',
      coalesce(public.jsonb_bigint_array(v_fp -> 'query_items'), '{}'::bigint[])
    )
    on conflict (file_id) do update set
      algo_version      = excluded.algo_version,
      duration_s        = excluded.duration_s,
      frame_count       = excluded.frame_count,
      fp_compressed_b64 = excluded.fp_compressed_b64,
      fp_sha256         = excluded.fp_sha256,
      query_items       = excluded.query_items
    where g.file_id = excluded.file_id;
  end if;

  -- The decoded truth wins over whatever the uploader's browser guessed.
  -- Every field is coalesced against what is already there so a container
  -- that could not read one (bit_depth is 0 for every lossy codec) never
  -- erases a good value with a zero. quality_score/quality_tier are the
  -- exception: they are copied straight through, NULL included, because a
  -- stale tier is worse than no tier.
  update public.files f set
    duration_ms   = coalesce(nullif((p_result ->> 'duration_ms')::int, 0), f.duration_ms),
    container     = coalesce(nullif(p_result ->> 'container', ''), f.container),
    codec         = coalesce(nullif(p_result ->> 'codec', ''), f.codec),
    sample_rate   = coalesce(nullif((p_result ->> 'sample_rate')::int, 0), f.sample_rate),
    bit_depth     = coalesce(nullif((p_result ->> 'bit_depth')::int, 0), f.bit_depth),
    channels      = coalesce(nullif((p_result ->> 'channels')::int, 0), f.channels::int)::smallint,
    quality_score = (v_for ->> 'quality_score')::real,
    quality_tier  = (v_for ->> 'tier')::smallint
  where f.id = v_file_id;

  return public.ingest_set_state(
    v_file_id, array['received','analysing','stored'], 'stored');
end $$;
revoke execute on function public.analysis_persist(jsonb) from public, anon, authenticated;
grant  execute on function public.analysis_persist(jsonb) to service_role;

-- ------------------------------------------------------------
-- A terminal analysis failure.
--
-- 'failed' is what the M2 state diagram draws for the analysing -> terminal
-- error arrow, and M5's upload UI already labels it. Note the interaction
-- with the maintenance Worker: reconcile.ts's STATES_SAFE_TO_AUTO_DELETE
-- treats failed|abandoned as safe to erase because, in M2, nothing could
-- ever revive them. From this migration onwards a 'failed' row can hold
-- perfectly good bytes whose ANALYSIS failed, so RECONCILE_DELETE_PENDING
-- must stay "false" until that job can tell the two apart.
--
-- 'failed' is also accepted as a source state so a retried failure is a
-- no-op rather than an error.
-- ------------------------------------------------------------
create or replace function public.analysis_fail(p_file_id uuid, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
begin
  update public.ingest_jobs j
     set last_error = left(p_reason, 500),
         attempts   = j.attempts + 1,
         updated_at = now()
   where j.file_id = p_file_id;

  return public.ingest_set_state(
    p_file_id, array['received','analysing','failed'], 'failed');
end $$;
revoke execute on function public.analysis_fail(uuid, text) from public, anon, authenticated;
grant  execute on function public.analysis_fail(uuid, text) to service_role;

-- ------------------------------------------------------------
-- The stuck-job cron's query, run from the maintenance Worker.
--
-- state_changed_at, NEVER created_at. created_at is when the row was minted,
-- BEFORE the bytes moved, so a 40-minute multipart upload would be
-- re-enqueued the instant it entered 'analysing'. Migration 06 added
-- state_changed_at and files_state_changed_idx for exactly this query and
-- says so in a column comment.
--
-- 'received' is in scope as well as 'analysing'. A file reaches 'received'
-- inside ingest_finalize() and is enqueued by the route immediately
-- afterwards; if that enqueue throws, or the row predates the producer
-- existing at all, nothing else would ever pick it up. An hour in
-- 'received' means the send did not happen.
--
-- Read-only: it changes no state. Re-enqueueing is the caller's job, and
-- the state it re-enters is analysis_begin()'s to decide.
-- ------------------------------------------------------------
create or replace function public.analysis_stuck(
  p_older_than interval default interval '1 hour',
  p_limit      int      default 100
) returns table (file_id uuid, r2_key text, state text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.r2_key, f.state
    from public.files f
   where f.state in ('received','analysing')
     and f.state_changed_at < now() - p_older_than
   order by f.state_changed_at
   limit least(greatest(p_limit, 1), 500);
$$;
revoke execute on function public.analysis_stuck(interval, int) from public, anon, authenticated;
grant  execute on function public.analysis_stuck(interval, int) to service_role;

comment on function public.analysis_persist(jsonb) is
  'Stores one worker/app/models.py:AnalyzeResponse and moves the file to
   stored. Idempotent on file_id, so an at-least-once queue redelivery
   overwrites rather than duplicating. Degraded results (bpm 0, forensics
   null) are stored as themselves -- they are data, not failures.';
