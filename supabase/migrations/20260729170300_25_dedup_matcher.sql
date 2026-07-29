-- supabase/migrations/20260729170300_25_dedup_matcher.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M4 Task 5. THE MATCHER GOES LIVE. Four things, in the order they matter:
--
--   1. dedup_config.t_related 0.40 -> 0.60. A guard, applied BEFORE any
--      matcher writes a row.
--   2. audio_analysis gains the six is_upgrade() inputs migration 19 drops.
--   3. analysis_persist() writes them.
--   4. dedup_assign_track() and dedup_resolve() -- the decision layer the
--      queue consumer calls after it has scored its candidates.
--
-- NUMBERING. The plan calls the decision migration "17"; pool-ux consumed
-- labels through 18, M4.1 took 19, PR #16 took 20, rohan/drop-files-bitrate
-- claimed 21, and M4 Tasks 2 and 4 took 22/23/24. This is 25. Trust
-- `ls supabase/migrations/`, never the plan's numbers.

-- ============================================================
-- 1. THE THRESHOLD GUARD. One UPDATE, and it has to come first.
--
-- M4 Task 3 measured the scorer against real production pairs. 1 - BER has
-- a hard FLOOR near 0.5 for unrelated material, because two unrelated
-- 32-bit words differ in about half their bits: two duration-matched,
-- genuinely unrelated pool files read 0.500903 and 0.510038.
--
-- The seeded t_related of 0.40 therefore sits BELOW the floor. Every
-- candidate that clears the GIN and duration gates would band `related`,
-- the `different` band would be unreachable, and dedup_near_misses -- PRD
-- §15's vinyl-drift tripwire -- would fill with ordinary non-matches on the
-- first sweep and stop being a signal. A tripwire that is always tripped is
-- not a tripwire.
--
-- 0.60 clears the measured floor with room, and leaves the one real edit
-- pair in the pool ("Feeling For You", 0.666096) just above it in `related`
-- -- which is the correct answer for an edit and its original.
--
-- THIS IS A GUESS WITH TWO DATA POINTS UNDER IT, not a calibration. M4.8
-- owns the real one: run the full N x N over the pool, look at the
-- distribution, and set all three bands from it. Recorded in `source` so
-- nobody mistakes this for evidence.
--
-- It is an UPDATE and not a deploy because thresholds are data (migration
-- 22's decision, paying off on day one), and every match_decisions row
-- carries a copy of the thresholds it used, so this cannot retroactively
-- rewrite the meaning of a past decision.
-- ============================================================
update public.dedup_config
   set t_related = 0.60,
       source = 'PRD §6 constants; t_related raised 0.40 -> 0.60 by M4 Task 5 '
                'over M4 Task 3''s measured unrelated floor (~0.51). NOT calibrated — M4.8 owns that.',
       updated_at = now()
 where algo_version = 'cp-1.6.0/test2/11025';

-- ============================================================
-- 2. THE SIX MISSING is_upgrade() INPUTS.
--
-- M4 Task 4's concern 2, in full: dedup_is_upgrade() and
-- dedup_quality_score() take TEN inputs. audio_analysis persists four of
-- them (meas_cutoff_hz, lossy_ancestor, quality_tier, quality_score) and
-- drops six on the floor -- they are computed inside the container, fed to
-- quality_score(), and never written down. A caller rebuilding the jsonb
-- from audio_analysis columns therefore scores with six NEUTRAL defaults,
-- which is not what the container computed, and loses the fake-FLAC branch
-- (`lame_disagrees` at no better bandwidth) entirely.
--
-- Three of the six were already on AnalyzeResponse and merely unstored
-- (meas_eff_bit_depth, meas_eff_sample_rate, inferred_source_kbps). The
-- other three were not on the response at all; worker/app/models.py and
-- main.py now carry them, with worker/tests/test_main.py asserting that the
-- reported inputs REPRODUCE the reported score.
--
-- NULLABLE, and every existing row keeps NULL. dedup_is_upgrade() already
-- returns false when either side is NULL -- absence of evidence is not an
-- upgrade -- so a stale row is inert rather than wrong. M4.8 decides
-- whether the pool is worth re-analysing to fill them.
--
-- NO NEW TABLE, so the revoke-first rule that governs migrations 09, 10 and
-- 22 does not apply here. What DOES apply is what these columns are NOT
-- granted: on hosted, migration 20 replaced audio_analysis's table-level
-- SELECT for authenticated with a COLUMN grant (to keep raw_tags out of
-- reach). A column grant does not extend to columns added later, so these
-- six are invisible to `authenticated` on production by construction, which
-- is what we want -- they are matcher inputs, not pool-facing facts, and
-- pool_get() is a definer function that reads as its owner regardless.
-- On a local database built from THIS branch there is no migration 20 yet
-- (it lives on main), so the older table-level grant still covers them
-- there. That divergence closes at the M4 milestone merge and is harmless
-- either way: none of the six is personal data.
-- ============================================================
alter table public.audio_analysis
  add column meas_eff_bit_depth   int,
  add column meas_eff_sample_rate int,
  add column inferred_source_kbps int,
  add column lame_disagrees       boolean,
  add column mono_vs_stereo       boolean,
  add column decode_errors        boolean;

comment on column public.audio_analysis.meas_eff_bit_depth is
  'MEASURED significant bits, not the declared depth. 0 on every lossy file
   on purpose (worker/app/main.py): a lossy decoder emits full-precision
   samples, so the measurement only means something where there is a
   lossless CLAIM to test.';
comment on column public.audio_analysis.inferred_source_kbps is
  'The bitrate the CUTOFF implies, filled only on a suspected/confirmed
   lossy ancestor. NULL means "no lossy ancestor was found", never "0 kbps".';
comment on column public.audio_analysis.lame_disagrees is
  'The LAME tag declares a lowpass more than 1500 Hz from the measured
   cutoff. -6 in quality_score, and dedup_is_upgrade()''s fake-FLAC veto.
   FALSE when there is no tag at all: nothing to disagree with.';
comment on column public.audio_analysis.decode_errors is
  'Always false today -- nothing in the analysis pass error-checks the
   decode, so anything else would be an invention. Stored so the -25 branch
   of quality_score() has a real input the day something does check.';

-- ============================================================
-- 3. analysis_persist(), for those six writes.
--
-- THE BODY BELOW IS MIGRATION 19's, NOT MIGRATION 14's AND NOT 09's.
-- Migration 14 added thumb_key (three places); migration 19 added
-- files.content_sha256 and its collision guard. Starting from either
-- earlier body silently drops the later write and nothing raises. The
-- pgTAP file for this migration asserts BOTH survive, so the mistake fails
-- a test rather than a user's eyes.
--
-- THE FALLBACKS ARE NOT DECORATION. A container image rolls out gradually
-- (see CLAUDE.md), so for some minutes after this migration lands the old
-- image is still answering, with a Forensics object that has no
-- lame_disagrees / mono_vs_stereo / decode_errors. Rather than store NULL
-- for those runs, each one falls back to the container's OWN formula
-- computed from fields the old response already carries:
--   lame_disagrees  |lame_lowpass_hz - meas_cutoff_hz| > 1500
--   mono_vs_stereo  channels < 2
--   decode_errors   false
-- These are the same three expressions worker/app/main.py evaluates. When
-- the new image is live the response supplies them directly and the
-- fallback never fires. It is the same argument dedup_quality_score()
-- makes for existing in SQL at all: one rule, deliberately written twice,
-- with a test on both copies.
-- ============================================================
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
  v_sha     bytea;
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

  -- Decoded ONCE, here, so the guard below and the write below cannot drift
  -- apart. A 64-character lower-case hex digest is the only accepted shape:
  -- anything else is a container this function does not recognise, and a
  -- half-decoded digest in a UNIQUE column is worse than no digest.
  v_sha := case
    when coalesce(p_result ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
      then decode(p_result ->> 'content_sha256', 'hex')
    else null
  end;

  insert into public.audio_analysis as a (
    file_id, analysis_version, duration_ms,
    bpm, bpm_median_ibi, beat_grid, downbeat_grid, ibi_std_ms, beat_confidence,
    key_camelot, key_open, key_musical, key_scale, key_strength, key_alt_profiles,
    integrated_lufs, lra_lu, true_peak_dbtp, replaygain_db, clipped_pct,
    meas_cutoff_hz, meas_cliff_db, lossy_ancestor, quality_tier, quality_score,
    meas_eff_bit_depth, meas_eff_sample_rate, inferred_source_kbps,
    lame_disagrees, mono_vs_stereo, decode_errors,
    raw_tags, preview_key, peaks_key, artwork_key, thumb_key, cpu_seconds, analyzed_at
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

    -- The six. NULL when there is no forensics object at all, because a
    -- degraded analysis has no verdict and inventing `false` would read as
    -- a measurement.
    (v_for ->> 'meas_eff_bit_depth')::int,
    (v_for ->> 'meas_eff_sample_rate')::int,
    (v_for ->> 'inferred_source_kbps')::int,
    case when v_for is null then null else
      coalesce((v_for ->> 'lame_disagrees')::boolean,
               case when (v_for ->> 'lame_lowpass_hz') is not null
                     and (v_for ->> 'meas_cutoff_hz') is not null
                    then abs((v_for ->> 'lame_lowpass_hz')::int
                             - (v_for ->> 'meas_cutoff_hz')::int) > 1500
                    else false end) end,
    case when v_for is null then null else
      coalesce((v_for ->> 'mono_vs_stereo')::boolean,
               coalesce((p_result ->> 'channels')::int, 2) < 2) end,
    case when v_for is null then null else
      coalesce((v_for ->> 'decode_errors')::boolean, false) end,

    coalesce(nullif(p_result -> 'tags', 'null'::jsonb), '{}'::jsonb),
    p_result ->> 'preview_key',
    p_result ->> 'peaks_key',
    p_result ->> 'artwork_key',
    p_result ->> 'thumb_key',
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
    meas_eff_bit_depth   = excluded.meas_eff_bit_depth,
    meas_eff_sample_rate = excluded.meas_eff_sample_rate,
    inferred_source_kbps = excluded.inferred_source_kbps,
    lame_disagrees   = excluded.lame_disagrees,
    mono_vs_stereo   = excluded.mono_vs_stereo,
    decode_errors    = excluded.decode_errors,
    raw_tags         = excluded.raw_tags,
    preview_key      = excluded.preview_key,
    peaks_key        = excluded.peaks_key,
    artwork_key      = excluded.artwork_key,
    thumb_key        = excluded.thumb_key,
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
    quality_tier  = (v_for ->> 'tier')::smallint,
    content_sha256 = case
      when v_sha is null then f.content_sha256
      -- Layer 0 firing. Leave this row's digest NULL and let dedup_resolve()
      -- read the collision off the incumbent, rather than raising 23505 and
      -- throwing away a completed analysis.
      when exists (select 1 from public.files f2
                    where f2.content_sha256 = v_sha and f2.id <> v_file_id)
        then f.content_sha256
      else v_sha
    end
  where f.id = v_file_id;

  return public.ingest_set_state(
    v_file_id, array['received','analysing','stored'], 'stored');
end $$;
revoke execute on function public.analysis_persist(jsonb) from public, anon, authenticated;
grant  execute on function public.analysis_persist(jsonb) to service_role;

-- ============================================================
-- 4a. dedup_assign_track -- one file, one identity, on demand.
--
-- dedup_seed_tracks() (migration 22) mints identities for EVERY trackless
-- stored file, ordered by created_at, up to a limit. That is the right
-- shape for a backfill and the wrong shape for a matcher, which needs an
-- identity for ONE named file and cannot afford to walk a 300-row backlog
-- to get it.
--
-- Same rule as the seeder, deliberately: 'stored' only. A file that never
-- finished analysing has no fingerprint, so an identity for it could never
-- be compared to anything. It returns NULL rather than raising -- a matcher
-- run against a file that moved state underneath it is a race, not an
-- error, and the hourly backstop will find it again.
--
-- Idempotent: an existing track is resolved through canonical_track_id(),
-- so a file whose track has already been merged away answers with the
-- SURVIVOR, never with a dead identity.
-- ============================================================
create or replace function public.dedup_assign_track(p_file_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_track uuid;
  v_state text;
begin
  -- The same lock merge_tracks() takes, so an assignment cannot interleave
  -- with a collapse. Re-entrant within a transaction: dedup_resolve() holds
  -- it around the whole critical section and this is a no-op inside.
  perform pg_advisory_xact_lock(hashtext('localchune.track_assign'));

  select f.track_id, f.state into v_track, v_state
    from public.files f where f.id = p_file_id;
  if v_state is null then
    return null;                        -- the row is gone; not this job's problem
  end if;
  if v_track is not null then
    return public.canonical_track_id(v_track);
  end if;
  if v_state <> 'stored' then
    return null;
  end if;

  insert into public.tracks (preferred_file_id) values (p_file_id)
  returning id into v_track;
  update public.files f set track_id = v_track where f.id = p_file_id;
  return v_track;
end $$;
revoke execute on function public.dedup_assign_track(uuid)
  from public, anon, authenticated;
grant  execute on function public.dedup_assign_track(uuid) to service_role;

-- ============================================================
-- 4b. dedup_probe -- the three fields the scorer needs about the PROBE.
--
-- dedup_candidates() returns everything about the candidates and nothing
-- about the file being matched, because the consumer was assumed to have
-- just computed it. The hourly backstop has not: it works from a file id
-- out of dedup_pending() and needs the blob from the database.
--
-- A function rather than a PostgREST table read on `fingerprints`. The
-- service_role key can read that table either way -- this narrows what the
-- WORKERS' CODE does, not what the key can do (see the correction in
-- workers/analysis/src/supabase.ts) -- but it keeps both Workers on one
-- rpc() helper with one error shape, and it keeps the fingerprint blob out
-- of a URL query string.
--
-- Returns no row rather than raising when the file has no fingerprint. That
-- is the normal state of a degraded analysis, and of the three pool files
-- M4 Task 1 records as failing every re-analysis.
-- ============================================================
create or replace function public.dedup_probe(p_file_id uuid)
returns table (
  fp_compressed_b64 text,
  fp_sha256         text,
  algo_version      text,
  frame_count       int,
  duration_s        int
)
language sql stable security definer set search_path = '' as $$
  select g.fp_compressed_b64, g.fp_sha256, g.algo_version,
         g.frame_count, g.duration_s
    from public.fingerprints g
   where g.file_id = p_file_id;
$$;
revoke execute on function public.dedup_probe(uuid) from public, anon, authenticated;
grant  execute on function public.dedup_probe(uuid) to service_role;

-- ============================================================
-- 4bb. analysis_file_state -- read the claim, without taking it.
--
-- For the dead-letter handler, and it closes a real hole. A message that
-- exhausts localchune-analyze's five attempts lands on the DLQ, whose only
-- job is analysis_fail() so the row stops claiming to be 'analysing' and
-- the :31 cron stops resurrecting it forever ([F5]).
--
-- But Queues is at-least-once and the :31 cron is a second producer, so by
-- the time a dead letter is DELIVERED the file may already have been
-- re-enqueued and be mid-analysis on a healthy delivery. Failing it then
-- marks a working file failed, drops it out of the pool, and the analysis
-- that was about to succeed cannot persist -- analysis_persist() accepts
-- 'received', 'analysing' and 'stored' as source states, and 'failed' is
-- none of them.
--
-- analysis_begin() already knows what a live claim looks like: 'analysing'
-- inside a 10-minute lease. This exposes the same two fields so the handler
-- can ask WITHOUT claiming, because claiming is exactly what it must not do.
-- ============================================================
create or replace function public.analysis_file_state(p_file_id uuid)
returns table (state text, state_changed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.state, f.state_changed_at from public.files f where f.id = p_file_id;
$$;
revoke execute on function public.analysis_file_state(uuid)
  from public, anon, authenticated;
grant  execute on function public.analysis_file_state(uuid) to service_role;

-- ============================================================
-- 4c. dedup_resolve -- the decision layer.
--
-- The consumer does the expensive half OUTSIDE any transaction (fetch the
-- candidates, decompress, sweep 161 offsets each) and hands the scores to
-- this function, which takes the advisory lock and does the cheap half:
-- band every score against dedup_config, write one match_decisions row per
-- candidate, and collapse the ones that cleared t_same.
--
-- WHAT THIS VERSION DOES NOT DO, and Task 6 must add on top with a
-- CREATE OR REPLACE rather than a rewrite: keep-if-better. Nothing here
-- chooses a preferred_file_id, demotes a file to rejected_redundant or
-- reclaims R2 bytes. A merge folds two identities together and keeps every
-- file; the worst outcome of a wrong auto-merge is therefore one undo_merge()
-- call, and no byte is ever deleted by this path. That is a deliberate
-- narrowing for the first production run, not an oversight.
--
-- WHAT IT WRITES FOR EACH BAND:
--   same      a decision row, and ONE merge per distinct losing identity.
--   probable  a decision row, and nothing else. THAT IS THE REVIEW QUEUE:
--             migration 22 made review_actions the human's side and said so
--             -- a `probable` decision with no review_actions row is
--             pending, one with a row is answered. There is no queue table.
--   related   a decision row. dedup_near_misses reads them back; PRD §15's
--             vinyl-drift signature is a CLUSTER in this band with a 1-3%
--             duration delta, which is a question you ask of the log, not
--             an action you take per pair. No track_relations row is
--             written here: at 0.60 the band is still uncalibrated, and
--             filling a curated table from an uncalibrated threshold is how
--             it stops being curated. Task 6/7 own that promotion.
--   different a decision row. It is the only record that the scorer looked
--             and said no, and M4.8 calibrates against exactly these.
--
-- THE SCORES ARE STALE BY CONSTRUCTION and that is the protocol working.
-- They were computed before this lock was taken. What the lock protects is
-- the ASSIGNMENT: every side is re-resolved through canonical_track_id()
-- inside it, so the worst a stale score can do is merge two tracks that a
-- concurrent merge already joined -- which resolves to the same id and is
-- skipped -- or act on a candidate that has since left the pool, which is
-- re-checked below.
--
-- p_scored is the array workers/analysis hands over, camelCase because it
-- is a TypeScript object serialised whole:
--   [{ candidateFileId, candidateTrackId, layer, score, bestOffset,
--      overlapFrames, sharedItems, durationDeltaMs, perSecondBer }]
-- ============================================================
create or replace function public.dedup_resolve(
  p_file_id uuid, p_scored jsonb, p_algo text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cfg        public.dedup_config%rowtype;
  v_thresholds jsonb;
  v_track      uuid;
  v_states     text[] := public.pool_visible_states();
  e            jsonb;
  v_cand       uuid;
  v_score      real;
  v_layer      text;
  v_band       text;
  v_action     text;
  v_decision   bigint;
  v_cand_track uuid;
  v_winner     uuid;
  v_merge      bigint;
  v_merges     bigint[] := '{}';
  v_same_files uuid[]   := '{}';
  v_same_decs  bigint[] := '{}';
  v_i          int;
  v_probe_dec  bigint;
  v_same       int := 0;
  v_probable   int := 0;
  v_related    int := 0;
  v_different  int := 0;
  v_written    int := 0;
  v_skipped    int := 0;
begin
  if p_file_id is null then
    raise exception 'dedup_resolve: p_file_id is required' using errcode = '22023';
  end if;
  if p_scored is null or jsonb_typeof(p_scored) <> 'array' then
    raise exception 'dedup_resolve: p_scored must be a json array' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('localchune.track_assign'));

  select * into v_cfg from public.dedup_config c where c.algo_version = p_algo;
  if v_cfg.algo_version is null then
    -- An algo_version with no config row is a fingerprint build nobody has
    -- calibrated. Refusing is the only safe answer: falling back to another
    -- version's numbers would auto-merge on thresholds that were never
    -- measured against these fingerprints.
    return jsonb_build_object(
      'ok', false, 'action', 'no_config',
      'reason', format('no dedup_config row for algo_version %L', p_algo));
  end if;
  v_thresholds := jsonb_build_object(
    'algo_version', v_cfg.algo_version, 't_same', v_cfg.t_same,
    't_probable', v_cfg.t_probable, 't_related', v_cfg.t_related,
    'duration_gate_s', v_cfg.duration_gate_s, 'candidate_limit', v_cfg.candidate_limit);

  v_track := public.dedup_assign_track(p_file_id);
  if v_track is null then
    return jsonb_build_object(
      'ok', false, 'action', 'not_assignable',
      'reason', format('%s is not a stored file', p_file_id));
  end if;

  -- ---------- one decision row per candidate ----------
  for e in select * from jsonb_array_elements(p_scored)
  loop
    v_cand  := (e ->> 'candidateFileId')::uuid;
    v_score := coalesce((e ->> 'score')::real, 0);
    v_layer := coalesce(e ->> 'layer', 'ber');
    -- match_decisions.layer has a CHECK. An unrecognised value would raise
    -- 23514 and lose the whole batch of decisions over a label, so an
    -- unknown layer is recorded as what it functionally was: a score.
    if v_layer not in ('content_sha256', 'fp_sha256', 'ber') then
      v_layer := 'ber';
    end if;

    -- Re-checked inside the lock, because the candidate list was built
    -- outside it: the file may have been deleted, quarantined or answered
    -- "not a duplicate" by a human in between.
    if v_cand is null or v_cand = p_file_id
       or not exists (select 1 from public.files f
                       where f.id = v_cand and f.state = any (v_states))
       or exists (select 1 from public.dedup_negatives n
                   where n.file_lo = least(p_file_id, v_cand)
                     and n.file_hi = greatest(p_file_id, v_cand))
    then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_band := case
      when v_score >= v_cfg.t_same     then 'same'
      when v_score >= v_cfg.t_probable then 'probable'
      when v_score >= v_cfg.t_related  then 'related'
      else 'different'
    end;
    v_action := case v_band
      when 'same'     then 'merged'
      when 'probable' then 'review_queued'
      when 'related'  then 'near_miss'
      else 'none'
    end;

    -- PRD §6: reprocessing SUPERSEDES rather than duplicating. The partial
    -- unique index is on (probe, candidate) where superseded_at is null, so
    -- this is also what keeps the insert below from raising 23505 on a
    -- re-run.
    update public.match_decisions d
       set superseded_at = now()
     where d.probe_file_id = p_file_id
       and d.candidate_file_id = v_cand
       and d.superseded_at is null;

    insert into public.match_decisions (
      probe_file_id, candidate_file_id, candidate_track_id, algo_version,
      layer, score, band, best_offset_frames, overlap_frames, shared_items,
      duration_delta_ms, per_second_ber, thresholds, action
    ) values (
      p_file_id, v_cand,
      public.canonical_track_id((e ->> 'candidateTrackId')::uuid),
      p_algo, v_layer, v_score, v_band,
      (e ->> 'bestOffset')::int, (e ->> 'overlapFrames')::int,
      (e ->> 'sharedItems')::int, (e ->> 'durationDeltaMs')::int,
      public.jsonb_real_array(e -> 'perSecondBer'),
      v_thresholds, v_action
    ) returning id into v_decision;
    v_written := v_written + 1;

    if v_band = 'same' then
      v_same       := v_same + 1;
      v_same_files := v_same_files || v_cand;
      v_same_decs  := v_same_decs  || v_decision;
    elsif v_band = 'probable' then v_probable  := v_probable + 1;
    elsif v_band = 'related'  then v_related   := v_related + 1;
    else                           v_different := v_different + 1;
    end if;
  end loop;

  -- ---------- collapse, in a second pass ----------
  --
  -- SECOND PASS ON PURPOSE. Choosing the survivor inside the loop above
  -- would make the outcome depend on the order the candidates arrived in:
  -- pick the highest score as you go and a lower-scoring candidate seen
  -- FIRST is silently left behind on its own track, because by the time a
  -- better one replaces it as winner the comparison that would have merged
  -- it has already happened.
  --
  -- The survivor is the OLDEST identity among everything involved, the
  -- probe included. That is the pool's incumbent -- the track other things
  -- may already point at -- and it is a property of the data rather than of
  -- the arrival order, so re-running the matcher on any member of the group
  -- reaches the same answer. Which ENCODE that identity prefers is
  -- keep-if-better's question, and keep-if-better is Task 6.
  if array_length(v_same_files, 1) > 0 then
    -- Assign first, then choose: a candidate with no identity yet cannot
    -- be compared on age, and it must not be skipped either.
    for v_i in 1 .. array_length(v_same_files, 1) loop
      perform public.dedup_assign_track(v_same_files[v_i]);
    end loop;

    -- Ordered by the arrival of the OLDEST FILE on each identity, not by
    -- tracks.created_at: dedup_seed_tracks() minted every existing identity
    -- in ONE statement, so every backfilled track shares a created_at to
    -- the microsecond and that column cannot tell an incumbent from a
    -- newcomer. The upload order can, and is what "already in the pool"
    -- actually means. tracks.created_at and the id are tie-breakers, so the
    -- ordering is total and the answer is reproducible.
    select t.id into v_winner
      from public.tracks t
     where t.id in (
             select public.canonical_track_id(f.track_id)
               from public.files f
              where f.id = any (v_same_files || p_file_id)
                and f.track_id is not null)
     order by (select min(f2.created_at) from public.files f2
                where f2.track_id = t.id),
              t.created_at, t.id
     limit 1;

    -- Every `same` candidate ends on the survivor, not just the best pair:
    -- three copies of one recording is one track, and merging only the top
    -- pair would leave the third orphaned until a later sweep rediscovered
    -- it. The probe is folded in the same loop, through the same function.
    for v_i in 1 .. array_length(v_same_files, 1) loop
      v_cand_track := public.canonical_track_id(
        (select f.track_id from public.files f where f.id = v_same_files[v_i]));
      if v_cand_track is not null
         and v_cand_track is distinct from public.canonical_track_id(v_winner) then
        v_merge  := public.merge_tracks(v_cand_track, v_winner, v_same_decs[v_i], 'auto');
        v_merges := v_merges || v_merge;
      end if;
    end loop;

    v_probe_dec := v_same_decs[1];
    if public.canonical_track_id(v_track)
         is distinct from public.canonical_track_id(v_winner) then
      v_merge  := public.merge_tracks(v_track, v_winner, v_probe_dec, 'auto');
      v_merges := v_merges || v_merge;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', case when v_same > 0 then 'merged'
                   when v_probable > 0 then 'review_queued'
                   else 'no_match' end,
    'track_id', public.canonical_track_id(v_track),
    'decisions', v_written,
    'skipped', v_skipped,
    'merge_ids', to_jsonb(v_merges),
    'bands', jsonb_build_object('same', v_same, 'probable', v_probable,
                                'related', v_related, 'different', v_different),
    'thresholds', v_thresholds);
end $$;
revoke execute on function public.dedup_resolve(uuid, jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.dedup_resolve(uuid, jsonb, text) to service_role;

comment on function public.dedup_resolve(uuid, jsonb, text) is
  'PRD §6 decision layer. Bands every score against dedup_config, writes one
   match_decisions row per candidate (superseding any live row for the same
   pair), and collapses the `same` band through merge_tracks() -- which is
   the ONLY path that ever joins two identities, so every auto-merge has a
   track_merges event and an undo. Does NOT do keep-if-better: no
   preferred_file_id is chosen, no file is demoted and no R2 object is
   reclaimed here. Task 6 adds that with a CREATE OR REPLACE on this body.';

-- PostgREST caches the function signatures it will expose. Without this the
-- consumer''s first call answers PGRST202 until the cache happens to roll.
notify pgrst, 'reload schema';
