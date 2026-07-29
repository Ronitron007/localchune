-- supabase/migrations/20260729170200_24_dedup_retrieval.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M4 Task 4. CANDIDATE RETRIEVAL. Read-only: this migration creates no
-- table, writes no row, and decides nothing. It turns "compare against
-- everything" into "compare against at most 25".
--
-- Plan: docs/superpowers/plans/2026-07-29-04-dedup.md, Task 4. The plan
-- calls this file "migration 16"; pool-ux consumed labels through 18 and
-- M4 Task 2 consumed 22/23, so it lands as 24. Trust the directory
-- listing, never the plan's numbers.
--
-- TWO LAYERS, in the order PRD §6 puts them:
--   layer 0  exact bytes    files.content_sha256 equality. No scoring.
--   layer 1  fingerprint    GIN overlap on query_items + a ±10 s gate.
--
-- Layer 1's four gates, and why each one is here:
--   1. algo_version equality. A cp-1.5.1 fingerprint and a cp-1.6.0
--      fingerprint OF THE SAME AUDIO are different numbers. M3 Task 8
--      caught this in the image build (Debian trixie ships 1.5.1, dev had
--      1.6.0) and pinned fpcalc by sha256 for exactly this reason. Without
--      the gate, a version bump silently scores every old track as
--      unrelated to every new one.
--   2. GIN overlap on query_items, using array_ops (migration 22 built the
--      index; see the note below).
--   3. ±10 s duration gate on fingerprints.duration_s -- fpcalc's OWN
--      decode, never a container header. If any path ever fills that
--      column from tags, this gate silently drops true duplicates with no
--      error and no alert. Migration 06 says the same thing about
--      files.duration_ms.
--   4. dedup_negatives exclusion, so a human's "these are different" is
--      never re-asked.
--
-- Plus the fallback: when the GIN query returns nothing, a duration-only
-- scan capped at 400 rows. PRD §6 calls it "cheap insurance that degrades
-- gracefully" -- it catches a pair whose two query_items windows both
-- landed in differing intros, the known weakness of the two-window scheme.

-- ============================================================
-- Indexes.
--
-- BOTH OF THESE ALREADY EXIST. Migration 22 (M4 Task 2) pulled them
-- forward from this task so its own fixtures had something to hit. They
-- are repeated here, `if not exists`, because the plan names them as this
-- migration's interface and because this file must replay cleanly on a
-- database built from migration 22 onwards.
--
-- READ THIS BEFORE CHANGING EITHER DEFINITION: `create index if not
-- exists` matches on the index NAME only. Handing it a DIFFERENT column
-- list under an existing name is a silent no-op -- the migration reports
-- success and the old index survives. The plan's draft wrote
-- fingerprints_dur_idx as (algo_version, duration_s); migration 22 built
-- it as (duration_s). The single-column form is reproduced here verbatim
-- so the file says what the database actually contains. A composite is
-- not worth adding at 600 fingerprints: see the EXPLAIN discussion in
-- .superpowers/sdd/m4-task-4-report.md, where the planner declines every
-- index on this table because a sequential scan of 600 rows is genuinely
-- cheaper.
--
-- array_ops, NOT gin__int_ops. PRD §6 writes `gin (query_items
-- gin__int_ops)`, but gin__int_ops belongs to the intarray extension and
-- accepts int4[] only -- the shipped column is bigint[] because fpcalc
-- 1.6.0 emits unsigned 32-bit values and M3 Task 4 measured real ones
-- above 2^31. That create would have failed outright.
--
-- TRIPWIRE: if the pool ever passes ~100k fingerprints AND the candidate
-- query stops being sub-10 ms, revisit -- in that order. Not before.
-- ============================================================
create index if not exists fingerprints_qi_gin
  on public.fingerprints using gin (query_items array_ops);
create index if not exists fingerprints_dur_idx
  on public.fingerprints (duration_s);

