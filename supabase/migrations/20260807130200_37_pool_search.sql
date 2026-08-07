-- 20260807130200_37_pool_search.sql
-- localchune — MIT licensed. See LICENSE.
--
-- POOL.1 — /pool becomes the one browse-and-search surface.
--
-- ============================================================
-- WHAT THIS MIGRATION IS FOR
-- ============================================================
--
-- Two owner decisions arrive together and they need one query, not two.
--
--   1. "The pool page is essentially just the search." An empty box lists
--      the whole pool, browsable and paginated; a typed box ranks. The
--      filters compose with BOTH states. One surface, one RPC.
--   2. One row for each RECORDING, not for each file. 1,716 stored files
--      resolve to 901 recordings (matcher-incident-report.md), so ~815
--      rows on /pool today are second encodes of a track already listed.
--
-- Migration 34 already answered (2) for the ranked surfaces -- search and
-- the feed -- through `track_face_file()`, and left `pool_list()` per-file
-- ON PURPOSE, recording the design as "files survive merges under the
-- winner track". The owner has now overturned that for /pool. The other
-- encodes stay reachable: `/track/[id]` lists them (see the app), and this
-- function still answers per-file whenever `p_collapse` is false, which is
-- the default and therefore what every existing caller keeps getting.
--
-- ============================================================
-- WHY pool_list GREW TWO ARGUMENTS INSTEAD OF A NEW pool_search()
-- ============================================================
--
-- A `pool_search()` would need, on day one: `state = 'stored'`, migration
-- 33's tombstone exclusion, the `is_active_member()`/42501 gate, the
-- Camelot narrowing, the tempo window with its half/double arm, the tier
-- and uploader facets, the nine sort keys and the keyset cursor. Every one
-- of those already exists in `pool_list` and is already tested there. A
-- second copy is not a new feature, it is a second place for the pool's
-- visibility rules to be written -- which is the EXACT defect migration 34
-- was written to close (search and the feed had two copies of the
-- face-file rule and disagreed).
--
-- So: two new arguments, both with defaults, so every existing caller
-- keeps its behaviour byte-for-byte without being edited.
--
--   p_collapse boolean default false   -- one row per recording
--   p_q_mode   text    default 'substring'  -- 'fuzzy' = ranked search
--
-- `/api/queue/candidates` is the caller this matters most for. It builds
-- its own argument object (src/lib/queue-candidates.ts `candidateArgs`),
-- names neither new argument, and therefore still gets the per-file,
-- substring-mode, `added_desc` window it has always had. A vitest guard
-- pins that, because a silent change to the queue's candidate source is
-- the "wrong song plays" failure class.
--
-- ============================================================
-- WHY THE SEARCH HALF IS EXTRACTED RATHER THAN COPIED
-- ============================================================
--
-- `search_tracks()` (migrations 32 + 34) already knows how to read a
-- query: the token routing, the five-branch trigram candidate union, and
-- the weighted ladder. `pool_list`'s fuzzy mode needs all three, and a
-- copy of them would be the same mistake in a new place.
--
-- Three composition units come out, and `search_tracks()` is REWRITTEN to
-- call them. That rewrite is deliberate: it makes supabase/tests/search.sql
-- -- 44 assertions that pin measured behaviours like "mocha ranks Mochakk
-- 1.244 above the filename-only hit 0.754" -- the proof that the extracted
-- units are equivalent to the inline code they replace. If the extraction
-- changed anything, that file says so.
--
--   search_tokens(text)  -> the tokeniser. One row: free text, its LIKE
--                           pattern, the BPM token, the Camelot token.
--   search_hits(text,text)-> the candidate union over the five indexed
--                           expressions.
--   search_score(...)    -> the weighted `greatest()` ladder.
--
-- ============================================================
-- THE THREE KNOWN CONSTRAINTS OF search_tracks(), HANDLED ON PURPOSE
-- ============================================================
--
-- ui-final-batch-report.md measured these off the function body and
-- rejected `search_tracks()` as a general list source because of them.
-- Each is answered here rather than inherited:
--
--   1. THE 50-ROW CLAMP. Not inherited. `pool_list` keeps its own
--      `least(greatest(p_limit,100),1),200)` and its keyset cursor, so the
--      ranked view PAGES. That is the one thing a top-N cannot do, and it
--      is why relevance had to become a real sort key (below) rather than
--      a bare ORDER BY.
--   2. TOKEN ROUTING. Only in `p_q_mode => 'fuzzy'`. The default stays
--      substring, so `/artist/808 State` and `/artist/4B` -- which call
--      this function with the artist's name as `p_q` -- still search for
--      the WORDS `808` and `4b` and not for a tempo and a Camelot key.
--   3. THE 0.10 SCORE FLOOR. Kept, and kept explicit: it is what stops a
--      60-character filename that merely shares trigrams with the query
--      from occupying a page. It applies ONLY when there is free text --
--      a pure `128` or `8A` query scores nothing and must not be floored
--      to nothing.
--
-- ============================================================
-- RELEVANCE PAGES, AND THAT IS NEW
-- ============================================================
--
-- search-report.md's sketch said "force p_sort to 'relevance' (cursor
-- disabled -- relevance and keyset pagination do not compose without
-- materialising the score)". They do compose, and this function already
-- had the machinery: EVERY sort here is a zero-padded TEXT key compared
-- with `(sk, file_id) > (cursor, id)` under the C collation, and three of
-- them (`sk_added`, `sk_downloads`, `sk_likes`) already invert a NUMBER by
-- subtracting it from a constant to make "descending" into "ascending
-- text". A score is just another number.
--
--   sk_relevance = score(7) || bpm_dist(5) || key_dist(1) || likes(12)
--
-- ...which is the same four-level ordering `search_tracks()` writes as its
-- ORDER BY, flattened into one comparable string. The tempo tie-break is
-- what put the exact 128.0s at the top of the `128` screenshot in
-- search-report.md; folding it into the key keeps that behaviour instead
-- of quietly dropping it.
--
-- ============================================================
-- track_face_file() IS NOT GRANTED TO authenticated, AND MUST NOT BE
-- ============================================================
--
-- Migration 34 revoked it from `public, anon, authenticated` and granted
-- it to `service_role` only, on the grounds that nothing outside a
-- SECURITY DEFINER body needs it. That is still true and this migration
-- does NOT loosen it: `pool_list` and `pool_uploaders` are both SECURITY
-- DEFINER, so their bodies run as the function owner and can call it. The
-- pgTAP for this migration re-proves the 42501 from the member's side
-- rather than assuming migration 34 still holds, because a member-facing
-- page now depends on that call succeeding INSIDE the definer and failing
-- OUTSIDE it.
--
-- REVOKE FIRST, THEN GRANT, on every object below (CLAUDE.md): a hosted
-- project's ALTER DEFAULT PRIVILEGES has already granted EXECUTE to anon
-- and authenticated by the time these lines run, so a bare grant is a
-- no-op that leaves anon holding it.
-- ============================================================


