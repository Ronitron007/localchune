# M6 — the organizational layer

*Likes, crates, a visible playback queue with autoplay + harmonic mix mode, and
discovery surfaces. Date: 2026-07-29. Status: approved in design review;
awaiting spec review.*

Spec owner note: this supersedes two PRD positions, both confirmed with the
owner during design review:

1. PRD §4 said crates are private in v1. M6 gives each crate a
   public/private toggle instead.
2. Likes, play counts, autoplay, queues and discovery surfaces appear nowhere
   in the PRD. They are new scope, added here.

---

## 1. Why

The pool today has one surface: a filterable table. That table is a search
tool. It answers "find me a 128 BPM 8A track". It cannot answer "what is good
right now?" or "what does Priya play?". M6 adds the layer that makes the pool
browsable: personal curation (crates), lightweight signal (likes, plays), a
real player queue, and pages built for discovery instead of retrieval.

## 2. Decisions made in design review

| Question | Decision |
|---|---|
| Social model | Like counts are visible to all members. Who liked is stored but never exposed. Crates have a per-crate public/private toggle, default private. |
| Autoplay | Continue the list the user played from, plus an optional harmonic "mix mode". |
| Queue | First-class and visible (Spotify/Apple style): a queue panel on the player, with append, remove, reorder, clear. |
| Discovery surfaces | All four: pool signal columns, `/crates` browse, member pages, and a home feed at `/`. The track table moves to `/pool`. |
| Play counts | In scope for M6a, event-based, fed by the anti-scrub accumulator salvaged from butternutcrack. |
| Crate ordering | Manual, in v1. `position` column, reorder RPC, drag + up/down buttons. |
| Phasing | Three shippable slices, in order: **M6a substrate → M6c discovery → M6b playback**. |

## 3. The M4 constraint

Dedup (M4) is not implemented. Canonical track identity (`files.track_id`,
`canonical_track_id()`) does not exist yet. Every M6 table therefore keys on
`file_id`, exactly as `track_stats` (migration 15b) already does.

