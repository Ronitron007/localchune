-- supabase/migrations/20260807120000_34_dedup_backstop_and_search_face.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.

-- ============================================================
-- 34 — the backstop stops stranding files, and search stops showing a
-- merged track twice.
--
-- TWO DEFECTS, ONE INCIDENT. On 2026-08-07 the owner searched "four tet"
-- and saw three recordings listed twice each. The matcher was blamed. The
-- matcher was not at fault: all three pairs were ALREADY merged, each pair
-- sharing one track_id, and every one of the 675 files uploaded on
-- 2026-08-06 had been probed inline by the analysis consumer. What the
-- investigation actually found was two unrelated bugs that had been live
-- for over a week.
--
-- DEFECT 1 — THE SEEDER RUNS AHEAD OF THE MATCHER, PERMANENTLY.
--
-- The backstop cron (maintenance Worker, :47) does two things in order:
-- match everything dedup_pending() returns, then seed a track for
-- everything still trackless. dedup_pending() selects `state = 'stored'
-- and track_id is null`, and dedup_seed_tracks() mints a track for EVERY
-- trackless stored file with no regard for whether the matcher has looked
-- at it.
--
-- The Worker caps one run at DEDUP_MAX_FILES = 300 files. The seeder has
-- no such cap -- 500 rows a page, ten pages. So on any backlog bigger than
-- 300, the first run matches 300 files and then hands an identity to all
-- the rest. Those files now have a track_id, so dedup_pending() never
-- returns them again. They are not queued, not failed and not visible
-- anywhere: they are simply never matched, and no counter anywhere goes up
-- to say so.
--
-- It happened exactly once and it is still there. 1,040 files were stored
-- on 2026-07-29; 350 of them were probed and 690 were seeded past. Those
-- 690 have sat unexamined ever since, and the only reason the pool is not
-- visibly worse for it is that the 2026-08-06 re-upload probed against
-- them from the other side.
--
-- The fix is in two halves and both are needed:
--   * dedup_seed_tracks() may now only seed a file the matcher CANNOT
--     match -- one with no usable fingerprint. That is the job the
--     original comment claims for it ("a file with NO fingerprint can
--     never be matched and would otherwise stay identity-less forever"),
--     and restricting it to that job makes running ahead impossible.
--   * dedup_pending() stops keying off track_id, which was never a record
--     of whether the matcher ran, and keys off a column that is:
--     files.dedup_probed_at.
--
-- WHY A NEW COLUMN AND NOT `not exists (select 1 from match_decisions)`.
-- A probe with no candidates writes no decision row, so "has no decision"
-- stays true forever and that file would be re-probed on every single run,
-- for ever, blocking the page behind it. The backstop's work list has to
-- terminate. A stamp that means "the matcher has looked at this" is the
-- only predicate that does, and it is also the number an operator needs:
-- how many stored files has the matcher never examined.
--
-- WHY THE WORKER STAMPS IT AND dedup_resolve() DOES NOT. dedup_resolve()
-- is the most delicate function in this schema -- an advisory lock, a
-- re-check of every candidate inside it, merge_tracks(), the undo payload.
-- It also is not the only way a probe can finish: runDedup() returns
-- `ok:false` without ever reaching resolve when the fingerprint is missing
-- or empty, and that attempt must count as "looked at" or the same row
-- returns next hour. A separate one-line RPC the caller invokes after any
-- non-throwing outcome covers both cases and leaves dedup_resolve()
-- untouched.
--
-- DEFECT 2 — search_tracks() LISTS FILES, NOT TRACKS.
--
-- Migration 32 shipped search on 2026-08-07 projecting pool_tracks (which
-- is one row per FILE despite its name) with no track-level collapse. Two
-- merged files are one recording and two search rows.
--
-- pool_list() has the same shape and it is NOT changed here. That is
-- deliberate: the M6c plan records the design as "files survive merges
-- under the winner track", and /pool is the exhaustive browse surface
-- where a member picks between a FLAC and a 320 -- both encodes belong on
-- it. The RANKED TOP-N surfaces are the ones that must answer with
-- recordings, and feed_tracks() (migration 31) already does, with a rule
-- written out inline: preferred_file_id when it is itself a stored pool
-- row, else the track's newest stored file. search_tracks() was written
-- from pool_list's shape and missed it. This migration lifts that rule
-- into one function and gives search the same answer the feed gives.
-- ============================================================


-- ============================================================
-- 1. track_face_file -- the ONE rule for "which file represents this
-- recording", extracted verbatim from feed_tracks()' inline `face` CTE.
--
-- Two callers now and a third the moment anything else ranks recordings;
-- two copies of this rule is how the feed and search start disagreeing
-- about which encode a track is.
--
-- The coalesce order is the whole rule. preferred_file_id is what
-- dedup_resolve()/merge_tracks() maintain and what upload_delete()
-- (migration 33) re-elects, so it is the considered answer -- but it can
-- name a file that is no longer pool-visible, and a deleted or quarantined
-- file must never be the face of a live recording. The newest stored file
-- is the fallback, and NULL means the track has no visible member at all,
-- which is a track that should not appear on any surface.
--
-- STABLE, not IMMUTABLE: it reads two tables. No index depends on it, so
-- unlike migration 32's search_norm() there is no immutability trap here.
-- ============================================================
create or replace function public.track_face_file(p_track_id uuid)
returns uuid language sql stable parallel safe set search_path = '' as $$
  select coalesce(
    (select tr.preferred_file_id
       from public.tracks tr
       join public.files pf on pf.id = tr.preferred_file_id
      where tr.id = p_track_id and pf.state = 'stored'),
    (select f2.id from public.files f2
      where f2.track_id = p_track_id and f2.state = 'stored'
      order by f2.created_at desc, f2.id
      limit 1)
  );
$$;

-- REVOKE FIRST, THEN GRANT (CLAUDE.md): a hosted project's ALTER DEFAULT
-- PRIVILEGES has already granted EXECUTE on this to anon and authenticated
-- by the time this line runs, so a bare grant would be a no-op that leaves
-- anon holding it. Nothing outside a SECURITY DEFINER body needs to call
-- it: search_tracks() and feed_tracks() run as their definer.
revoke execute on function public.track_face_file(uuid)
  from public, anon, authenticated;
grant  execute on function public.track_face_file(uuid) to service_role;

comment on function public.track_face_file(uuid) is
  'The one file that represents a track on a ranked surface:
   tracks.preferred_file_id when that file is itself state=''stored'',
   else the track''s newest stored file, else NULL (no visible member).
   Lifted from feed_tracks() migration 31 so search and the feed cannot
   disagree about which encode a recording is. pool_list() deliberately
   does NOT use this -- /pool lists files, by design.';


-- ============================================================
-- 2. files.dedup_probed_at -- has the matcher ever looked at this file?
--
-- Nullable, no default, and NOT part of any state machine: a stamp, not a
-- state. NULL means "never examined", which for a stored file with a
-- fingerprint means it is owed a probe.
--
-- The partial index is the backstop's own query. It covers the whole work
-- list and shrinks to nothing as the backlog drains, which is the shape a
-- catch-up index should have.
-- ============================================================
alter table public.files add column if not exists dedup_probed_at timestamptz;

create index if not exists files_dedup_unprobed_idx
  on public.files (state_changed_at)
  where dedup_probed_at is null;

comment on column public.files.dedup_probed_at is
  'When the matcher last completed a probe of this file (runDedup returning
   at all, including "no fingerprint"). NULL = never examined. Written only
   by dedup_mark_probed(). This -- not track_id -- is what dedup_pending()
   keys off: a track_id is minted by dedup_seed_tracks() for files the
   matcher has never seen, so it was never a record of matcher progress.';

