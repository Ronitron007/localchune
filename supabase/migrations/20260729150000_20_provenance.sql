-- supabase/migrations/20260729150000_20_provenance.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- UX.10 — curated provenance, and closure of the raw_tags leak.
--
-- audio_analysis.raw_tags stores every embedded tag verbatim. For an
-- iTunes purchase that includes the BUYER'S identity: apID (the
-- purchaser's Apple ID email — ffmpeg surfaces it as `account_id`, and
-- 292 of the pool's files carry one today), ownr and xid. Two paths let
-- any member read those with nothing but their session:
--
--   1. pool_get() returned `raw_tags jsonb` wholesale.
--   2. Migration 11 granted table-level SELECT on audio_analysis to
--      authenticated, so PostgREST serves raw_tags directly
--      (/rest/v1/audio_analysis?select=raw_tags).
--
-- This migration closes both. The rule is an ALLOWLIST, never a
-- denylist: provenance_from_tags() copies exactly six enumerated values
-- out of raw_tags and derives one boolean from key PRESENCE. A key the
-- function does not name does not exist in the output — the only shape
-- of rule that stays correct when a future encoder invents a new
-- buyer-identity atom. Lyrics (huge, and someone else's copyright) and
-- the binary/normalization Apple atoms (itunnorm, itunsmpb) are outside
-- the allowlist by construction.
--
-- The store-name derivation ("iTunes purchase · 6 Nov 2023") is display
-- logic and lives in src/lib/provenance.ts. That split is safe ONLY
-- because everything the page receives has already been curated here:
-- the client code never sees a key this migration did not copy.
-- ============================================================

-- ------------------------------------------------------------
-- Case-insensitive sibling of migration 11's tag_value(). The analysis
-- worker lowercases every key it persists (worker/app/tags.py), but the
-- allowlist must not depend on that staying true — a tag written before
-- a future worker change, or a re-analysis under different ffprobe
-- casing, must still match. Same first-non-empty-wins contract, same
-- "granted to nobody" pattern: reachable only from provenance_from_tags,
-- which runs inside definer functions owned by postgres.
-- ------------------------------------------------------------
create or replace function public.tag_value_ci(p_tags jsonb, variadic p_keys text[])
returns text language sql immutable set search_path = '' as $$
  select t.v
    from unnest(p_keys) with ordinality as k(name, ord)
    cross join lateral (
      select e.value as v
        from jsonb_each_text(coalesce(p_tags, '{}'::jsonb)) e
       where lower(e.key) = lower(k.name)
         and nullif(btrim(e.value), '') is not null
       order by e.key
       limit 1
    ) t
   order by k.ord
   limit 1;
$$;
revoke execute on function public.tag_value_ci(jsonb, text[]) from public, anon, authenticated;

comment on function public.tag_value_ci(jsonb, text[]) is
  'tag_value() with case-insensitive key matching. Composition unit for
   provenance_from_tags(); granted to no client role.';

-- ------------------------------------------------------------
-- THE allowlist. Six copied values, one derived boolean:
--
--   purchase_date  purchase_date | purd            (iTunes receipt date)
--   copyright      copyright | cprt | tcop         (the ℗ line)
--   release_date   date | originaldate | year | originalyear | tdrc | tyer
--   genre          genre | tcon
--   label          label | publisher | organization | tpub
--   encoder        encoder | encoded_by | encodedby | encoding_tool |
--                  tool | tsse | tenc
--   apple          true iff any key matches itun% (itunnorm/itunsmpb —
--                  presence only; the VALUES are binary blobs and are
--                  never copied). 'apid' does not match 'itun%'.
--
-- Everything else in raw_tags — apID/account_id, ownr/owner, xid,
-- lyrics, MusicBrainz ids, Serato blobs, play counts — has no line here
-- and therefore no path out.
-- ------------------------------------------------------------
create or replace function public.provenance_from_tags(p_tags jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'purchase_date', public.tag_value_ci(p_tags, 'purchase_date', 'purd'),
    'copyright',     public.tag_value_ci(p_tags, 'copyright', 'cprt', 'tcop'),
    'release_date',  public.tag_value_ci(p_tags, 'date', 'originaldate', 'year',
                                                 'originalyear', 'tdrc', 'tyer'),
    'genre',         public.tag_value_ci(p_tags, 'genre', 'tcon'),
    'label',         public.tag_value_ci(p_tags, 'label', 'publisher',
                                                 'organization', 'tpub'),
    'encoder',       public.tag_value_ci(p_tags, 'encoder', 'encoded_by',
                                                 'encodedby', 'encoding_tool',
                                                 'tool', 'tsse', 'tenc'),
    'apple',         case when exists (
                       select 1
                         from jsonb_object_keys(coalesce(p_tags, '{}'::jsonb)) k
                        where lower(k) like 'itun%')
                     then true end
  ))