-- ============================================================
-- 1. search_tokens -- what the member typed, decided by the TOKEN.
--
-- Lifted verbatim out of search_tracks()' declare/begin block. First
-- BPM-shaped token wins, first Camelot-shaped token wins, everything else
-- is text. Two digits minimum for a tempo so `8` stays text and only `8a`
-- reads as a key; 40..300 so `20` in `20 years` is not a tempo and the
-- word is not silently lost.
--
-- IMMUTABLE: regexp/upper/lower/btrim plus search_norm(), which migration
-- 32 made immutable so it could carry the four GIN indexes. No table is
-- read here -- camelot_neighbours() is deliberately NOT called, so the
-- caller decides whether a key token widens to its harmonic neighbours.
--
-- Returns ONE row, always, so a caller can `select ... into ... from` it
-- without a null-row branch. Every column is null when nothing routed.
-- ============================================================
create or replace function public.search_tokens(p_q text)
returns table (q_text text, q_like text, q_bpm numeric, q_key text)
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_raw   text   := lower(btrim(coalesce(p_q, '')));
  v_tok   text;
  v_num   numeric;
  v_words text[] := '{}';
begin
  q_text := null; q_like := null; q_bpm := null; q_key := null;

  if v_raw = '' then
    return next;                 -- an empty box asks nothing and gets nothing
    return;
  end if;

  foreach v_tok in array regexp_split_to_array(v_raw, '\s+') loop
    if v_tok = '' then
      continue;
    end if;

    if q_bpm is null and v_tok ~ '^[0-9]{2,3}(\.[0-9]+)?(bpm)?$' then
      v_num := regexp_replace(v_tok, 'bpm$', '')::numeric;
      if v_num >= 40 and v_num <= 300 then
        q_bpm := v_num;
        continue;
      end if;
    end if;

    if q_key is null and v_tok ~ '^(1[0-2]|[1-9])[ab]$' then
      q_key := upper(v_tok);
      continue;
    end if;

    v_words := array_append(v_words, v_tok);
  end loop;

  q_text := nullif(btrim(array_to_string(v_words, ' ')), '');
  if q_text is not null then
    q_text := public.search_norm(q_text);
    -- LIKE metacharacters escaped so a member's `%` matches a literal `%`.
    -- Default escape character, no ESCAPE clause: gin_trgm_ops extracts
    -- trigrams from the pattern of a plain `~~`, and an explicit ESCAPE is
    -- one more thing between the predicate and the index.
    q_like := '%' || replace(replace(replace(q_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return next;
end $$;

revoke execute on function public.search_tokens(text) from public, anon, authenticated;

comment on function public.search_tokens(text) is
  'The search box tokeniser, extracted from search_tracks() (migration 32)
   so pool_list()''s fuzzy mode cannot hold a second copy of it. One row:
   the normalised free text, its escaped LIKE pattern, the first BPM-shaped
   token (40-300, two digits minimum) and the first Camelot-shaped token.
   Definer-body use only -- no grant to authenticated.';


-- ============================================================
-- 2. search_hits -- the candidate set, one indexable predicate per branch.
--
-- Lifted verbatim out of search_tracks()' `hits` CTE. Each branch is ONE
-- table with ONE indexable predicate, so each can take its own GIN index
-- and the union is a bitmap OR. The uploader branch is unindexed on
-- purpose: ten members, joined to their own files.
--
-- A SET-RETURNING FUNCTION RATHER THAN A CTE, AND THE COST IS STATED.
-- A `where t.file_id in (select public.search_hits(a, b))` subquery has no
-- correlation to the outer row, so the planner evaluates it ONCE and hashes
-- the result -- the same shape a once-referenced CTE gets. What is lost is
-- the planner's freedom to push the outer row's own predicates INTO the
-- branches. On a pool of a few thousand files the planner declines to use
-- these indexes at all (search-report.md measured a seq scan beating the
-- forced bitmap plan's own choice), so there is nothing to lose today. If
-- the pool reaches the size where that flips, the fix is to inline this
-- body back into both callers' FROM clauses as a LATERAL -- and the two
-- pgTAP files above it are what make that safe to try.
-- ============================================================
create or replace function public.search_hits(p_text text, p_like text)
returns setof uuid language sql stable parallel safe set search_path = '' as $$
  select f.id
    from public.files f
   where p_text is not null
     and (public.search_norm(f.original_filename) like p_like
          or public.search_norm(f.original_filename) operator(extensions.%) p_text)
  union
  select a.file_id
    from public.audio_analysis a
   where p_text is not null
     and (public.search_norm(public.display_artist(a.raw_tags, null)) like p_like
          or public.search_norm(public.display_artist(a.raw_tags, null)) operator(extensions.%) p_text)
  union
  select a.file_id
    from public.audio_analysis a
   where p_text is not null
     and (public.search_norm(public.display_title(a.raw_tags, null)) like p_like
          or public.search_norm(public.display_title(a.raw_tags, null)) operator(extensions.%) p_text)
  union
  select ft.file_id
    from public.file_tags ft
   where p_text is not null
     and (public.search_norm(ft.tag_key) like p_like
          or public.search_norm(ft.tag_key) operator(extensions.%) p_text)
  union
  select f.id
    from public.files f
    join public.members m on m.user_id = f.uploaded_by
   where p_text is not null
     and public.search_norm(coalesce(m.username, split_part(m.email, '@', 1))) like p_like;
$$;

-- Reads files, audio_analysis (including raw_tags, which migrations 20/28
-- took away from `authenticated`), file_tags and members. It leaks nothing
-- it is not asked for, but it must stay definer-body-only for the same
-- reason pool_tracks is ungranted.
revoke execute on function public.search_hits(text, text)
  from public, anon, authenticated;

comment on function public.search_hits(text, text) is
  'The trigram candidate union, extracted from search_tracks() (migration
   32). Five branches, one indexable predicate each, so each can use its own
   GIN index. Callers: search_tracks() and pool_list()''s fuzzy mode.
   Definer-body only -- it reads audio_analysis.raw_tags.';


-- ============================================================
-- 3. search_score -- the weighted ladder, in one place.
--
-- Lifted verbatim out of search_tracks()' `scored` CTE. `greatest` rather
-- than a sum, so a track cannot climb by matching four fields weakly. The
-- weights ARE the ranking: title, artist, tags, filename, uploader.
--
-- p_needle arrives ALREADY NORMALISED (search_tokens does it); the haystack
-- fields arrive raw and are normalised here, exactly as the inline code did.
-- ============================================================
create or replace function public.search_score(
  p_title    text,
  p_artist   text,
  p_tags     text[],
  p_filename text,
  p_uploader text,
  p_needle   text
) returns real language sql immutable parallel safe set search_path = '' as $$
  select greatest(
    public.search_field_score(public.search_norm(p_title),    p_needle, 1.00),
    public.search_field_score(public.search_norm(p_artist),   p_needle, 0.80),
    public.search_field_score(public.search_norm(array_to_string(coalesce(p_tags, '{}'::text[]), ' ')),
                                                              p_needle, 0.60),
    public.search_field_score(public.search_norm(p_filename), p_needle, 0.40),
    public.search_field_score(public.search_norm(p_uploader), p_needle, 0.30)
  );
$$;

revoke execute on function public.search_score(text, text, text[], text, text, text)
  from public, anon, authenticated;

comment on function public.search_score(text, text, text[], text, text, text) is
  'One track''s relevance to a normalised query: the greatest of five
   weighted search_field_score() rungs (title 1.00 > artist 0.80 > tags 0.60
   > filename 0.40 > uploader 0.30). Extracted from search_tracks()
   (migration 32) so pool_list()''s relevance sort ranks identically.
   Definer-body only, like search_field_score itself.';


-- ============================================================
-- 4. search_tracks -- rewritten onto the three units above.
--
-- The return shape, the visibility predicate, the face-file collapse, the
-- BPM/key windows, the floor, the ORDER BY and the 50-row clamp are all
-- unchanged. supabase/tests/search.sql is unchanged too, and that is the
-- point: it is the equivalence proof for the extraction.
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
  v_limit int    := least(greatest(coalesce(p_lim, 10), 1), 50);
  v_text  text;
  v_like  text;
  v_bpm   numeric;
  v_key   text;
  v_lo    double precision;
  v_hi    double precision;
  v_keys  text[];
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select t.q_text, t.q_like, t.q_bpm, t.q_key
    into v_text, v_like, v_bpm, v_key
    from public.search_tokens(p_q) t;

  if v_bpm is not null then
    v_lo := (v_bpm * 0.94)::double precision;
    v_hi := (v_bpm * 1.06)::double precision;
  end if;
  if v_key is not null then
    v_keys := public.camelot_neighbours(v_key);
  end if;

  -- An empty box, or a query that is nothing but punctuation, routes to no
  -- token at all. Return empty rather than every stored track.
  if v_text is null and v_bpm is null and v_keys is null then
    return;
  end if;

  -- Trigram floor for the `%` operator, which is what carries a real typo
  -- (`mochack`) once prefix and substring have both missed. 0.30 is the
  -- shipped default and is too strict for short DJ names; 0.22 finds them
  -- without opening the gate to noise. Transaction-local -- this never
  -- leaks to another statement on the same pooled connection.
  perform set_config('pg_trgm.similarity_threshold', '0.22', true);

  return query
  with scored as (
    select
      t.*,
      public.search_score(t.display_title, t.display_artist, t.tags,
                          t.original_filename, t.uploader_name, v_text) as sc,
      case when v_bpm is null or t.bpm is null then null
           else abs(t.bpm::numeric - v_bpm) end                     as bpm_dist,
      case when v_keys is null then null
           when t.key_camelot = v_key then 0 else 1 end             as key_dist
      from public.pool_tracks t
     where t.state = 'stored'
       -- ONE ROW PER RECORDING (migration 34). `track_id is null` survives
       -- on purpose: a freshly stored file is trackless until the dedup
       -- backstop reaches it, and a member who uploads a track and
       -- immediately searches for it must find it.
       and (t.track_id is null
            or t.file_id = public.track_face_file(t.track_id))
       and (v_text is null or t.file_id in (select public.search_hits(v_text, v_like)))
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
   where v_text is null or s.sc > 0.10
   order by s.sc desc, s.bpm_dist asc nulls last, s.key_dist asc nulls last,
            s.like_count desc, s.file_id
   limit v_limit;
end $$;

revoke execute on function public.search_tracks(text, int) from public, anon;
grant  execute on function public.search_tracks(text, int) to authenticated;

comment on function public.search_tracks(text, int) is
  'Ranked top-N search over the stored pool, ONE ROW PER RECORDING since
   migration 34 (the track''s face file, per track_face_file()). Migration
   37 rewrote the body onto search_tokens()/search_hits()/search_score() so
   pool_list()''s fuzzy mode ranks identically; behaviour is unchanged and
   supabase/tests/search.sql is the equivalence proof. Members only, 42501
   otherwise.';


-- ============================================================
-- 5. pool_uploaders -- the uploader facet, countable either way.
--
-- DROP + CREATE rather than an overload. `create or replace` cannot add a
-- parameter, and a second `pool_uploaders(boolean)` alongside the zero-arg
-- form would leave PostgREST resolving `rpc('pool_uploaders')` against two
-- candidates. One function, one default.
--
-- THE COUNT MUST AGREE WITH THE LIST OR THE FACET LIES. /pool now lists
-- recordings; "Ana (412)" beside a list of 901 rows is a number from a
-- different question. Same predicate, same source, one argument.
-- ============================================================
drop function if exists public.pool_uploaders();

create function public.pool_uploaders(p_collapse boolean default false)
returns table (member_id uuid, uploader_name text, track_count int)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_coll boolean := coalesce(p_collapse, false);
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select t.uploaded_by, t.uploader_name, count(*)::int
    from public.pool_tracks t
   where t.state = 'stored'
     and (not v_coll
          or t.track_id is null
          or t.file_id = public.track_face_file(t.track_id))
   group by t.uploaded_by, t.uploader_name
   order by t.uploader_name;
end $$;

revoke execute on function public.pool_uploaders(boolean) from public, anon;
grant  execute on function public.pool_uploaders(boolean) to authenticated;

comment on function public.pool_uploaders(boolean) is
  'The uploader facet. p_collapse mirrors pool_list()''s: false counts
   FILES (the default, and what every pre-migration-37 caller keeps), true
   counts RECORDINGS through track_face_file(). The two must be called with
   the same value as the list beside them or the facet counts a different
   question. Migration 37 replaced the zero-argument form -- DROP + CREATE,
   never an overload, so PostgREST has one candidate to resolve.';


-- ============================================================
-- 6. pool_list -- the one list endpoint, now the one SEARCH endpoint too.
--
-- DROP + CREATE for the same reason as above: two new parameters.
--
-- HOW A TYPED QUERY AND A SET FILTER COMPOSE -- the rule, stated once.
--
-- EVERYTHING IS AN AND. There is no precedence rule, and the absence of
-- one is deliberate.
--
-- In fuzzy mode a query can carry a tempo (`128`) or a key (`8A`) token,
-- and the page also has a BPM chip and a Key chip, so the two can name the
-- same axis. A "the chip wins" rule was written first and thrown away: it
-- needs a special case for the query that is NOTHING BUT a token the chip
-- already owns, and every answer to that case is worse than the plain one.
-- Returning the chip's own results silently ignores a box the member can
-- see they typed in; returning nothing is what the AND does anyway, with a
-- paragraph of machinery in front of it.
--
-- So both apply. The overlap case is the common one and behaves well --
-- a 120-130 chip and a `128` token intersect to 120.3-130 rather than
-- fighting. The contradiction case (`128` under a 150-165 chip) returns
-- nothing, which is the honest answer to a contradictory question, and the
-- member can see both halves of the contradiction on screen.
--
-- Tier, uploader and the free text narrow both states identically, which
-- is the whole point of the merge: a filter works the same whether the box
-- is empty or not.
-- ============================================================
drop function if exists public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int);

create function public.pool_list(
  p_q           text             default null,
  p_bpm_min     double precision default null,
  p_bpm_max     double precision default null,
  p_half_double boolean          default false,
  p_key         text             default null,
  p_harmonic    boolean          default false,
  p_tier_min    int              default null,
  p_uploader    uuid             default null,
  p_sort        text             default 'added_desc',
  p_cursor      text             default null,
  p_limit       int              default 100,
  p_collapse    boolean          default false,
  p_q_mode      text             default 'substring'
)
returns table (
  file_id           uuid,
  track_id          uuid,
  uploaded_by       uuid,
  uploader_name     text,
  original_filename text,
  display_artist    text,
  display_title     text,
  container         text,
  byte_size         bigint,
  duration_ms       int,
  bpm               real,
  ibi_std_ms        real,
  key_camelot       text,
  key_open          text,
  key_musical       text,
  camelot_sort      int,
  quality_tier      smallint,
  lossy_ancestor    text,
  meas_cutoff_hz    int,
  integrated_lufs   real,
  has_preview       boolean,
  has_peaks         boolean,
  has_thumb         boolean,
  created_at        timestamptz,
  row_cursor        text,
  download_count    bigint,
  tags              text[],
  like_count        int,
  liked_by_me       boolean,
  play_count        int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sort  text    := coalesce(nullif(btrim(p_sort), ''), 'added_desc');
  v_mode  text    := lower(coalesce(nullif(btrim(p_q_mode), ''), 'substring'));
  v_coll  boolean := coalesce(p_collapse, false);
  v_limit int     := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_q     text;                  -- the substring-mode LIKE pattern
  v_lo    double precision;      -- the p_bpm_min/max window
  v_hi    double precision;
  v_keys  text[];                -- the p_key facet, widened if harmonic
  v_ck    text;
  v_cid   uuid;
  -- fuzzy mode only
  v_text  text;                  -- the free-text remainder, normalised
  v_like  text;
  v_tbpm  numeric;               -- the tempo TOKEN, if one was typed
  v_tlo   double precision;
  v_thi   double precision;
  v_tkey  text;                  -- the Camelot TOKEN, if one was typed
  v_tkeys text[];
begin
  if not (public.is_active_member() or public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_mode not in ('substring', 'fuzzy') then
    raise exception 'unknown query mode %', p_q_mode using errcode = '22023';
  end if;

  if v_sort not in ('added_desc','bpm_asc','key_asc','artist_asc','duration_asc',
                     'tier_desc','downloads_desc','likes_desc','plays_desc',
                     'relevance') then
    raise exception 'unknown sort %', p_sort using errcode = '22023';
  end if;

  if p_key is not null and btrim(p_key) <> '' then
    if upper(btrim(p_key)) !~ '^([1-9]|1[0-2])[AB]$' then
      raise exception 'invalid camelot key %', p_key using errcode = '22023';
    end if;
    v_keys := case when coalesce(p_harmonic, false)
                   then public.camelot_neighbours(p_key)
                   else array[upper(btrim(p_key))] end;
  end if;

  if p_q is not null and btrim(p_q) <> '' then
    if v_mode = 'fuzzy' then
      select t.q_text, t.q_like, t.q_bpm, t.q_key
        into v_text, v_like, v_tbpm, v_tkey
        from public.search_tokens(p_q) t;

      -- The token's own windows, ANDed with the caller's below. No
      -- precedence -- see the header block.
      if v_tbpm is not null then
        v_tlo := (v_tbpm * 0.94)::double precision;
        v_thi := (v_tbpm * 1.06)::double precision;
      end if;
      if v_tkey is not null then
        v_tkeys := public.camelot_neighbours(v_tkey);
      end if;

      -- Punctuation only: nothing routed anywhere. Returning the whole
      -- pool for a typed query would be a worse answer than none.
      if v_text is null and v_tlo is null and v_tkeys is null then
        return;
      end if;

      if v_text is not null then
        perform set_config('pg_trgm.similarity_threshold', '0.22', true);
      end if;
    else
      v_q := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    end if;
  end if;

  -- Relevance needs something to be relevant TO. An empty box sorted by
  -- relevance scores every row 0, which is not an order -- degrade to the
  -- default rather than return the pool shuffled by uuid.
  if v_sort = 'relevance' and v_text is null then
    v_sort := 'added_desc';
  end if;

  if p_bpm_min is not null or p_bpm_max is not null then
    v_lo := coalesce(p_bpm_min, 0)    * 0.97;
    v_hi := coalesce(p_bpm_max, 1000) * 1.03;
  end if;

  if p_cursor is not null and length(p_cursor) > 36 then
    v_cid := right(p_cursor, 36)::uuid;
    v_ck  := left(p_cursor, length(p_cursor) - 36);
  end if;

  return query
  with base as (
    select t.*,
           case when v_text is null then 0::real
                else public.search_score(t.display_title, t.display_artist,
                                         t.tags, t.original_filename,
                                         t.uploader_name, v_text) end   as sc,
           case when v_tbpm is null or t.bpm is null then null
                else abs(t.bpm::numeric - v_tbpm) end                   as bpm_dist,
           case when v_tkeys is null then null
                when t.key_camelot = v_tkey then 0 else 1 end           as key_dist
      from public.pool_tracks t
     where t.state = 'stored'
       -- ONE ROW PER RECORDING, migration 34's predicate verbatim, behind
       -- the flag. `track_id is null` survives for the same reason it does
       -- in search_tracks(): a freshly stored file is trackless until the
       -- dedup backstop reaches it and must still be listed.
       and (not v_coll
            or t.track_id is null
            or t.file_id = public.track_face_file(t.track_id))
       and (v_q is null
            or t.display_artist    ilike v_q escape '\'
            or t.display_title     ilike v_q escape '\'
            or t.original_filename ilike v_q escape '\'
            or exists (select 1 from public.file_tags ft
                        where ft.file_id = t.file_id
                          and ft.tag_key like lower(v_q) escape '\'))
       and (v_text is null or t.file_id in (select public.search_hits(v_text, v_like)))
       and (v_lo is null
            or (t.bpm is not null and t.bpm > 0
                and ( (t.bpm between v_lo and v_hi)
                   or (coalesce(p_half_double, false) and (t.bpm * 2 between v_lo and v_hi))
                   or (coalesce(p_half_double, false) and (t.bpm / 2 between v_lo and v_hi)) )))
       and (v_tlo is null
            or (t.bpm is not null and t.bpm > 0 and t.bpm between v_tlo and v_thi))
       and (v_keys  is null or t.key_camelot = any (v_keys))
       and (v_tkeys is null or t.key_camelot = any (v_tkeys))
       and (p_tier_min is null or t.quality_tier >= p_tier_min)
       and (p_uploader is null or t.uploaded_by = p_uploader)
  ),
  ranked as (
    select b.*,
           (case v_sort
              when 'bpm_asc'        then b.sk_bpm
              when 'key_asc'        then b.sk_key
              when 'artist_asc'     then b.sk_artist
              when 'duration_asc'   then b.sk_duration
              when 'tier_desc'      then b.sk_tier
              when 'downloads_desc' then b.sk_downloads
              when 'likes_desc'     then b.sk_likes
              when 'plays_desc'     then b.sk_plays
              -- RELEVANCE AS A KEYSET KEY. Four levels, flattened into one
              -- C-collated string so `(sk, file_id) > (cursor, id)` still
              -- pages: score descending (0..2.0 scaled to 7 digits and
              -- subtracted), then tempo distance, then key distance, then
              -- likes descending -- the same order search_tracks() writes
              -- as its ORDER BY. The `::numeric` cast is load-bearing:
              -- `real` carries about seven significant digits and 2000000
              -- needs all seven.
              when 'relevance'      then
                ((lpad((2000000 - least(greatest((b.sc::numeric * 1000000)::bigint, 0), 2000000))::text, 7, '0')
                  || lpad(least(coalesce((b.bpm_dist * 100)::int, 99999), 99999)::text, 5, '0')
                  || coalesce(b.key_dist, 9)::text
                  || lpad((999999999999::bigint - b.like_count)::text, 12, '0')
                 ) collate "C")
              else                       b.sk_added
            end) as sk
      from base b
     -- A text query with no field above the floor is noise, not a result.
     -- Only when there IS text: a pure `128` or `8A` query scores nothing
     -- and flooring it would return nothing.
     where v_text is null or b.sc > 0.10
  )
  select b.file_id, b.track_id, b.uploaded_by, b.uploader_name,
         b.original_filename, b.display_artist, b.display_title,
         b.container, b.byte_size, b.duration_ms,
         b.bpm, b.ibi_std_ms,
         b.key_camelot, b.key_open, b.key_musical, b.camelot_sort,
         b.quality_tier, b.lossy_ancestor, b.meas_cutoff_hz, b.integrated_lufs,
         b.preview_key is not null, b.peaks_key is not null,
         b.thumb_key is not null,
         b.created_at,
         (b.sk || b.file_id::text),
         b.download_count,
         b.tags,
         b.like_count,
         b.liked_by_me,
         b.play_count
    from ranked b
   where v_ck is null or (b.sk, b.file_id) > (v_ck collate "C", v_cid)
   order by b.sk, b.file_id
   limit v_limit;
end $$;

revoke execute on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int, boolean, text) from public, anon;
grant execute on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int, boolean, text) to authenticated;

comment on function public.pool_list(
  text, double precision, double precision, boolean, text, boolean,
  int, uuid, text, text, int, boolean, text) is
  'The one list endpoint, and since migration 37 the one SEARCH endpoint.
   Every filter is server-side. Paging is keyset on (sort key, file_id) --
   never OFFSET, which would shift every later page when an upload lands
   mid-scroll. row_cursor of the last row returned is the p_cursor of the
   next call.

   p_collapse false (default) lists FILES; true lists RECORDINGS through
   track_face_file(), migration 34''s predicate verbatim. p_q_mode
   ''substring'' (default) keeps p_q as the five-field ILIKE filter it has
   always been; ''fuzzy'' routes p_q through search_tokens()/search_hits()/
   search_score() -- trigram ranking, typo tolerance, and a `128`/`8A`
   token that narrows tempo or key. A token and a caller-set filter on the
   same axis are ANDed, never ranked against each other. p_sort gains
   ''relevance'', which is a real keyset key and pages like every other
   sort; with no free text it degrades to added_desc.

   Both defaults are chosen so /api/queue/candidates and /member/[username]
   keep their exact previous behaviour without being edited.';