-- BACKFILL. Every file that already appears as a probe in match_decisions
-- has demonstrably been examined; stamp it with its own last decision so
-- the backstop does not re-probe ~1,030 files that are already done.
--
-- A file with a track and NO decision is exactly the stranded population
-- this migration exists to recover -- it stays NULL on purpose, and that
-- is the 690.
update public.files f
   set dedup_probed_at = d.last_at
  from (select probe_file_id, max(decided_at) as last_at
          from public.match_decisions group by probe_file_id) d
 where d.probe_file_id = f.id
   and f.dedup_probed_at is null;


-- ============================================================
-- 3. dedup_mark_probed -- the stamp.
--
-- Array-valued so the backstop can mark a whole page in one round trip
-- rather than one per file; the analysis consumer passes a single-element
-- array. Idempotent, and it deliberately does NOT move state_changed_at --
-- that column drives analysis_stuck() and the sweeper, and a dedup pass
-- must not look like a state transition to either of them.
-- ============================================================
create or replace function public.dedup_mark_probed(p_file_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_file_ids is null or cardinality(p_file_ids) = 0 then
    return 0;
  end if;
  with marked as (
    update public.files f set dedup_probed_at = now()
     where f.id = any (p_file_ids)
    returning f.id
  )
  select count(*)::int into v_n from marked;
  return v_n;
end $$;

revoke execute on function public.dedup_mark_probed(uuid[])
  from public, anon, authenticated;
grant  execute on function public.dedup_mark_probed(uuid[]) to service_role;

comment on function public.dedup_mark_probed(uuid[]) is
  'Stamps files.dedup_probed_at = now() for each id. Called by the matcher''s
   two callers (analysis consumer inline, maintenance backstop hourly) after
   runDedup returns WITHOUT THROWING -- including an ok:false "no
   fingerprint" outcome, which is a completed examination and must not be
   retried every hour. A thrown effect is not marked, so a database outage
   leaves the file queued. service_role only.';


-- ============================================================
-- 4. dedup_pending -- key off the stamp, not off track_id.
--
-- The shape of the return is unchanged (file_id, algo_version), so
-- src/lib/dedup-rpc.ts's PendingRow and both Workers keep working.
--
-- WHAT CHANGED, precisely:
--   * `and f.track_id is null`  ->  `and f.dedup_probed_at is null`.
--     track_id answers "does this file have an identity", which
--     dedup_seed_tracks() can make true without the matcher's involvement.
--     dedup_probed_at answers "has the matcher examined this file", which
--     is the question the backstop is actually asking.
--   * the join to fingerprints now also requires a NON-EMPTY
--     fp_compressed_b64. A row with an empty string is a degraded analysis;
--     runDedup returns ok:false on it immediately, and including it only
--     spends a page slot to learn that again.
--
-- The 5-minute grace stays: it keeps the backstop off a file the inline
-- matcher is, at this moment, in the middle of.
-- ============================================================
create or replace function public.dedup_pending(p_limit int default 50)
returns table (file_id uuid, algo_version text)
language sql stable security definer set search_path = '' as $$
  select f.id, g.algo_version
    from public.files f
    join public.fingerprints g on g.file_id = f.id
   where f.state = 'stored'
     and f.dedup_probed_at is null
     and g.fp_compressed_b64 <> ''
     and f.state_changed_at < now() - interval '5 minutes'
   order by f.state_changed_at
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke execute on function public.dedup_pending(int)
  from public, anon, authenticated;
grant  execute on function public.dedup_pending(int) to service_role;

comment on function public.dedup_pending(int) is
  'The matcher backstop''s work list: stored files with a usable
   fingerprint that the matcher has never examined (dedup_probed_at is
   null), oldest first, 5-minute grace so it does not race the inline
   matcher. Keyed off dedup_probed_at rather than track_id since migration
   34 -- dedup_seed_tracks() used to mint a track for files the matcher had
   never seen, which silently removed them from this list for ever.';


-- ============================================================
-- 5. dedup_seed_tracks -- only the genuinely unmatchable.
--
-- Same signature, same return, one new condition: a file is seeded only
-- when the matcher CANNOT match it -- no fingerprint row at all, or one
-- whose compressed payload is empty. The matchable ones are left trackless
-- until the matcher has actually run, which is what stops this function
-- from erasing its own colleague''s work list.
--
-- The cost of the change is that a stored file can now sit with a NULL
-- track_id for up to an hour instead of being given one immediately. That
-- is the correct trade and it is small: pool_list() and pool_get() do not
-- read track_id to decide visibility, feed_tracks() skips trackless rows
-- from ranking (which is right -- an unmatched file has no pooled signal
-- yet), and the file becomes a full member of the pool the moment the
-- backstop reaches it. In exchange, "how many stored files is the matcher
-- behind on" becomes a number that is true.
-- ============================================================
create or replace function public.dedup_seed_tracks(p_limit int default 1000)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  with due as (
    select f.id from public.files f
     where f.state = 'stored' and f.track_id is null
       -- THE GUARD. Without it this statement erases dedup_pending()'s
       -- work list every hour for any backlog past the Worker's per-run
       -- cap, and the skipped files are never matched by anything.
       and not exists (
         select 1 from public.fingerprints g
          where g.file_id = f.id and g.fp_compressed_b64 <> '')
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

comment on function public.dedup_seed_tracks(int) is
  'Mints one track per stored file that has none AND that the matcher can
   never match -- no fingerprint, or an empty one. Returns how many it made.
   Since migration 34 it no longer seeds matchable files: doing so gave them
   a track_id, which removed them from the old dedup_pending() for ever and
   stranded 690 files unexamined from 2026-07-29.';


-- ============================================================
-- 6. search_tracks -- one row per recording.
--
-- Byte-for-byte migration 32's function with ONE predicate added to the
-- `scored` CTE, and this comment block. Everything else -- the token
-- parsing, the hits union, the weights, the visibility gate, the return
-- shape -- is unchanged, so nothing downstream of the RPC moves.
--
-- The predicate reads: a row survives if it is the face of its track, or
-- if it has no track yet. The second half matters and is not defensive
-- padding -- since section 5 above, a freshly stored file is trackless
-- until the backstop reaches it, and a member who uploads a track and
-- immediately searches for it must find it.
-- ============================================================
create or replace function public.search_tracks(
  p_q   text default null,
  p_lim int  default 10
)
returns table (
  file_id        uuid,
  display_artist text,
  display_title  text,
  uploader_name  text,
  bpm            real,
  key_camelot    text,
  key_open       text,
  duration_ms    int,
  quality_tier   smallint,
  has_thumb      boolean,
  like_count     int,
  liked_by_me    boolean,
  play_count     int,
  score          real
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit  int    := least(greatest(coalesce(p_lim, 10), 1), 50);
  v_raw    text   := lower(btrim(coalesce(p_q, '')));
  v_tok    text;
  v_num    numeric;
  v_words  text[] := '{}';
  v_text   text;                 -- the free-text remainder, normalised
  v_like   text;                 -- ...as a LIKE pattern, metacharacters escaped
  v_bpm    numeric;              -- the BPM token, if one was typed
  v_lo     double precision;
  v_hi     double precision;
  v_key    text;                 -- the Camelot token, if one was typed
  v_keys   text[];               -- ...and its harmonic neighbours
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_raw = '' then
    return;                      -- an empty box asks nothing and gets nothing
  end if;

  -- ---- token routing ------------------------------------------------
  -- First BPM-shaped token wins, first Camelot-shaped token wins;
  -- everything else is text. Two digits minimum for a BPM, so `8` stays
  -- text and only `8a` reads as a key.
  foreach v_tok in array regexp_split_to_array(v_raw, '\s+') loop
    if v_tok = '' then
      continue;
    end if;

    if v_bpm is null and v_tok ~ '^[0-9]{2,3}(\.[0-9]+)?(bpm)?$' then
      v_num := regexp_replace(v_tok, 'bpm$', '')::numeric;
      -- A plausible tempo only. `20` in `20 years` is not a BPM, and
      -- routing it to the tempo branch would silently lose the word.
      if v_num >= 40 and v_num <= 300 then
        v_bpm := v_num;
        continue;
      end if;
    end if;

    if v_keys is null and v_tok ~ '^(1[0-2]|[1-9])[ab]$' then
      v_key  := upper(v_tok);
      v_keys := public.camelot_neighbours(v_key);
      continue;
    end if;

    v_words := array_append(v_words, v_tok);
  end loop;

  v_text := nullif(btrim(array_to_string(v_words, ' ')), '');
  if v_text is not null then
    v_text := public.search_norm(v_text);
    -- LIKE metacharacters escaped so a member's `%` matches a literal `%`.
    -- Default escape character, no ESCAPE clause: gin_trgm_ops extracts
    -- trigrams from the pattern of a plain `~~`, and an explicit ESCAPE
    -- is one more thing between the predicate and the index.
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if v_bpm is not null then
    v_lo := (v_bpm * 0.94)::double precision;
    v_hi := (v_bpm * 1.06)::double precision;
  end if;

  -- A query that is nothing but punctuation normalises to nothing and
  -- routes to no token. Return empty rather than every stored track.
  if v_text is null and v_bpm is null and v_keys is null then
    return;
  end if;

  -- Trigram floor for the `%` operator, which is what carries a real typo
  -- (`mochack`) once prefix and substring have both missed. 0.30 is the
  -- shipped default and is too strict for short DJ names; 0.22 finds them
  -- without opening the gate to noise. Transaction-local — this never
  -- leaks to another statement on the same pooled connection.
  perform set_config('pg_trgm.similarity_threshold', '0.22', true);

  return query
  with hits as (
    -- Each branch is ONE table with ONE indexable predicate, so each can
    -- take its own GIN index and the union is a bitmap OR. Guarded on
    -- `v_text is not null` so a pure `128` or `8A` query plans these away
    -- as a one-time filter and never touches the tables at all.
    select f.id as file_id
      from public.files f
     where v_text is not null
       and (public.search_norm(f.original_filename) like v_like
            or public.search_norm(f.original_filename) operator(extensions.%) v_text)
    union
    select a.file_id
      from public.audio_analysis a
     where v_text is not null
       and (public.search_norm(public.display_artist(a.raw_tags, null)) like v_like
            or public.search_norm(public.display_artist(a.raw_tags, null)) operator(extensions.%) v_text)
    union
    select a.file_id
      from public.audio_analysis a
     where v_text is not null
       and (public.search_norm(public.display_title(a.raw_tags, null)) like v_like
            or public.search_norm(public.display_title(a.raw_tags, null)) operator(extensions.%) v_text)
    union
    select ft.file_id
      from public.file_tags ft
     where v_text is not null
       and (public.search_norm(ft.tag_key) like v_like
            or public.search_norm(ft.tag_key) operator(extensions.%) v_text)
    union
    -- The uploader, unindexed on purpose (see above): ten members, joined
    -- to their own files.
    select f.id
      from public.files f
      join public.members m on m.user_id = f.uploaded_by
     where v_text is not null
       and public.search_norm(coalesce(m.username, split_part(m.email, '@', 1))) like v_like
  ),
  scored as (
    select
      t.*,
      -- The weights ARE the ranking: title, then artist, then tags, then
      -- the filename, then who uploaded it. `greatest` rather than a sum,
      -- so a track does not climb by matching four fields weakly.
      greatest(
        public.search_field_score(public.search_norm(t.display_title),    v_text, 1.00),
        public.search_field_score(public.search_norm(t.display_artist),   v_text, 0.80),
        public.search_field_score(public.search_norm(array_to_string(t.tags, ' ')), v_text, 0.60),
        public.search_field_score(public.search_norm(t.original_filename), v_text, 0.40),
        public.search_field_score(public.search_norm(t.uploader_name),    v_text, 0.30)
      ) as sc,
      -- Tie-breakers for the token half. NULL when the member typed no
      -- such token, and `nulls last` in the ORDER BY keeps that neutral.
      case when v_bpm is null or t.bpm is null then null
           else abs(t.bpm::numeric - v_bpm) end                     as bpm_dist,
      case when v_keys is null then null
           when t.key_camelot = v_key then 0 else 1 end             as key_dist
      from public.pool_tracks t
     -- pool_list's visibility predicate, verbatim.
     where t.state = 'stored'
       -- ONE ROW PER RECORDING (migration 34). Without this a merged
       -- pair is two results with the same title, key and BPM -- which
       -- is exactly what the owner reported on 2026-08-07, searching
       -- "four tet" and getting three recordings twice each. The pair
       -- was already merged; only the projection was wrong.
       --
       -- `track_id is null` survives on purpose and is not defensive
       -- padding: since this migration's dedup_seed_tracks() change a
       -- freshly stored file stays trackless until the backstop reaches
       -- it, and a member who uploads a track and immediately searches
       -- for it must find it.
       and (t.track_id is null
            or t.file_id = public.track_face_file(t.track_id))
       and (v_text is null or t.file_id in (select h.file_id from hits h))
       and (v_lo   is null or (t.bpm is not null and t.bpm > 0
                               and t.bpm between v_lo and v_hi))
       and (v_keys is null or t.key_camelot = any (v_keys))
  )
  select s.file_id, s.display_artist, s.display_title, s.uploader_name,
         s.bpm, s.key_camelot, s.key_open, s.duration_ms,
         s.quality_tier, s.thumb_key is not null,
         s.like_count, s.liked_by_me, s.play_count,
         s.sc
    from scored s
   -- A text query with no field above the floor is noise, not a result.
   -- The `%` operator already gated the candidate set; this drops a row
   -- that only survived because a 60-character filename shares trigrams
   -- with the query.
   where v_text is null or s.sc > 0.10
   order by s.sc desc, s.bpm_dist asc nulls last, s.key_dist asc nulls last,
            s.like_count desc, s.file_id
   limit v_limit;
end $$;

revoke execute on function public.search_tracks(text, int) from public, anon;
grant  execute on function public.search_tracks(text, int) to authenticated;

comment on function public.search_tracks(text, int) is
  'Ranked top-N search over the stored pool, ONE ROW PER RECORDING since
   migration 34 (the track''s face file, per track_face_file()). Tokens
   filter -- `128`/`128bpm` a +/-6%% BPM window, `8A` that Camelot key and
   its harmonic neighbours -- and free text ranks by trigram similarity
   over title, artist, tags, filename and uploader, in that weight order.
   Members only, 42501 otherwise.';