$$;
revoke execute on function public.provenance_from_tags(jsonb) from public, anon, authenticated;

comment on function public.provenance_from_tags(jsonb) is
  'The ONLY path from raw_tags to a client. Explicit allowlist — copy a
   key here or it does not leave the database. Never invert this into a
   denylist and never return raw_tags wholesale: iTunes purchases embed
   the buyer''s Apple ID (apID/account_id), ownr and xid.';

-- ------------------------------------------------------------
-- pool_get: swap `raw_tags jsonb` for `provenance jsonb`, same position.
-- Changing a RETURNS TABLE column is the 42P13 "cannot change return
-- type" case migrations 15b/16 document — DROP + CREATE, then
-- re-establish the grants in the same transaction. Body is otherwise
-- byte-for-byte migration 18's (the current definition): every other
-- column, the claim_names lateral and the visibility WHERE clause are
-- unchanged.
-- ------------------------------------------------------------
drop function public.pool_get(uuid);

create function public.pool_get(p_file_id uuid)
returns table (
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
  provenance        jsonb,
  analysis_version  text,
  analyzed_at       timestamptz,
  batch_id          uuid,
  batch_label       text,
  claim_names       text[],
  created_at        timestamptz,
  download_count    bigint,
  upload_count      int,
  tags              text[]
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select t.file_id, t.track_id, t.uploaded_by, t.uploader_name,
         t.original_filename, t.r2_key, t.display_artist, t.display_title,
         t.container, t.byte_size, t.state, t.duration_ms,
         t.bpm, t.ibi_std_ms, t.beat_count,
         t.key_camelot, t.key_open, t.key_musical, t.key_strength, t.key_alt_profiles,
         t.integrated_lufs, t.lra_lu, t.true_peak_dbtp, t.replaygain_db, t.clipped_pct,
         t.quality_tier, t.quality_score, t.lossy_ancestor, t.meas_cutoff_hz,
         t.preview_key, t.peaks_key, t.artwork_key, t.thumb_key,
         public.provenance_from_tags(t.raw_tags),
         t.analysis_version, t.analyzed_at,
         t.batch_id, ub.label, cl.claim_names, t.created_at,
         t.download_count, t.upload_count, t.tags
    from public.pool_tracks t
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
   where t.file_id = p_file_id
     and ( t.state = any (public.pool_visible_states())
           or t.uploaded_by = (select auth.uid())
           or public.is_owner() );
end $$;

revoke execute on function public.pool_get(uuid) from public, anon;
grant  execute on function public.pool_get(uuid) to authenticated;

comment on function public.pool_get(uuid) is
  'One track, everything about it. Migration 20 replaced the wholesale
   raw_tags column with provenance — the curated allowlist projection
   from provenance_from_tags(). raw_tags itself no longer leaves the
   database (buyer-identity atoms: apID/account_id, ownr, xid). Every
   other column and the visibility WHERE clause are migration 18''s.';

-- ------------------------------------------------------------
-- Path 2: the direct table read. Replace migration 11's table-level
-- SELECT with a column list that omits raw_tags. The list is computed
-- from the live catalog at migration time, so this replays identically
-- on a database where an in-flight branch has already added columns.
-- A column added AFTER this migration is born unreadable to
-- authenticated — grant it explicitly in its own migration if members
-- should see it. That default-closed posture is intended.
-- ------------------------------------------------------------
revoke select on public.audio_analysis from authenticated;

do $do$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'audio_analysis'
     and column_name <> 'raw_tags';
  execute format('grant select (%s) on public.audio_analysis to authenticated', v_cols);
end $do$;

comment on column public.audio_analysis.raw_tags is
  'Verbatim embedded tags, including buyer identity for store purchases
   (apID/account_id, ownr, xid) and lyrics. NEVER selectable by client
   roles and never returned wholesale by any RPC — clients get the
   provenance_from_tags() allowlist projection only.';
