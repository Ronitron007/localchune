-- supabase/migrations/20260729140000_19_analysis_persist_content_sha256.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- analysis_persist(), for ONE added write: files.content_sha256.
--
-- THE BODY BELOW IS COPIED FROM MIGRATION 14, NOT MIGRATION 09. Migration 14
-- (20260729130300_14_analysis_persist_thumb.sql) re-created this function
-- verbatim from 09 with one change — it stores thumb_key, in three places.
-- Starting from 09's body would silently drop that write, every pool row
-- would go back to rendering the empty box, and nothing would raise. The
-- pgTAP file for this migration asserts thumb_key survives, so the mistake
-- fails a test rather than a user's eyes.
--
-- content_sha256 is PRD §6's layer 0. It has been NULL on every row since
-- M2 because nothing computed it; M4 Task 1 makes the container return it as
-- lower-case hex on AnalyzeResponse, and this is where it lands in the
-- bytea column.
--
-- THE WRITE IS GUARDED, and the guard is the interesting part. The column is
-- UNIQUE. A genuinely byte-identical re-upload would therefore raise 23505
-- at the very last step of a ~45 vCPU-s analysis, the consumer would retry
-- it four more times at full cost, and the file would land in the DLQ. But a
-- collision is not an error — it is layer 0 FIRING, and dedup_resolve() is
-- where it gets handled. So: write the digest only when no other row holds
-- it, and let the matcher find the collision a moment later.
--
-- The empty-string check matters as much as the collision check: an OLD
-- container answering this NEW function sends no content_sha256 at all, and
-- `decode('', 'hex')` is a valid empty bytea, not NULL. Two such rows would
-- then collide on the UNIQUE index for the one reason that has nothing to do
-- with their audio. Coalescing to the existing value leaves those rows
-- alone until they are re-analysed.
--
-- Everything else in this function is migration 14's body, unchanged.

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
