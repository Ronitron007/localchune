-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- ============================================================
-- 32_search — real search: typo-tolerant, DJ-aware, ranked.
-- ============================================================
--
-- WHAT THIS REPLACES. `pool_list(p_q)` does five `ilike '%q%'` tests and
-- returns whatever survives, in the page's current sort. That is a FILTER,
-- not a search: it cannot rank, it cannot forgive a typo, and a member who
-- types `mochak` gets nothing at all. This migration adds a second,
-- narrower thing beside it — a RANKED TOP-N — and does not touch
-- pool_list. The two answer different questions and merging them would
-- mean giving one a cursor it cannot order by relevance or giving the
-- other a facet surface it does not want. See the report for the shape a
-- future merge would have to take.
--
-- THREE THINGS THE QUERY BOX UNDERSTANDS, decided by the TOKEN, not by a
-- mode switch the member has to find:
--
--   `128`, `128bpm`  -> a BPM window. +/-6 % is the loose gate (the same
--                       0.94/1.06 band pool_list already uses for its
--                       bpm_min/bpm_max), and +/-2 sorts first.
--   `8A`, `8a`       -> that Camelot key AND its harmonic neighbours,
--                       through migration 11's camelot_neighbours() —
--                       exact key first, neighbours behind it.
--   anything else    -> trigram similarity over title, artist, tags,
--                       filename and uploader, weighted in that order.
--
-- A query may mix them: `mochakk 128` is "tracks that look like Mochakk,
-- around 128 BPM". Tokens FILTER; text RANKS.
--
-- WHY THE INDEXES SIT ON THE BASE TABLES AND NOT ON pool_tracks.
-- `display_artist(a.raw_tags, f.original_filename)` reads TWO tables, so
-- no single-table expression index can cover the composed value, and
-- pool_tracks is a view besides. The split that works is the one the
-- fallback logic already implies:
--
--   * the TAG half — display_artist/display_title with a NULL filename —
--     is a pure function of audio_analysis.raw_tags, so it indexes there;
--   * the FILENAME half is files.original_filename, so it indexes there —
--     and that is also the fallback artist/title for a file with no tags,
--     which is why matching the filename is not a consolation prize.
--
-- The `hits` CTE below is one UNION of single-table, index-usable scans
-- for exactly that reason. Ranking then runs on the handful of ids it
-- returns, where composing the two halves costs nothing.
--
-- VISIBILITY IS pool_list's, VERBATIM: `state = 'stored'` and nothing
-- else, behind the same is_active_member()/is_owner() 42501 gate. That is
-- deliberate and it is stricter than pool_get. Two reasons. A search row
-- is a PLAY TARGET, and only a stored file has an R2 object, a BPM and a
-- key to show. And a result set wider than the pool's own would mean
-- "search found it, the pool filter cannot" — one surface calling the
-- other a liar. A failed file is therefore never returned to anyone,
-- including its own uploader; /uploads is where an uploader's failures
-- live, and it already explains them.
--
-- NOTHING NEW ESCAPES. The returned columns are a strict subset of
-- pool_list's, so migration 20/28's rule — raw embedded tags never leave
-- the database — needs no restating here to hold. There is no raw_tags
-- column, no r2_key and no provenance in this function's output.

-- ============================================================
-- Extensions. Both confirmed available on the hosted project
-- (pg_trgm 1.6, unaccent 1.1) and neither was installed before this
-- migration. Schema `extensions`, per migration 00's pgtap line — the
-- hosted convention, and the reason every reference below is qualified.
-- ============================================================
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ============================================================
-- search_norm — the ONE normaliser, used by the indexes and by the query.
--
-- IT MUST BE IMMUTABLE OR THE INDEXES CANNOT EXIST, and plain unaccent()
-- is only STABLE: the one-argument form looks its dictionary up through
-- the search path at call time, so Postgres cannot promise the answer
-- never changes. The two-argument form takes the dictionary as a
-- regdictionary, which resolves to an OID once, at parse time — that is
-- the whole trick, and it is why this wrapper exists rather than a bare
-- lower(unaccent(x)) in five index definitions.
--
-- coalesce to '' rather than propagating NULL: an untagged track would
-- otherwise index as NULL and every downstream predicate would need its
-- own NULL branch. '' has no trigrams, so GIN simply skips it, and
-- similarity('', anything) is 0 — the same answer with no special case.
-- ============================================================
create or replace function public.search_norm(p_text text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p_text, '')));
$$;

-- ============================================================
-- AN EXPRESSION INDEX RUNS UNDER THE WRITING ROLE'S PRIVILEGES.
--
-- This is the same trap migration 06 records for CHECK constraints, and it
-- cost this migration a test: with search_norm revoked from `authenticated`,
-- a plain `insert into public.files` as that role dies with
-- `permission denied for function search_norm` — because the index
-- expression has to be evaluated to make the entry, and it is evaluated as
-- whoever is writing. Not as the index's owner, and not as the table's.
-- supabase/tests/ingest_state_machine.sql caught it (23 of 25 tests ran).
--
-- So every function named by an index expression below is granted EXECUTE
-- to `authenticated`. NONE of the three reads a table: each is a pure
-- transform of arguments the caller must already hold, so the grant hands
-- over no data that the caller could not already see. In particular this
-- is NOT a re-grant of audio_analysis.raw_tags — migrations 20/28 took
-- that column grant away, `authenticated` still cannot select it, and the
-- pgTAP file for this migration re-proves that from the other side rather
-- than assuming it.
--
-- The alternative was to leave them revoked and rely on every write to
-- `files` and `audio_analysis` arriving through a SECURITY DEFINER RPC —
-- which is true today and is exactly the kind of invariant that breaks
-- silently, years later, with an error message that names a text function
-- nobody remembers indexing.
-- ============================================================
revoke execute on function public.search_norm(text) from public, anon;
grant  execute on function public.search_norm(text) to authenticated;