**CARRY TO M4** (extends the 15b note; M4's plan PR must include these):

- `likes` — merge folds rows onto the survivor with `on conflict do nothing`
  (union of likers). Reversible via the merge log's moved-ids payload.
- `crate_items` — repoint `file_id` to the survivor; on collision keep the row
  with the lower `position`; renumber.
- `play_events` — repoint `file_id` to the survivor.

The PRD §4 invariant ("crates reference track identity, reads resolve through
`canonical_track_id()`") becomes true at M4, when the fold runs and the
resolver exists. Until then `file_id` **is** the track identity.

## 4. Data model

All tables live in `public`. All follow migration 09/10 discipline:
**revoke first, grant nothing, mutate only through `security definer`
functions**, proven by pgTAP `throws_ok(42501)` on direct writes as
`authenticated`.

```sql
-- Likes. Who-liked is stored for idempotency and windowing, never exposed.
create table likes (
  file_id    uuid not null references files(id) on delete cascade,
  user_id    uuid not null references members(user_id) on delete cascade,
  created_at timestamptz not null default now(),   -- enables "liked this week"
  primary key (file_id, user_id)
);

-- Crates.
create table crates (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references members(user_id),
  name           text not null,
  is_public      boolean not null default false,
  made_public_at timestamptz,            -- set by crate_set_public(true), cleared on false;
                                         -- feeds "new public crates"
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),  -- bumped by every mutating crate RPC
  unique (owner_id, name)
);

create table crate_items (
  crate_id uuid not null references crates(id) on delete cascade,
  file_id  uuid not null references files(id),
  position int  not null,
  added_at timestamptz not null default now(),
  primary key (crate_id, file_id),
  unique (crate_id, position) deferrable initially deferred
);

-- Plays. Event rows, not a counter, so time windows are real queries.
-- ~10 members produce a few hundred rows per week; volume is a non-issue.
create table play_events (
  id        bigserial primary key,
  file_id   uuid not null references files(id) on delete cascade,
  user_id   uuid not null references members(user_id),
  played_at timestamptz not null default now()
);
```

Downloads stay as the shipped lifetime counter in `track_stats`. Likes window
via `created_at`. Plays window via `played_at`. No new counter caches — the
sums are sub-millisecond at this scale (PRD §10 argument applies unchanged).

`pool_tracks` grows three columns: `like_count`, `liked_by_me`, `play_count`.
View growth uses `CREATE OR REPLACE VIEW` (append-only column list — the move
migration 15b proved). `pool_list`/`pool_get` are dropped and recreated
(42P13 — same 15b precedent).

## 5. RPC surface

All `security definer`, `set search_path = ''`, `revoke execute from public`,
per house style.

| RPC | Behavior |
|---|---|
| `toggle_like(file_id)` | Insert or delete the caller's like. Returns new count + own state. Toggling twice restores the original state; a retried single call is safe (insert `on conflict` / delete by key). |
| `bump_play(file_id)` | Insert one `play_events` row for the caller. Called once per qualifying playback by the client accumulator. |
| `crate_create(name)` | Validates name (trim, length 1–80, uniqueness per owner). |
| `crate_rename(id, name)` | Owner only. |
| `crate_delete(id)` | Owner only. Cascades items. |
| `crate_set_public(id, bool)` | Owner only. |
| `crate_add(crate_id, file_id)` | Owner only. Appends at `max(position)+1`. |
| `crate_remove(crate_id, file_id)` | Owner only. |
| `crate_reorder(crate_id, file_ids uuid[])` | Owner only. Rejects unless the array is set-equal to current items; rewrites positions to array index in one transaction. Idempotent. |
| `crate_list()` | Caller's crates (all) + every public crate. Card fields: name, owner username, count, total duration, updated-at. |
| `crate_get(id)` | Items joined to pool columns, ordered by `position`. Raises 42501 unless public or owner. |
| `feed_get()` | The four home-feed sections (see §7). |
| `member_get(username)` | Public crates + contributed tracks (via `file_claims`) for one member. |

Anonymity is structural, not cosmetic: no role can select `likes` or
`play_events` directly, and no RPC returns another member's identity for a
like or a play. pgTAP proves both directions (see §9).

## 6. M6a — substrate UI

- **Row actions** on every track row, everywhere: ♥ like toggle with count,
  and `+ crate` (picker over caller's crates, with inline "new crate…").
  The third action, `+ queue`, lands with M6b (§8), not here. Vanilla JS in
  the site-script pattern; optimistic updates with rollback through the
  existing status region.
- **`/crates`** — all public crates + all of the caller's own (own flagged;
  private ones visible only to their owner). Cards as in `crate_list()`.
- **`/crate/[id]`** — playable ordered list, same row component as the pool
  table. Owner controls: drag handle + up/down buttons for reorder, remove,
  rename, delete, public/private toggle.
- **Pool signal columns** — like count and play count columns, both sortable,
  on the `/pool` table.

## 7. M6c — discovery surfaces

**IA change:** `/` becomes the home feed. The track table moves to `/pool`
and remains the search surface. Nav: `HOME · POOL · CRATES · UPLOADS ·
ADMIN`. No redirects — internal tool.

Home feed sections, server-rendered by `feed_get()`, each a horizontal strip:

1. **Fresh** — files stored in the last 7 days. (All feed windows are a
   fixed 7 days; not configurable.)
2. **Hot this week** — ranked by plays-this-week + likes-this-week, download
   count as tiebreak.
3. **New public crates** — ordered by `made_public_at desc`.
4. **Most liked** — all-time.

Empty sections render an honest empty state; they do not hide.

**`/member/[username]`** — public crates + contributed tracks, playable rows.
Usernames across the app become links to member pages. Private crates are
invisible here — no count, no hint that they exist.

## 8. M6b — queue-centric playback

The queue is the player's data structure, and it is visible.

- **Loading it:** playing a row snapshots the surrounding list (ordered
  `{file_id, label, key_camelot, bpm, duration}` from row `data-*`
  attributes) into module state in the site script. Module state survives
  ClientRouter soft navigation — the player bar already relies on this.
  Playing a row elsewhere replaces the queue. `+ queue` on any row appends;
  `+ queue` on a crate card appends the whole crate in crate order.
  The queue caps at 500 items — appends past the cap are dropped with a
  toast, which bounds the localStorage payload.
- **Queue panel:** `☰ QUEUE` button on the player bar opens a drawer above
  it: Now Playing + Up Next in play order. Operations: remove, reorder
  (drag + up/down, reusing the crate-reorder JS), clear.
- **Modes:** `off · autoplay · mix`, plus a shuffle toggle in autoplay.
  - *Autoplay* — play the queue top-down. Shuffle visibly reorders Up Next
    in place.
  - *Mix mode* — deterministic. On entry, and on manual skip or removal, it
    computes the full greedy harmonic chain through the remaining queue —
    Camelot circular distance with mode-change penalty and perfect-fifth = 0,
    plus BPM % difference, scoring salvaged from `useSimilarityFilter.ts` —
    and shows that order in the panel. What you see is exactly what plays.
    Mix mode never reaches outside the queue.
- **Advance mechanics:** fetch a signed URL from the existing
  `/api/track/[id]/source` per track, then play. A failed fetch strikes the
  item through, toasts, and skips onward. End of queue: stop.
- **Persistence:** queue (ids + row metadata) serialized to localStorage in
  the playerStore-bookmark pattern; restored on load; signed URLs are always
  re-fetched, never stored.
- **Play counting:** the salvaged accumulator (fires once at 30 s cumulative
  listening; discards scrub deltas > 5 s) calls `bump_play`. Autoplay
  sessions count honestly — that is what feeds "hot this week".

## 9. Testing

- **Pure unit (vitest, node env, no DOM):** harmonic scoring and mix-chain
  selection (table-driven over known Camelot pairs; determinism: same queue
  in → same chain out); queue ops (append, remove, reorder, clear, shuffle,
  skip-on-error, localStorage round-trip via the storage shims from the
  butternutcrack harness).
- **pgTAP:** `throws_ok(42501)` direct-write proof for all four tables;
  `toggle_like` idempotency; crate name validation + per-owner uniqueness;
  `crate_get` raises on private-not-mine; `crate_reorder` rejects non-set-
  equal arrays; feed week-window boundary correctness over seeded fixtures;
  **anonymity proof** — as member B, no RPC or view returns member A's
  identity for a like or play.
- **Deploy order rule:** migrations before `npm run deploy`, per CLAUDE.md.

## 10. Out of scope

- Crate sharing beyond the public toggle (collaborative crates, follows).
- Cross-member "recommended for you" — PRD non-goal (no ML) stands; mix mode
  is a deterministic wheel-walk, not a recommender.
- Queue persistence server-side; "play next" as a distinct action (v1 has
  append + reorder).
- Any change to dedup, analysis, or catalogue matching.

## 11. Questions resolved in spec review (2026-07-29)

1. Feed windows: fixed 7 days.
2. `+ queue` appends whole crates from crate cards: yes, in v1.
3. Member page hides private crates entirely — no count, no hint.
4. Queue capped at 500 items.
