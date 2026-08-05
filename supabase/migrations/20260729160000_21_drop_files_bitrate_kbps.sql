-- supabase/migrations/20260729160000_21_drop_files_bitrate_kbps.sql
-- localchune — MIT licensed. See LICENSE.

-- files.bitrate_kbps has been null on every row since migration 06 created
-- it: no writer exists anywhere. analysis_persist() updates container,
-- codec, sample_rate, bit_depth and channels, but never this column. No
-- view, policy, RPC, worker or client reads it. A column that reads like
-- live data and is not is a trap for the next reader, so it goes.
--
-- Dropped rather than populated, deliberately:
--   * The only available number is the file's DECLARED bitrate (ffprobe
--     bit_rate). The forensics stack exists because declared bitrate lies:
--     a 128 kbps transcode remuxed as 320 still declares 320. quality_tier
--     already consumes the declared number internally, exactly where the
--     measurement has nothing to say, and files.quality_tier /
--     quality_score carry the measured verdict every reader actually wants.
--   * Populating forward still leaves every already-analysed row null
--     until a full re-analysis campaign — the same lie, kept for the whole
--     back catalog.
--   * If a display bitrate is ever wanted, add the column back alongside a
--     real reader and a backfill, at the next ANALYSIS_VERSION bump.
--
-- No grant surgery: migration 10's grants on files are table-level, so the
-- ACL is untouched by a column drop. Plain DROP without CASCADE, so any
-- dependency added between review and apply fails loudly instead of being
-- dropped silently.

alter table public.files drop column bitrate_kbps;