-- Migration 11 revoked these from `authenticated` as a composition-unit
-- hygiene measure, not as a data boundary. The audio_analysis indexes below
-- name them, so the grant comes back for the reason above.
revoke execute on function public.display_artist(jsonb, text) from public, anon;
grant  execute on function public.display_artist(jsonb, text) to authenticated;
revoke execute on function public.display_title(jsonb, text) from public, anon;
grant  execute on function public.display_title(jsonb, text) to authenticated;

comment on function public.search_norm(text) is
  'Lowercase + unaccent, IMMUTABLE so it can carry an expression index.
   The two-argument unaccent() with an explicit regdictionary is what makes
   it immutable; the one-argument form is only STABLE. Composition unit for
   search_tracks() and for the four GIN trigram indexes below. Granted to
   authenticated because an expression index is evaluated under the WRITING
   role -- see the block above this comment.';

-- ============================================================
-- search_field_score — one field's contribution, before weighting.
--
-- A LADDER, NOT A BARE similarity(), and the ladder is what makes the
-- ranking match what a person means by "search". Trigram similarity alone
-- ranks by how much of the WHOLE string the query covers, so `mocha`
-- scores higher against a short wrong word than against `Mochakk`, and a
-- 40-character filename that literally contains `mocha` scores near zero.
-- Both are wrong. Prefix beats substring beats fuzzy; the similarity is
-- added on top so that inside each rung the closer string still wins.
--
-- strpos(), not LIKE: this runs on the already-matched candidate set, so
-- there is no index to please and no pattern to escape. `%` in a member's
-- query is a literal here, which is what they meant by typing it.
--
-- Both arguments arrive already normalised through search_norm.
-- ============================================================
create or replace function public.search_field_score(p_hay text, p_needle text, p_weight real)
returns real language sql immutable parallel safe set search_path = '' as $$
  select coalesce(p_weight, 0)::real * case
    when p_hay is null or p_hay = '' or p_needle is null or p_needle = ''
                                     then 0::real
    when p_hay = p_needle            then 2.0::real
    when strpos(p_hay, p_needle) = 1 then 1.0::real + extensions.similarity(p_hay, p_needle)
    when strpos(p_hay, p_needle) > 1 then 0.6::real + extensions.similarity(p_hay, p_needle)
    else                                  extensions.similarity(p_hay, p_needle)
  end;
$$;

-- No grant to authenticated: this one is named by no index, only by
-- search_tracks()'s body, which is SECURITY DEFINER and runs as the owner.
revoke execute on function public.search_field_score(text, text, real) from public, anon, authenticated;

comment on function public.search_field_score(text, text, real) is
  'One field''s score: exact 2.0, prefix 1.0+sim, substring 0.6+sim, else
   the bare trigram similarity -- all times the caller''s weight. The rungs
   are what stop a long filename that happens to contain the query from
   outranking the artist it names.';

-- ============================================================
-- The GIN trigram indexes.
--
-- FOUR, not five. There is no index for the uploader name: members is ten
-- rows, a GIN index on it would never be chosen by any planner, and it
-- would still have to be maintained on every username change. The
-- uploader is matched and scored inside the join instead.
--
-- CONCURRENTLY is deliberately NOT used. These run inside the migration's
-- transaction, which CREATE INDEX CONCURRENTLY cannot do, and the tables
-- are ~1k rows -- the lock is measured in milliseconds.
-- ============================================================

-- The filename half: the literal filename, and the fallback artist/title
-- for any file whose tags were missing or unreadable.
create index if not exists files_search_filename_trgm
  on public.files
  using gin (public.search_norm(original_filename) extensions.gin_trgm_ops);

-- The tag half. A NULL filename collapses display_artist/display_title to
-- their tag branch alone, which is exactly the single-table value that can
-- be indexed here.
create index if not exists audio_analysis_search_artist_trgm
  on public.audio_analysis
  using gin (public.search_norm(public.display_artist(raw_tags, null)) extensions.gin_trgm_ops);

create index if not exists audio_analysis_search_title_trgm
  on public.audio_analysis
  using gin (public.search_norm(public.display_title(raw_tags, null)) extensions.gin_trgm_ops);

create index if not exists file_tags_search_key_trgm
  on public.file_tags
  using gin (public.search_norm(tag_key) extensions.gin_trgm_ops);

-- ============================================================
-- search_tracks — the RPC.
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

-- ============================================================
-- REVOKE FIRST, THEN GRANT. A hosted project's ALTER DEFAULT PRIVILEGES
-- has already granted EXECUTE on every new function to anon and
-- authenticated by the time this line runs (CLAUDE.md); a bare `grant` is
-- a no-op there and would leave anon holding it. The pgTAP file proves
-- the 42501 from the other side.
-- ============================================================
revoke execute on function public.search_tracks(text, int) from public, anon;
grant  execute on function public.search_tracks(text, int) to authenticated;

comment on function public.search_tracks(text, int) is
  'Ranked top-N search for the nav overlay. Routes a BPM-shaped token to a
   +/-6 % tempo window, a Camelot token to that key plus camelot_neighbours(),
   and the remaining text to weighted trigram similarity over title >
   artist > tags > filename > uploader. Visibility is pool_list''s, verbatim
   (state = ''stored'' behind the is_active_member()/is_owner() gate), so a
   result can always be played and can always be found again in the pool.
   Returns a strict subset of pool_list''s columns: no raw_tags, no r2_key.';