-- ------------------------------------------------------------
-- |a ∩ b|. There is no built-in array intersection for bigint[] without
-- intarray, and the candidate ranking needs the count.
--
-- INTERSECT deduplicates, so this counts DISTINCT shared items. That is
-- the right definition for a ranking signal: an item repeated in one
-- fingerprint and not the other is not extra evidence.
--
-- Sizes are ~200-400 items per side over at most 400 candidates, so the
-- set-based INTERSECT is the right shape: readable, and index-free work on
-- data already in memory.
--
-- No grant. It is called only from the SECURITY DEFINER functions below,
-- which run as this function's owner, so no client role needs EXECUTE.
-- ------------------------------------------------------------
create or replace function public.qi_overlap(a bigint[], b bigint[])
returns int language sql immutable parallel safe set search_path = '' as $$
  select coalesce((
    select count(*)::int
      from (select unnest(a) intersect select unnest(b)) s), 0);
$$;
revoke execute on function public.qi_overlap(bigint[], bigint[])
  from public, anon, authenticated;

-- ============================================================
-- LAYER 0 -- exact bytes.
--
-- READ THIS BEFORE USING IT. It is not the function the plan imagined.
--
-- files.content_sha256 is declared UNIQUE (migration 06). Migration 19
-- (M4 Task 1) therefore made analysis_persist() do this when a second file
-- arrives carrying a digest that is already taken:
--
--     when exists (select 1 from public.files f2
--                   where f2.content_sha256 = v_sha and f2.id <> v_file_id)
--       then f.content_sha256          -- i.e. leave it NULL
--
-- That is the right call -- raising 23505 would throw away a completed
-- 45 vCPU-s analysis -- but it has a consequence this function has to be
-- built around: TWO BYTE-IDENTICAL FILES NEVER BOTH CARRY THE DIGEST. The
-- incumbent keeps it; the newcomer's row stores NULL, and the newcomer's
-- digest is not written down anywhere. So a self-join on equality can
-- never find a pair. Reading the digest off the probe row returns either
-- a value nobody else holds (no twin) or NULL (twin exists, digest
-- discarded).
--
-- Hence p_content_sha256. The analysis consumer HAS the digest in hand --
-- it is a field of the container's own response, the same value it just
-- handed to analysis_persist() -- so Task 5 passes it explicitly and layer
-- 0 fires. A caller that cannot supply it (the hourly backstop, which
-- works from dedup_pending() and a file id) gets nothing here and falls
-- through to layer 1. That is safe: byte-identical files produce identical
-- fingerprints, so layer 1 retrieves them as its top hit and the scorer
-- reads 1.0. Layer 0 saves a decompress and an offset sweep; it is not
-- load-bearing for correctness.
--
-- dedup_negatives is honoured here too. A human calling two byte-identical
-- files "different" is a contradiction that should never be entered, but
-- "never re-ask" outranks this function's opinion about it.
-- ============================================================
create or replace function public.dedup_exact(
  p_file_id uuid, p_content_sha256 bytea default null
) returns table (
  candidate_file_id  uuid,
  candidate_track_id uuid,
  matched_sha256     bytea
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sha bytea;
begin
  select f.content_sha256 into v_sha from public.files f where f.id = p_file_id;
  -- The caller's digest wins. See the header: the probe's own column is
  -- NULL in precisely the case this function exists to catch.
  v_sha := coalesce(p_content_sha256, v_sha);
  if v_sha is null then
    return;
  end if;

  return query
  select f.id, f.track_id, f.content_sha256
    from public.files f
   where f.content_sha256 = v_sha
     and f.id <> p_file_id                       -- never its own candidate
     and f.state = any (public.pool_visible_states())
     and not exists (
       select 1 from public.dedup_negatives n
        where n.file_lo = least(p_file_id, f.id)
          and n.file_hi = greatest(p_file_id, f.id));
end $$;
revoke execute on function public.dedup_exact(uuid, bytea)
  from public, anon, authenticated;
grant  execute on function public.dedup_exact(uuid, bytea) to service_role;

comment on function public.dedup_exact(uuid, bytea) is
  'PRD §6 layer 0. PASS p_content_sha256: files.content_sha256 is UNIQUE
   and analysis_persist() leaves the second of two byte-identical files
   NULL rather than raising 23505, so the probe row cannot find its own
   twin. The analysis consumer has the digest from the container response.';

-- ============================================================
-- LAYER 1 (and layer 0, folded in) -- the candidate query.
--
-- The caller decompresses at most N fingerprints and runs the offset
-- sweep. Everything expensive stays OUT of this function on purpose: this
-- is the cheap half of the read-compute-verify-write protocol, and
-- dedup_resolve() (Task 6) re-runs it verbatim inside the advisory lock.
--
-- `via` says which layer produced the row: 'sha256', 'gin' or 'duration'.
-- sha256 rows come first and need no scoring at all.
--
-- SIGNATURE NOTE for Task 5 and Task 6: this is dedup_candidates(uuid,
-- int, bytea), not the plan's (uuid, int). The third argument defaults to
-- NULL, so every two-argument call in the plan still resolves -- but a
-- GRANT or REVOKE naming `dedup_candidates(uuid, int)` will raise 42883.
-- Name all three types.
--
-- Every reference is table-qualified. In a plpgsql `returns table` the
-- output columns are variables, so a bare `bpm` or `duration_delta_ms`
-- would be ambiguous and raise 42702 AT RUNTIME. Migration 08 hit exactly
-- this.
--
-- The layers are written as independent queries rather than as filters
-- over one shared base CTE. A base CTE referenced three times is
-- materialised, and a materialised base evaluates `query_items && v_items`
-- as a post-filter over every row it already fetched -- which makes the
-- GIN index unreachable by construction. At 600 fingerprints the planner
-- picks a sequential scan either way and is right to; the point is that
-- when the pool is large enough for the index to matter, the query shape
-- lets it be used.
-- ============================================================
create or replace function public.dedup_candidates(
  p_file_id uuid, p_limit int default 25, p_content_sha256 bytea default null
) returns table (
  candidate_file_id  uuid,
  candidate_track_id uuid,
  fp_compressed_b64  text,
  fp_sha256          text,
  shared_items       int,
  duration_delta_ms  int,
  bpm                real,
  key_camelot        text,
  quality_tier       smallint,
  via                text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_items    bigint[];
  v_algo     text;
  v_dur_s    int;
  v_gate     int;
  v_limit    int    := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_probe_ms int;
  v_sha      bytea;
  v_exact    uuid[];
  v_states   text[] := public.pool_visible_states();
begin
  select f.content_sha256 into v_sha
    from public.files f where f.id = p_file_id;
  v_sha := coalesce(p_content_sha256, v_sha);

  select g.query_items, g.algo_version, g.duration_s
    into v_items, v_algo, v_dur_s
    from public.fingerprints g where g.file_id = p_file_id;

  select a.duration_ms into v_probe_ms
    from public.audio_analysis a where a.file_id = p_file_id;

  -- ---------- layer 0: exact bytes, first, unscored ----------
  -- Collected into an array first, because layer 1 has to exclude these
  -- ids by ID. Excluding them by digest instead would not work: the twin's
  -- own content_sha256 column is NULL (see dedup_exact's header), so
  -- `content_sha256 is distinct from v_sha` is TRUE for exactly the row it
  -- was meant to suppress, and the file would come back a second time as a
  -- 'gin' row.
  select coalesce(array_agg(x.candidate_file_id), '{}'::uuid[]) into v_exact
    from public.dedup_exact(p_file_id, v_sha) x;

  if array_length(v_exact, 1) is not null then
    return query
    select f.id, f.track_id, g.fp_compressed_b64, g.fp_sha256,
           coalesce(public.qi_overlap(v_items, g.query_items), 0),
           case when v_probe_ms is null or a.duration_ms is null then null
                else a.duration_ms - v_probe_ms end,
           a.bpm, a.key_camelot, a.quality_tier, 'sha256'::text
      from public.files f
      left join public.fingerprints   g on g.file_id = f.id
      left join public.audio_analysis a on a.file_id = f.id
     where f.id = any (v_exact);
  end if;

  -- No fingerprint on the probe: layer 0 is everything there is. This is
  -- the normal state of a file that has not finished analysis, and of the
  -- three files M4 Task 1 records as failing every re-analysis.
  if v_algo is null then
    return;
  end if;

  select c.duration_gate_s into v_gate
    from public.dedup_config c where c.algo_version = v_algo;
  v_gate := coalesce(v_gate, 10);

  return query
  with hit as (
    select g.file_id      as cand_id,
           f.track_id     as cand_track,
           g.fp_compressed_b64 as cand_b64,
           g.fp_sha256    as cand_sha,
           public.qi_overlap(v_items, g.query_items) as shared,
           g.duration_s   as cand_dur_s,
           a.duration_ms  as cand_ms,
           a.bpm          as cand_bpm,
           a.key_camelot  as cand_key,
           a.quality_tier as cand_tier
      from public.fingerprints g
      join public.files f on f.id = g.file_id
      left join public.audio_analysis a on a.file_id = g.file_id
     where g.query_items && v_items
       and g.algo_version = v_algo
       -- Unknown duration on EITHER side passes, matching
       -- durationGatePasses() in src/lib/ber.ts. Reading "unknown" as
       -- "reject" would make a file with no decoded duration
       -- undedupable forever, silently.
       and (v_dur_s is null or g.duration_s is null
            or abs(g.duration_s - v_dur_s) <= v_gate)
       and g.file_id <> p_file_id
       and g.file_id <> all (v_exact)             -- already returned by layer 0
       and f.state = any (v_states)
       and not exists (
         select 1 from public.dedup_negatives n
          where n.file_lo = least(p_file_id, g.file_id)
            and n.file_hi = greatest(p_file_id, g.file_id))
     -- Shared items, then closest duration. NOT bpm: the plan's draft
     -- ordered by `abs(coalesce(b.bpm,0) - 0) desc`, which ranks by
     -- ABSOLUTE bpm rather than by bpm similarity -- a 174 dnb track would
     -- outrank a perfect match at 122. Metadata does not decide, and here
     -- it does not rank either; file_id makes the order total.
     order by shared desc, abs(coalesce(g.duration_s, 0) - coalesce(v_dur_s, 0)),
              g.file_id
     limit v_limit
  ),
  fb as (
    -- "If the GIN query returns nothing, fall back to a duration-only scan
    -- capped at 400 candidates -- cheap insurance that degrades
    -- gracefully." (PRD §6.)
    select g.file_id, f.track_id, g.fp_compressed_b64, g.fp_sha256,
           0 as shared, g.duration_s, a.duration_ms,
           a.bpm, a.key_camelot, a.quality_tier
      from public.fingerprints g
      join public.files f on f.id = g.file_id
      left join public.audio_analysis a on a.file_id = g.file_id
     where not exists (select 1 from hit)
       and g.algo_version = v_algo
       and (v_dur_s is null or g.duration_s is null
            or abs(g.duration_s - v_dur_s) <= v_gate)
       and g.file_id <> p_file_id
       and g.file_id <> all (v_exact)             -- already returned by layer 0
       and f.state = any (v_states)
       and not exists (
         select 1 from public.dedup_negatives n
          where n.file_lo = least(p_file_id, g.file_id)
            and n.file_hi = greatest(p_file_id, g.file_id))
     order by abs(coalesce(g.duration_s, 0) - coalesce(v_dur_s, 0)), g.file_id
     limit least(v_limit * 16, 400)
  ),
  merged as (
    select h.cand_id, h.cand_track, h.cand_b64, h.cand_sha, h.shared,
           h.cand_ms, h.cand_bpm, h.cand_key, h.cand_tier, 'gin'::text as src
      from hit h
    union all
    select b.file_id, b.track_id, b.fp_compressed_b64, b.fp_sha256, b.shared,
           b.duration_ms, b.bpm, b.key_camelot, b.quality_tier, 'duration'::text
      from fb b
  )
  select m.cand_id, m.cand_track, m.cand_b64, m.cand_sha, m.shared,
         case when v_probe_ms is null or m.cand_ms is null then null
              else m.cand_ms - v_probe_ms end,
         m.cand_bpm, m.cand_key, m.cand_tier, m.src
    from merged m;
end $$;
revoke execute on function public.dedup_candidates(uuid, int, bytea)
  from public, anon, authenticated;
grant  execute on function public.dedup_candidates(uuid, int, bytea) to service_role;

comment on function public.dedup_candidates(uuid, int, bytea) is
  'PRD §6 retrieval, both layers. `via` is sha256 | gin | duration. Pass
   p_content_sha256 from the container response so layer 0 can fire --
   see dedup_exact(). service_role only: a member has no business reading
   fingerprints.';

-- ------------------------------------------------------------
-- The backstop cron's query. Files that finished analysis, have a usable
-- fingerprint, and never got a track.
--
-- This is what makes the consumer's dedup step safe to treat as
-- best-effort: a crash between persist() and resolve() costs an hour of
-- latency, never a lost assignment.
--
-- state_changed_at, never created_at -- created_at is when the row was
-- minted, before the bytes moved.
-- ------------------------------------------------------------
create or replace function public.dedup_pending(p_limit int default 50)
returns table (file_id uuid, algo_version text)
language sql stable security definer set search_path = '' as $$
  select f.id, g.algo_version
    from public.files f
    join public.fingerprints g on g.file_id = f.id
   where f.state = 'stored'
     and f.track_id is null
     and f.state_changed_at < now() - interval '5 minutes'
   order by f.state_changed_at
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke execute on function public.dedup_pending(int) from public, anon, authenticated;
grant  execute on function public.dedup_pending(int) to service_role;

-- ------------------------------------------------------------
-- dedup_quality_score -- worker/app/forensics.py:quality_score(), in SQL.
--
-- A SECOND IMPLEMENTATION OF ONE RULE, deliberately. The merge decision
-- happens inside a transaction holding an advisory lock; the alternative
-- is a round trip to the container for a verdict that needs no audio at
-- all, which is worse. The cost is paid down by replaying the Python
-- version's OWN test vectors in pgTAP (supabase/tests/dedup_retrieval.sql
-- asserts the exact numbers worker/tests/test_forensics.py produces) -- if
-- the two ever drift, a test fails.
--
-- Two omissions carried over from the Python deliberately:
--   * NO DR PENALTY. The published formula has one; it encodes an
--     audiophile preference this pool does not share -- a loud DR5
--     remaster may be exactly the club-ready copy a DJ wants.
--   * clipped_pct is a THRESHOLD, not a percentage. M3 Task 6 established
--     it is an Abs-Peak-recurrence proxy (~1% on clean material, ~33% on
--     clipped), because ffmpeg 8's astats has no clipped-samples field.
--
-- The Python takes ten keyword arguments and has no defaults -- every
-- caller supplies all ten. jsonb has no such guarantee, so each key gets
-- the NEUTRAL default (the value that contributes zero): tier 0,
-- cutoff_hz 0, eff_bits 16, eff_sr 44100, inferred_kbps 0, true_peak 0,
-- clipped_pct 0, every boolean false.
--
-- Rounding: Python's round() is banker's, PostgreSQL's numeric round() is
-- half-up. They differ only on an exact .005 tie, which no term here can
-- produce -- every coefficient is a multiple of 0.1 or a ratio of
-- integers scaled by 0.8/1000, 6/8, 4/51900, 10/320 or 12/0.01.
-- ------------------------------------------------------------
create or replace function public.dedup_quality_score(f jsonb)
returns real language sql immutable set search_path = '' as $$
  select round((
      100.0 * coalesce((f ->> 'tier')::numeric, 0)
    + 0.8  * least(coalesce((f ->> 'cutoff_hz')::numeric, 0), 22050) / 1000
    + 6.0  * least(greatest((coalesce((f ->> 'eff_bits')::numeric, 16) - 16) / 8, 0), 1)
    + 4.0  * least(greatest((coalesce((f ->> 'eff_sr')::numeric, 44100) - 44100) / 51900, 0), 1)
    + case when coalesce((f ->> 'inferred_kbps')::numeric, 0) <> 0
             then 10.0 * least(1, (f ->> 'inferred_kbps')::numeric / 320)
           else 0 end
    - case when coalesce((f ->> 'lame_disagrees')::boolean, false) then 6.0 else 0 end
    - 12.0 * least(1, coalesce((f ->> 'clipped_pct')::numeric, 0) / 0.01)
    - case when coalesce((f ->> 'true_peak')::numeric, 0) > 0 then 4.0 else 0 end
    - case when coalesce((f ->> 'mono_vs_stereo')::boolean, false) then 15.0 else 0 end
    - case when coalesce((f ->> 'decode_errors')::boolean, false) then 25.0 else 0 end
  ), 2)::real;
$$;
revoke execute on function public.dedup_quality_score(jsonb)
  from public, anon, authenticated;
grant  execute on function public.dedup_quality_score(jsonb) to service_role;

-- ------------------------------------------------------------
-- dedup_is_upgrade -- worker/app/forensics.py:is_upgrade(), in SQL.
--
-- Requires a MARGIN and a HARD monotone win, per PRD §11's earning rule:
-- "not just a higher score".
--
-- NULL on either side returns false. Absence of evidence is not an
-- upgrade, and until M4 Task 1's backfill reaches every file that is the
-- common case.
--
-- WARNING for Task 6, and it is not small: audio_analysis persists only
-- FOUR of this function's ten inputs -- meas_cutoff_hz, lossy_ancestor,
-- quality_tier and quality_score (migration 09, and migration 19's
-- analysis_persist). eff_bits, eff_sr, inferred_kbps, lame_disagrees,
-- mono_vs_stereo and decode_errors are computed inside the container and
-- then dropped on the floor. A caller that builds these jsonb arguments
-- out of audio_analysis columns alone is therefore scoring with six
-- neutral defaults, which is NOT what the container computed and NOT what
-- audio_analysis.quality_score already holds. Either compare the stored
-- quality_score directly, or persist the full forensics object first.
-- Recorded, not fixed: it is a schema change and this task is read-only.
-- ------------------------------------------------------------
create or replace function public.dedup_is_upgrade(a jsonb, b jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  sa real; sb real; hard boolean;
begin
  if a is null or b is null
     or a ->> 'tier' is null or b ->> 'tier' is null then
    return false;
  end if;
  -- Python: `if b.get('clipped_pct', 0) > 0.001 >= a.get('clipped_pct', 0)`
  if coalesce((b ->> 'clipped_pct')::real, 0) > 0.001
     and coalesce((a ->> 'clipped_pct')::real, 0) <= 0.001 then
    return false;                                  -- newly clipped
  end if;
  sa := public.dedup_quality_score(a);
  sb := public.dedup_quality_score(b);
  if sb - sa < 8 then
    return false;                                  -- not better by enough
  end if;
  -- cutoff_hz is coalesced to 0 rather than left NULL: a NULL anywhere in
  -- this OR chain would make `hard` NULL, and `if not hard` would then
  -- fall through to `return true` on a three-valued comparison. The Python
  -- raises KeyError instead; neither silently passes.
  hard := (b ->> 'tier')::int > (a ->> 'tier')::int
       or coalesce((b ->> 'cutoff_hz')::int, 0)
            >= coalesce((a ->> 'cutoff_hz')::int, 0) + 1500
       or (coalesce((a ->> 'inferred_kbps')::int, 0) > 0
           and (b ->> 'tier')::int = 5);
  if not hard then
    return false;
  end if;
  if coalesce((b ->> 'lame_disagrees')::boolean, false)
     and coalesce((b ->> 'cutoff_hz')::int, 0)
           <= coalesce((a ->> 'cutoff_hz')::int, 0) then
    return false;      -- confirmed lossy ancestor at no better bandwidth
  end if;
  return true;
end $$;
revoke execute on function public.dedup_is_upgrade(jsonb, jsonb)
  from public, anon, authenticated;
grant  execute on function public.dedup_is_upgrade(jsonb, jsonb) to service_role;
