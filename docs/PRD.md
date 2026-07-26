# localchune — PRD

*Private, invite-only track pool for a DJ circle (~8–10 people). Cloudflare R2 for objects, Supabase for auth + Postgres, Astro on Cloudflare for the app, Google Cloud Run for audio analysis.*

Status: draft for review. Date: 2026-07-27.

---

## 1. What this is

A closed shelf. Every member uploads the tracks they've bought; everyone in the circle can search, audition and download the whole pool. Before anything is added, it's fingerprinted against what's already there, so the pool stays one-copy-per-recording instead of decaying into eleven versions of the same file with different ID3 tags.

Not a store, not a social network, not public. No money changes hands. That last point is load-bearing for several licensing decisions below.

### Non-goals (v1)

- Public access, sharing links, or anything indexable
- Payments, subscriptions, royalties
- Long DJ mixes (>15 min) — explicitly rejected; that's what [butternutcrack](../../Projects/butternutcrack) is for
- Mobile apps
- Recommendations / ML on the catalogue

---

## 2. Vocabulary

The words matter because the schema follows them.

| Term | Meaning |
|---|---|
| **pool** | the whole shared catalogue |
| **track** | a canonical, format-agnostic recording identity. Has a `track_id`. This is what crates reference. |
| **file** | one audio file (mp3 320 / FLAC / WAV…) belonging to exactly one track. A track can have several. |
| **crate** | a member's curated collection of tracks. Named after Serato crates, not "library". |
| **member** | an allowlisted human with an active session |
| **upload** | one member's act of contributing a file. Resolves to a track; may or may not result in a stored file. |

**One `track_id` = one specific audio recording.** Radio Edit, Extended Mix, Original Mix, any Remix, and a Remaster are all *separate* tracks. Only re-encodes and re-rips of the same master collapse together. This is the single most important product rule — it makes dedup tractable, because a fingerprint can reliably answer "is this the same audio?" and cannot reliably answer "is this the same song?".

---

## 3. Access model

### Allowlist-gated Google OAuth

Sign-in is Google OAuth, but the email must already exist in an owner-maintained `allowlist` table or **no account is created at all**.

The mechanism is Supabase's **Before User Created Hook** — it is the only option that prevents the `auth.users` row from existing *and* returns a usable error to the client. A trigger on `auth.users` also blocks it but surfaces as a generic `Database error saving new user`. RLS alone does not prevent account creation, only data access.

Note: the "Authentication → Domain Whitelist" setting described in various tutorials **is not a real Supabase feature**. Also, the official `signup_email_domains` example SQL in Supabase's own before-user-created docs is broken (it calls `lower($1)` on the `event` jsonb and declares a `domain` variable that collides with the column). Don't copy it.

```sql
create table public.allowlist (
  email              text primary key check (email = lower(email)),
  note               text,
  initial_grant_days int not null default 30,
  invited_at         timestamptz not null default now(),
  revoked_at         timestamptz
);
alter table public.allowlist enable row level security;
-- zero policies for anon/authenticated => invisible to clients.
-- Auth hooks run as supabase_auth_admin, which is NOT bypassrls:
grant usage on schema public to supabase_auth_admin;
grant select on public.allowlist to supabase_auth_admin;
create policy "auth admin reads allowlist"
  on public.allowlist for select to supabase_auth_admin using (true);

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql as $$
declare
  v_email    text := lower(trim(event->'user'->>'email'));
  v_provider text := event->'user'->'app_metadata'->>'provider';
begin
  if v_provider is distinct from 'google' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Please sign in with Google.'));
  end if;
  if not exists (select 1 from public.allowlist a
                  where a.email = v_email and a.revoked_at is null) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'This email is not on the invite list.'));
  end if;
  return '{}'::jsonb;
end $$;
```

The hook must be registered in `supabase/config.toml` under `[auth.hook.before_user_created]`, not just enabled in the dashboard — otherwise a project restore silently leaves the front door open.

**Gmail aliasing caveat:** `r.o.h.a.n@gmail.com` and `rohan+dj@gmail.com` both deliver to `rohan@gmail.com` but fail a naive `lower(email)` match. Normalise on insert into the allowlist: strip dots and everything after `+` in the local part, for `gmail.com`/`googlemail.com` only.

### Admin page

Owner-only route (`role = 'owner'`) listing members: email, joined date, access expiry, tracks contributed, bytes occupied, last seen. Actions: add email to allowlist, revoke, grant days manually. This gets used constantly — build it in v1.

Bootstrap: a seed migration inserts the owner's own email with `role = 'owner'`.

---

## 4. Data model

### Core

```sql
create table tracks (
  id                   uuid primary key default gen_random_uuid(),
  preferred_file_id    uuid,                    -- FK added after files exists
  merged_into_track_id uuid references tracks(id),
  merged_at            timestamptz,
  -- canonical metadata (from catalogue match, or best-effort from tags)
  artist               text,
  title                text,
  mix_name             text,                    -- 'Extended Mix', 'Radio Edit', NULL
  album                text,
  label                text,
  catalog_no           text,
  release_date         date,
  isrc                 text,
  mbid                 uuid,                    -- MusicBrainz recording id
  artwork_url          text,
  artwork_source       text,                    -- 'caa' | 'uploader' | 'embedded'
  -- analysis (from the preferred file)
  duration_ms          int,
  bpm_raw              real,
  bpm_display          real,                    -- user-correctable
  bpm_confidence       real,
  beat_grid            real[],                  -- tick times, ~767 floats at 128bpm/6min
  beat_ibi_cv          real,                    -- <0.02 => genuinely constant tempo
  key_camelot          text,                    -- '8A'
  key_open             text,                    -- '1m'
  key_musical          text,                    -- 'Am'
  key_confidence       real,
  key_alt_profiles     jsonb,
  genre                text[],
  integrated_lufs      real,
  created_at           timestamptz not null default now(),
  constraint no_self_merge check (merged_into_track_id is distinct from id)
);

create table files (
  id             uuid primary key default gen_random_uuid(),
  track_id       uuid references tracks(id),
  batch_id       uuid not null references upload_batches(id),
  uploaded_by    uuid not null references members(user_id),
  r2_key         text not null unique,
  content_sha256 bytea not null unique,
  byte_size      bigint not null,
  container      text,          -- 'mp3','flac','wav','m4a','aiff'
  codec          text,
  bitrate_kbps   int,
  sample_rate    int,
  bit_depth      int,
  channels       smallint,
  duration_ms    int,           -- DECODED duration, never container metadata
  tags           jsonb not null default '{}',   -- raw embedded tags, kept forever
  quality_score  real,
  quality_tier   smallint,
  state          text not null default 'received'
    check (state in ('received','analysing','stored','needs_review',
                     'rejected_duration','rejected_redundant','quarantined','failed')),
  created_at     timestamptz not null default now()
);
alter table tracks add constraint tracks_preferred_file_fk
  foreign key (preferred_file_id) references files(id);

-- Who contributed what, decoupled from who owns the bytes.
-- Needed because content_sha256 is globally unique: if B uploads bytes
-- A already has, B gets a claim, not a file.
create table file_claims (
  file_id    uuid not null references files(id),
  user_id    uuid not null references members(user_id),
  batch_id   uuid not null references upload_batches(id),
  claimed_at timestamptz not null default now(),
  primary key (file_id, user_id)
);
```

### Crates

```sql
create table crates (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references members(user_id),
  name       text not null,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table crate_items (
  crate_id uuid not null references crates(id) on delete cascade,
  track_id uuid not null references tracks(id),
  added_at timestamptz not null default now(),
  primary key (crate_id, track_id)
);

create view crate_items_resolved as
  select crate_id, canonical_track_id(track_id) as track_id, min(added_at) as added_at
    from crate_items group by 1, 2;
```

**Crates reference `track_id` and are never rewritten by a merge or an undo.** All reads go through `canonical_track_id()`, which walks the `merged_into_track_id` chain. A merge is one `UPDATE`; an undo is one `UPDATE`; crates snap back automatically and duplicate entries collapse in the view.

> **Invariant, enforced by convention not by the database:** the moment anything materialises `track_id` into a denormalised crate table, a cached client payload, or a playlist export, merge-undo silently stops being correct and nothing will error. Guard this in code review.

Crates can contain **any** track in the pool, not just the member's own uploads. (This supersedes the initial "only their own uploads" framing — confirmed during design.) Crates are private to their owner in v1; sharing is a v2 candidate.

---

## 5. Upload

### Path

Browser → **presigned S3 PUT** direct to R2. Bytes never pass through a Worker.

- **Single PUT below 48 MB, presigned multipart above.** The threshold is about *resume*, not size — R2 accepts a 5 GiB single PUT, but a 100 MB upload that dies at 95% on venue wifi restarts at byte zero.
- Presigning happens in a **Supabase Edge Function**, because it must verify the user's JWT and check quota, and both live there already.
- Use **aws4fetch** (MIT, ~5 KB, pure Web Crypto), not the AWS SDK — the SDK wants Node APIs that neither Workers nor Deno Edge Functions provide.
- **Server mints the object key.** Never let the client choose it.

Three R2-specific traps, in descending order of how long they'll cost you:

1. **R2 requires all non-trailing multipart parts to be the same length**, and validates it at `CompleteMultipartUpload` — i.e. after every byte is already uploaded. Compute `partSize` once per file and derive every offset from it, or eat `InvalidPart` at the very end.
2. **`ExposeHeaders: ["ETag"]` is mandatory in bucket CORS.** Without it, JS cannot read part ETags and completion is impossible. Presents as an inexplicable `undefined`.
3. **Use `XMLHttpRequest`, not `fetch()`.** `fetch` has no upload progress events. `xhr.upload.onprogress` is the only way to drive a per-file bar.

```json
[{
  "AllowedOrigins": ["https://localchune.<domain>", "http://localhost:4321"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 86400
}]
```

### The 15-minute rule

**Reject before upload.** Duration is read from the file header client-side; over-length files are marked `skipped — too long` in the batch UI and no bytes move.

- `music-metadata`'s `parseBlob` with the default `duration: false`, reading a **64 KB head slice plus a 256 KB tail slice**. Never `duration: true` — that's the documented "read the whole file if necessary" fallback and it will grind through a 200-file batch.
- Head *and* tail because: FLAC STREAMINFO is exact in ~42 bytes; WAV `fmt`+`data` in ~100; MP3 needs the Xing/Info frame past a possibly-huge ID3v2 tag; **M4A/ALAC `moov` may be at the end of the file** if never faststart-ed; **Ogg/Opus duration is the final page's granule position**.
- Run it in a **Web Worker** so 200 parses don't stall the upload pump.
- Fallback: `HTMLAudioElement` with `preload='metadata'` behind a 5 s timeout (returns `Infinity` for header-less VBR MP3 until the `currentTime = 1e101` seek hack; leaks the file unless you `revokeObjectURL`).
- **Never `decodeAudioData`** — it needs the full file in an ArrayBuffer then expands to Float32 PCM. A 10-minute stereo track becomes ~212 MB of RAM, to obtain a number that lives in the first 100 bytes.

The client check is a *bandwidth optimisation, not a control*. The analysis worker re-derives duration by decoding, and that number is authoritative. If it exceeds 15 min the object is deleted (a free R2 op) and the row marked `rejected_duration`.

### Bulk UX

- **Concurrency: 4 files × 3–4 parts ≈ 12–16 requests in flight.** Never `Promise.all` over 200 — under HTTP/2 all 200 streams fight for the same uplink, every file finishes at the end, and progress bars become meaningless.
- **Resume unit is the part.** Journal `{fileId, key, uploadId, partSize, completedParts[]}` to IndexedDB *before* the first byte moves. Identify files by `name + size + lastModified`; don't hash 200 files up front.
- **Tab close:** the IndexedDB journal drives a "resume batch?" prompt; a server-side sweeper aborts multipart uploads still pending after N hours.
- **Abandoned multipart uploads cost real money** — you're billed for parts of uploads that were never completed. R2 auto-aborts after 7 days; **shorten to 1 day** with a lifecycle rule and watch `uploadCount` in the storage dataset.
- **Idempotency:** client-generated UUID per file, persisted before any network call, used as both the row key and the R2 key so a retry overwrites rather than creating `track (1).flac`.

---

## 6. Dedup — the hard part

### Pipeline

Layers are ordered cheapest-first. Most uploads exit at layer 1 or 2.

| # | Layer | Cost | Catches |
|---|---|---|---|
| 0 | `content_sha256` unique on `files` | free (already computed) | byte-identical re-upload → `file_claims` row, no new file, no credit |
| 1 | Decoded-PCM MD5 (FLAC STREAMINFO `audio_md5`, or hash the decoded stream) | ~decode | same audio, different container/tags |
| 2 | **Chromaprint** raw fingerprint → GIN candidate retrieval → offset-swept BER comparison | ~1 s | the real job: same master, different encode/trim |
| 3 | Human review queue | a person | the 0.70–0.90 confidence band |

### Fingerprint storage and retrieval

Chromaprint raw fingerprints are ~8 × 32-bit ints per second (~3000 for a 6-min track). Store the compressed form (~4 KB) plus a masked, deduped `query_items int[]` for indexed candidate lookup.

```sql
create table fingerprints (
  file_id       uuid not null references files(id) on delete cascade,
  algo          text not null default 'chromaprint',
  algo_version  text not null,            -- 'cp-1.5.1/test2/11025'
  duration_s    int  not null,
  frame_count   int  not null,
  fp_compressed bytea not null,
  fp_sha256     bytea not null,
  query_items   int[] not null,
  created_at    timestamptz not null default now(),
  primary key (file_id, algo, algo_version),
  constraint enough_items check (cardinality(query_items) >= 40)
);
create index fingerprints_qi_gin  on fingerprints using gin (query_items gin__int_ops);
create index fingerprints_dur_idx on fingerprints (algo_version, duration_s);
```

Building `query_items` in the worker:

```
mask   = 12                       # keep top 20 bits — TUNE EMPIRICALLY
win_a  = raw[8*10 : 8*40]         # 10s–40s
win_b  = raw[8*60 : 8*90]         # 60s–90s, guards against differing intros
items  = sorted(set((x >> mask) & 0xFFFFF for x in win_a + win_b))
```

Two windows because a single one can land in an intro that differs between a club rip and a radio edit.

**Candidate query** — GIN overlap plus a ±10 s duration gate, top 25 by shared items. The worker then decompresses those ≤25 fingerprints and runs an offset sweep (±80 frames) producing `score = 1 − BER`, `best_offset_frames`, `overlap_frames`, and a `per_second_ber` strip.

**At 100k tracks this is small.** Do not build pgvector, HNSW, LSH, a separate inverted-index table, or partitioning. If the GIN query returns nothing, fall back to a duration-only scan capped at 400 candidates — cheap insurance that degrades gracefully.

### Confidence bands

| Band | Score (1 − BER) | Action |
|---|---|---|
| `same` | ≥ 0.90 | auto-assign to the existing `track_id` |
| `probable` | 0.70 – 0.90 | **review queue** — human decides |
| `related` | 0.40 – 0.70 | new `track_id`, plus a `track_relations` row (`version`) |
| `different` | < 0.40 | new `track_id` |

> **These numbers are AcoustID's constants adjusted by judgement, not evidence from your library.** They must be calibrated once ~2k tracks are in: take known-duplicate pairs from your own collection, transcode 200 files to 128 kbps, and measure where the distributions actually separate. Until then, the 0.90 auto-merge band *will* make some wrong merges. That's tolerable only because merges are reversible — see below.

### Review queue UI

A duplicate decision must take about two seconds. Each row shows:

- Both tracks' artist/title/mix as parsed, side by side
- Duration delta in ms, bitrate, format, file size
- The **divergence strip** — `per_second_ber` rendered as a bar per second, so you can see *where* they diverge (a matching body with a divergent first 30 s = different intro edit, not a different track)
- Two 8-second audio snippets, taken at the point of maximum divergence, A/B-switchable
- Buttons: **Same** / **Different** / **Different version** (creates the `track_relations` link)

### Merges are reversible, always

```sql
create table track_merges (
  id                      bigserial primary key,
  loser_track_id          uuid not null references tracks(id),
  winner_track_id         uuid not null references tracks(id),
  decision_id             bigint references match_decisions(id),
  performed_by            text not null,     -- 'auto' or a user uuid
  performed_at            timestamptz not null default now(),
  moved_file_ids          uuid[] not null,   -- exactly what to put back
  prior_preferred_file_id uuid,
  undone_at               timestamptz,
  undone_by               uuid
);
```

The merge log carries its own undo payload. `undo_merge` refuses if a later merge sits on top, forcing newest-first unwinding.

`match_decisions` is append-only with a partial unique index on `(probe_file_id, candidate_track_id) WHERE superseded_at IS NULL` — reprocessing supersedes rather than duplicating, and history is retained. Every decision records the exact `thresholds` jsonb it used, so a threshold change doesn't retroactively make past decisions unexplainable.

**Rule for algorithm upgrades:** a new `algo_version` writes new fingerprints and new decisions but **never auto-undoes an existing merge**. Disagreements enqueue a review row. Automated un-merging on a version bump is how you lose someone's crates overnight.

### Concurrency: two people upload the same new track at once

Neither a unique constraint nor a lock alone is sufficient. A unique index can't express approximate equivalence over a fuzzy score. A lock alone doesn't help because the expensive candidate scan happens *before* the lock.

The fix is **read → compute → re-verify under lock → write**:

1. Outside any transaction: fingerprint, GIN candidate query, score all candidates (hundreds of ms).
2. `BEGIN;` → `pg_advisory_xact_lock(hashtext('localchune.track_assign'))`
3. **Inside the lock, re-run the GIN candidate query** (~2 ms). If a track appeared since step 1 that now scores ≥ 0.90, use it instead of creating one.
4. Also inside the lock: if `fp_sha256` exactly matches an existing row, reuse its track and skip scoring entirely — this is the common "same rip, different tags" case, and it's free.
5. `COMMIT;`

One global advisory lock is correct here, not a bottleneck: the critical section is ~10 ms, so 400 concurrent files serialise in ~4 seconds. Sharding by duration bucket would be *worse* — two encodes of the same track can straddle a boundary and reintroduce the race. Set `SET LOCAL statement_timeout = '5s'` inside the transaction. Use `pg_advisory_xact_lock`, never the session-level `pg_advisory_lock`.

### Where dedup will fail

Stated plainly, because these are not fixable by tuning:

- **Vinyl rips at a different playback speed will not match.** Chromaprint is not robust to pitch/tempo shift; a rip mastered 0.5% fast fingerprints as a different track and scores below 0.40, forever. Panako 2.0 (constant-Q triplets) handles this but is a JVM application and a whole second matcher. **Out of scope for v1 — accept the duplicates.**
- `duration_ms` **must** come from decoding, not container metadata. VBR MP3s without a Xing header report wildly wrong durations; if any path fills it from tags, the ±10 s gate silently drops true duplicates and you will never know.
- The first few thousand files will generate a **review queue in the high hundreds** — a DJ library is dense with extended mixes, bootlegs and DJ tools that legitimately land in the ambiguous band. The design has no bulk "apply this answer to the other 12 that look like this" action; you'll want one sooner than expected.
- The GIN mask width and query-window placement are guesses. If the 10–40 s window lands in a differing intro, recall collapses for exactly the pairs you most want to catch.
- Nothing currently surfaces a *completed* auto-merge for after-the-fact review. Wrong merges are cheap to undo only if someone notices. Add a "recent merges" feed.

---

## 7. Analysis

One container, one decode, one pass. Runs per file on Cloud Run.

### What it produces

| Output | Tool | Notes |
|---|---|---|
| Decoded duration | Essentia `AudioLoader` | authoritative; drives the 15-min gate |
| Chromaprint fingerprint | `fpcalc` (LGPL 2.1) | doubles as the AcoustID lookup key — see §8 |
| Key | Essentia `KeyExtractor(profileType='edma')`, plus `edmm` and `bgate` stored alongside | edmm scores 70.1 weighted / 63.7 correct on GiantSteps vs QM's 50.4 / 39.6 |
| BPM + beat grid | Essentia `RhythmExtractor2013(method='multifeature')` | store `bpm`, full `ticks` array, `confidence`, `beat_ibi_cv` |
| Loudness | `LoudnessEBUR128` + `ReplayGain` | LUFS-I, LRA |
| Waveform peaks | inline reshape of the decoded array | 1000 min/max buckets, <0.01 s, ~41 KB JSON |
| Embedded tags + art | `music-metadata` (MIT) or `mutagen` | keep raw tags forever — enables corpus-wide re-matching later |
| Quality forensics | see §7.2 | drives the upgrade decision |

**Do not add `audiowaveform`** (BBC). It's a whole extra decode pass and a GPL dependency to replace a five-line NumPy reshape.

Measured cost, 6-min 44.1 kHz stereo on an M1 Pro: **3.86 s CPU / 469 MB RSS** for the lean core; ~7.0 s / ~810 MB with three key profiles, EBU R128 and the spectral loop. Budget ~2× on x86 server cores.

### The BPM octave problem is a UX decision, not a bug to fix

Measured during research: on a 174 BPM drum & bass track, **all three** Essentia estimators returned half-time — multifeature 87.00, degara 87.00, Percival 86.86. Clamping the range does **not** help; `PercivalBpmEstimator(minBPM=120, maxBPM=220)` still returned 86.86.

This is the state of the art, not an Essentia defect. On GiantSteps Tempo (an EDM dataset), the best published system scores ACC1 73.0 against ACC2 89.3 — that ~16-point gap is pure octave error, in the best available system. madmom is worse on EDM: 58.9 vs 86.4.

So:

1. Store `bpm_raw` and the beat grid.
2. Apply a **genre prior** where one is available from tags or folder: d'n'b/hardcore/footwork → fold into [160, 200); house/techno → fold into [110, 140). A genre prior beats any signal-only trick.
3. Ship a **one-click ×2 / ÷2 control** on the track page that persists to `bpm_display`. This is exactly what Mixxx does — it doesn't range-clamp during analysis either; its answer is a manual correction button.

Also worth lifting: Mixxx's `src/track/beatutils.cpp` `makeConstBpm`, which finds constant-tempo regions and enforces phase coherence at `kMaxSecsPhaseError = 0.025s`.

### 7.2 Quality tier + "is this actually an upgrade?"

When an upload dedupes to an existing track, we decide whether to keep the file and whether it earns a credit. The cheat to defeat is obvious: re-encode a 128 kbps MP3 to 320, or wrap it in FLAC, and claim an upgrade. **The container lies; the audio does not.**

Two checks, in order of value:

**(a) Bitstream vs PCM disagreement** — near-zero false positives, catches the exact cheat:

```
if lame_tag_present and abs(lame_lowpass_hz - measured_cutoff_hz) > 1500:
    lossy_ancestor = 'confirmed'
```

The LAME/Xing/Info tag records `lowpass = lowpassfreq/100`, so `0xCD` = 20.5 kHz. A transcoder running `lame -b 320` on a 128 kbps decode writes a tag honestly claiming 20.5 kHz while the audio brickwalls at 16 kHz. Read it with **`mp3guessenc`** (GPL, headless C) — it also identifies the encoder family when no LAME tag exists, and verifies the tag CRC. Expect **60–85%** of a real DJ pool's MP3s to carry a readable tag. Never require it.

**(b) Spectral cutoff + cliff sharpness** — for everything else:

```
8 windows × 10 s at t = 8%,18%…88% of duration    (skip fades)
FFT 8192 / Hann / 50% overlap / Welch per window
MAX-HOLD across windows, NOT mean
Analyse L and R separately; NO mono downmix, NO resample
```

Max-hold matters most: the encoder lowpass is a hard ceiling on the whole file, and averaging drags the apparent cutoff down during quiet passages, manufacturing false positives. Mono downmix destroys MP3 intensity-stereo evidence.

Decision core:

```
abstain if  <4 usable windows OR hf_14-16k < ref_1-4k − 60 dB   # dark/sparse track
confirmed if cliff ≥ 30 dB/500Hz AND cutoff near a table entry AND cutoff < 21 kHz
suspected if cliff 15–30 dB
none      if cliff < 15 dB                                       # natural rolloff — vinyl escape hatch
```

Cutoff→bitrate table (±400 Hz): 16.0k=128, 17.25k=160, 19.0k=192, 19.5k=V0, 20.0k=256, **20.5k=320**. ≥21 kHz with a continuous dither floor = lossless.

Use **`flaccheck`** (MIT, Rust, headless, `--workers N`, JSON out) as the verdict engine — 5-tier analysis with explicit band-limited abstention, reported 99% precision / 85% recall / 4% FP. Do **not** use auCDtect (closed Win32 binary, undistributable in a container, and weakest exactly at 320-vs-lossless).

**Tier — measurement outranks the container, always:**

```
T=5  lossless container, ancestor='none', cutoff ≥20.8kHz, eff_bits ≥16
T=4  lossless container, verdict 'abstain'
T=3  measured bandwidth ≥19.5kHz
T=2  measured bandwidth 17.0–19.5kHz
T=1  measured bandwidth <17.0kHz
```

**A FLAC with a confirmed lossy ancestor gets its tier from measured bandwidth, not 5. That one rule is the entire anti-cheat.**

Four outcomes, never binary, never destructive:

| Verdict | Action | Credit |
|---|---|---|
| `accepted` | B becomes `preferred_file_id`; A retained as an alternate | 1 |
| `rejected_not_better` | keep B as an alternate, don't promote | 0 |
| `rejected_fake` | quarantine, **do not delete**; show the evidence | 0, +1 strike |
| `review` | owner queue | held |

**Never overwrite A.** Store B alongside and flip the `preferred_file_id` pointer — reversible, and files are cheap while re-acquiring a rare promo is not.

**Always show evidence.** Render a spectrogram PNG (`ffmpeg -lavfi showspectrumpic=s=1024x512:legend=1`) with the measured numbers. A rejection with a picture reads as a system; one without reads as arbitrary, and will cost you contributors. Every automated rejection gets a one-click appeal into the owner queue. Strikes, not bans — someone can innocently upload a fake FLAC they were themselves given.

Tune asymmetrically: a false accept costs one wrongly-awarded credit; a false reject costs a contributor. Expect **5–15%** of a 90s-heavy dance catalogue to land in `review`. That's the correct price of not falsely accusing people.

**Honest limits.** 320 kbps MP3 vs true lossless is not reliably separable — the only discriminator is a 1.5 kHz window between LAME's 20.5 kHz ceiling and 22.05 kHz Nyquist. A motivated cheat (decode, inject shaped noise above 16 kHz, encode to FLAC) defeats this in minutes. HE-AAC/SBR passes cleanly. Opus and Vorbis have soft rolloffs with no brickwall to find. **This stops casual mistakes, not determined gaming — which for ten friends is the right target.**

Also: the `DR` penalty in the published scoring formula encodes an audiophile preference this pool may not share — a loud DR5 remaster may be exactly the club-ready copy a DJ wants. **Make DR informational-only; keep only the hard-clipping penalty.**

### AGPL

Essentia is AGPL-3.0, and §13 is the one copyleft clause that triggers without distribution. The research framed this as a commercial-service problem; **localchune is not commercial**, so the resolution is easy:

- Run **stock, unmodified** Essentia as a separate binary the worker `exec`s. Never link or import it into application code, never vendor patches.
- If §13 is ever invoked by one of the ten members, it's satisfied by pointing at Essentia's already-public upstream source.

Non-negotiable regardless: **Essentia's TensorFlow model zoo is CC BY-NC-SA 4.0** — no TempoCNN, no danceability classifiers, no mood models. The DSP algorithms above are unaffected. Same trap catches **madmom** (BSD badge, CC BY-NC-SA *models*, with an explicit "contact Gerhard Widmer" gate) and **tempo-cnn** (AGPL on code *and* weights, maddeningly, since it has the best published octave accuracy).

GPL tools — libKeyFinder, qm-dsp, mp3guessenc, mutagen — create **zero** obligations here: GPL has no network clause and SaaS is not distribution. This flips if a desktop client ever ships; at that point swap to `music-metadata` (MIT) and TagLib (LGPL/MPL).

---

## 8. Catalogue matching and artwork

### Spotify cannot be the data source

- A newly-registered app lands in **Development Mode**, which caps at **5 authorized users**. You have 8–10.
- Development Mode is defined by Spotify as non-commercial, requires the app owner to hold **Spotify Premium**, and allows one Client ID per developer.
- **Extended Quota Mode** — the only compliant path beyond that — has been organisation-only since 15 May 2025 and is being rejected below roughly 250k MAU.
- Developer Terms **IV.3.1**: *"you may not store, aggregate or create compilations or databases of Spotify Content."* An enrichment table **is** the prohibited database.
- **IV.3.2** permits only *"temporary caching of metadata and cover art"* — permanent R2 storage is not that.
- **II.4.2**: metadata and cover art must be accompanied by a link back to Spotify.

### The cascade (decided: MusicBrainz primary, Spotify deep-link only)

**Stage 0 — normalise + fingerprint.** `fpcalc` already ran for dedup; reuse it. Cache keyed on `content_sha256` so it's computed exactly once, ever.

**Stage 1 — AcoustID lookup.** `meta=recordings+releasegroups+releases+compress`, candidates filtered to `|Δduration| ≤ 5s`. Confidence 0.95 at AcoustID score ≥0.90 with a single recording cluster; 0.80 at 0.70–0.90.

**Stage 2 — ISRC lookup**, if the file carries one. Confidence 0.97 if it resolves *and* duration is within ±3 s.

> **Inverted from the obvious ordering, deliberately.** ISRC identifies *what the tagger claimed*; AcoustID identifies *the actual audio*. For DJ libraries the mix version is the entire point, and the single most common tagging failure in promo bundles is an ISRC copied from the wrong version. An ISRC-first cascade takes that stale tag and matches confidently and *wrongly*. **When they disagree, AcoustID wins** — and log the disagreement, it's a high-value signal. If ISRC resolves but duration is off by >5 s, that's the wrong-version signature: drop to 0.45.

**Stage 3 — fuzzy** MusicBrainz recording search on normalised artist + title with a duration window. Two passes: STRICT (mix token included), then LOOSE (mix token dropped).

**Stage 4 — Discogs enrichment, not matching.** Don't search Discogs. MusicBrainz stores Discogs URLs as *relationships*, so MBID → Discogs release ID is a free deterministic join. Use it only for label and catalogue number — the fields that make an electronic-music tool credible. Discogs' own image quota (1,000/day) is unusable at scale; the relationship join isn't affected.

**Stage 5 — artwork.** Cover Art Archive by MBID: `/release/{mbid}/front-500` → `/release-group/{mbid}/front-500` → uploader-supplied → generated placeholder.

**Stage 6 — Spotify deep link only.** One Search call to obtain the track URI for a "listen on Spotify" button. Store **nothing but the URI**. No metadata, no artwork, no audio features.

Thresholds: auto-apply ≥0.85; show as a user-confirmable suggestion 0.60–0.85; below 0.60 keep the uploader's own tags and mark unmatched. **Always retain the raw original tag strings** — cheap now, impossible to retrofit, and it lets the whole corpus be re-matched when coverage improves.

### Filename normalisation

Handles `01 - Artist - Title (Extended Mix) [Label].mp3` and `Artist_-_Title_(Original_Mix)`:

1. Prefer embedded tags; fall back to filename only when tags are empty or generic
2. Unicode NFKC, strip BOM/zero-width, collapse whitespace
3. Underscore de-mangling **guarded**: only if `count("_") ≥ 2 && count(" ") == 0`
4. Strip leading track number: `^\s*[\[\(]?\d{1,3}[\]\)]?\s*[-–—._·]+\s*`
5. Strip scene junk: `\b(320|256|192|128)\s?k(bps)?\b`, `\bwww\.\S+\b`, `-?\s?\[?(HQ|CDQ|WEB|VINYL|PROMO|FLAC|MP3)\]?`
6. Split on ` - `, normalising `--`/`–`/`—` first
7. Extract bracketed segments **by type** — don't blanket-strip: trailing `[Label]`/`[CAT001]` → label hint; `(Original Mix)`/`(Extended Mix)`/`(X Remix)`/`(Dub)` → **mix token, preserved separately**; `(feat. X)` → moved to artist credit
8. Canonicalise mix tokens: `Orig. Mix`→`original mix`, `Ext. Mix`→`extended mix`, `Rmx`→`remix`

> **The rule that matters most:** `(Original Mix)` is a Beatport-ism usually absent from MusicBrainz — drop it in the LOOSE pass. `(Extended Mix)` and `(X Remix)` denote genuinely **distinct recordings** — never drop those, or you match the wrong audio.

### Artwork hosting

Hotlink CAA by default. Cache into R2 **only** CAA-derived images, and only because archive.org's 307-redirect path is slow enough to justify it. Store `source`, `source_url`, `mbid`, `fetched_at` on every cached object and implement a purge-by-MBID endpoint.

Terms risk and copyright risk are different things and usually conflated: choosing CAA solves the *contract* problem, not the copyright one — CAA says plainly *"use the images at your own risk."* Never copy Spotify, Apple, Discogs, Deezer or Last.fm artwork into R2. (Last.fm's terms exclude artwork outright: *"You will not use any … images and/or artwork, whether or not accessible through the API."*)

**Uploader-supplied artwork is a first-class path**, not a fallback — it sidesteps licensing entirely and is the cheapest fix for the white-label and promo coverage gap, which is exactly the material this pool will be densest in.

### Coverage risk

AcoustID and MusicBrainz will miss white-labels, promos and unreleased edits. If the no-match rate exceeds ~25% on real traffic, self-host a MusicBrainz mirror (`musicbrainz-docker` + Live Data Feed) — removes the 1 rps ceiling entirely and enables trigram/duration matching impossible over HTTP. Same CC0 licence, no new terms exposure. Budget 250–500 GB disk. **Defer to v2.**

Respect MusicBrainz's **1 request/second** limit and set a real User-Agent — they block at IP level and deny 100% of requests over the limit.

---

## 9. Search and filters

The starting point in `cue-tracks` is thinner than remembered. Its `FileList.tsx` exposes **only**: debounced Fuse.js text search (threshold 0.4, keys name/title/artist/album), a two-handle BPM range slider, an "include files without tempo" checkbox, and two-level sort. **Key, genre, year, label, energy and rating do not exist as filters** — key/artist/duration are sort keys only. Everything past BPM has to be built.

Worth knowing before designing facets, from the 2,122-track Rekordbox export in that repo:

- `Tonality` — 25 distinct Camelot values, 51 empty, heavily minor-skewed (8A=217, 7A=194, 5A=188)
- `Genre` — **1,388 of 2,122 empty**, and the rest are dirty free-text: `Minimal/Techno/Tech House`, `Techno/Minimal/Tech House`, `Minimal/tech house`, plus 55 literally reading `"Genre: "`. **A genre facet needs normalisation and splitting, not raw values.**
- `Label` — 1,749 empty and case-dirty: `BPitch Control` / `BPitch Control;` / `Bpitch Control` are one label three ways
- `Year` — 742 are `"0"`
- `Rating` — Rekordbox stores 0/51/102/153/204/255 (star × 51), **not** 0–5, and 2,110 of 2,122 are 0. A rating filter would filter nothing.

### v1 filter set

| Filter | Control | Source |
|---|---|---|
| Text | debounced fuzzy over artist/title/album/label | Postgres `pg_trgm`, not client-side Fuse |
| BPM | two-handle range + "include untagged" | `bpm_display` |
| Key | Camelot picker with **harmonic-compatible expansion** | `key_camelot` |
| Genre | multi-select over a *normalised* vocabulary | `genre text[]` |
| Format | multi-select mp3/flac/wav/m4a/aiff | derived from `files` |
| Quality | min tier | `quality_tier` |
| Year | range | `release_date` |
| Label | multi-select, normalised | `label` |
| Uploader | multi-select | `file_claims` |
| Added | date range | `created_at` |
| In my crates | boolean | `crate_items` |

Search runs **server-side in Postgres** — 100k tracks is far past where shipping the whole catalogue to the browser for Fuse.js makes sense.

Two things to lift verbatim from `cue-tracks`:

- **`useSimilarityFilter.ts`** — full 1A–12A/1B–12B → 0–23 map, circular key distance with a +0.5 mode-change penalty, perfect-fifth (10A↔10B) = 0, and two blend-scoring formulas. Self-contained, dependency-free, and currently **untracked and never imported** — pure salvage.
- **The Camelot sort trick** (`FileList.tsx:120-125`): parse `key.match(/\d+/)` and `key.slice(-1)`, sort on `num * 10 + (mode === 'B' ? 1 : 0)`. Camelot keys sort wrong lexicographically (10A before 2A) in every naive implementation; this is the three-line fix.

---

## 10. Storage accounting

**R2 exposes storage metrics per *bucket* only** — `payloadSize`, `metadataSize`, `objectCount`, `uploadCount`, 31-day retention. No per-prefix, no per-owner breakdown. Attribution is entirely our problem.

Two numbers per member, both stable and both explainable:

- **Contributed** — "412 tracks / 38 GB contributed to the pool". Counts every upload that resolved to a track, including ones whose file was discarded as redundant. Never decreases. This is the social metric.
- **Occupying** — "your files occupy 31 GB". `SUM(files.byte_size) WHERE uploaded_by = you AND state = 'stored'`. The real bytes.

> This replaces the initially-proposed split-N-ways model, which had a UI bug: a member's number would *drop when a stranger uploaded a track they also had, and jump back when that stranger deleted it* — changing with no action by them, and unexplainable in a tooltip.

**Do not build a counter cache.** At 10 users and ~40k rows an indexed `SUM` is sub-millisecond and correct by construction. `UPDATE members SET bytes = bytes + $n` is non-idempotent, double-counts on retry, and drifts undetectably forever.

Three-layer convergence:

1. **Real-time** — R2 event notification → Cloudflare Queue → consumer Worker upserts using the authoritative `object.size` from the payload. `object.size` and `object.eTag` are **absent on delete events**, so the consumer looks up the prior size to decrement.
2. **Nightly** — cron Worker paginates `ListObjectsV2` (1000/page), diffs against the DB, reports orphans and phantoms. 40k objects ≈ 40 Class A ops. Ignore objects younger than ~1 h to avoid racing in-flight uploads.
3. **Weekly** — assert `SUM(files.byte_size)` ≈ bucket `payloadSize`. Drift means orphans or missed deletes.

Quota is **display-only in v1**. Ten trusted people don't need enforcement, and a hard cap creates a support burden immediately.

### Cost at 2 TB

| Line | Cost |
|---|---|
| R2 storage (2000 GB − 10 free × $0.015) | $29.85/mo |
| R2 operations (Class A + B, all inside free tier) | $0 |
| R2 egress | $0, always |
| Workers Paid (needed for Queues) | $5/mo |
| Cloud Run compute + egress | $0 (3% of always-free tier) |
| Artifact Registry | ~$0.10 |
| Supabase | $0 (free tier) |
| **Total** | **≈ $35/mo** |

Operations pricing is irrelevant at this scale — you'd need ~7M Class A ops/month before ops matched storage. Architect for correctness and reconcile as often as you like. The same 2 TB on S3 with ~500 GB/mo of listening is ~$46 storage **plus ~$45 egress**, growing with every play. That's the whole reason R2 is the right store.

---

## 11. Credits (v2) — and why there's no cron

The stated design was `credits int` plus a daily cron decrementing everyone by one. **Use `access_expires_at timestamptz` instead and write no cron at all.**

The argument:

- The mutable-integer model makes correctness depend on a scheduled job firing exactly once per day, forever. Making it idempotent requires a `(user_id, run_date)` ledger — so you end up with an extra table *and* a cron.
- The timestamp model deletes the failure class instead of mitigating it. Time decrements itself. Idempotency collapses to a `UNIQUE` constraint on the grant. "What is a day" has no timezone question, because an instant is an instant.
- **The decisive argument** is the interaction with JWT caching: an absolute expiry baked into a stale 1-hour-old token **still expires correctly** when `now()` passes it. A stale `credits` integer is simply wrong. The timestamp is the only model safe to cache in a token.

```sql
create table credit_grants (
  id         bigserial primary key,
  user_id    uuid not null references members(user_id) on delete cascade,
  days       int  not null check (days > 0),
  reason     text not null,          -- 'invite' | 'track_upload' | 'quality_upgrade' | 'manual'
  dedupe_key text not null,          -- 'invite' | 'track:<uuid>' | 'manual:<uuid>'
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)       -- the entire idempotency story
);

create or replace function public.grant_days(
  p_user uuid, p_days int, p_reason text, p_dedupe text
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_new timestamptz;
begin
  insert into public.credit_grants(user_id, days, reason, dedupe_key)
  values (p_user, p_days, p_reason, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;

  if not found then                      -- already granted: fully idempotent no-op
    select access_expires_at into v_new from public.members where user_id = p_user;
    return v_new;
  end if;

  update public.members
     set access_expires_at = greatest(access_expires_at, now())
                             + make_interval(days => p_days)
   where user_id = p_user
  returning access_expires_at into v_new;
  return v_new;
end $$;
```

`greatest(access_expires_at, now())` means a lapsed member resumes from *now* — no banking of dead time.

**Credits are a derived display number, never stored:**

```sql
greatest(0, ceil(extract(epoch from (access_expires_at - now())) / 86400.0))::int
  as credits_remaining
```

Earning rules:

- **Invite:** 30 days, `dedupe_key = 'invite'` (constant per user, so re-running provisioning can never re-gift)
- **New track:** +1 day when an upload creates a `track_id` nobody had
- **Quality upgrade:** +1 day when an upload dedupes but wins the §7.2 upgrade test — requires a hard monotone improvement (tier up, or measured cutoff up ≥1500 Hz, or the incumbent had a confirmed lossy ancestor and this one is clean T=5), not just a higher score
- **Redundant dupe:** 0

Enforcement is a JWT claim checked by RLS:

```sql
create or replace function public.jwt_is_active()
returns boolean language sql stable as $$
  select coalesce(
    ((select auth.jwt()) -> 'app_metadata' ->> 'access_expires_at')::bigint
      > extract(epoch from now())::bigint, false);
$$;
```

Stamped by a **Custom Access Token Hook** that also refuses to mint or refresh a token for an expired or revoked member. Staleness only bites in the permissive direction on *manual* revocation: set `revoked_at` and the session dies within ≤1 h; call `auth.admin.signOut(jwt, 'global')` to kill it immediately.

Put claims in `app_metadata`, never `user_metadata` — the latter is user-modifiable.

**DELETE policies deliberately omit the active check** — an expired member keeps their data and can still remove it. Everything else goes dark.

Keep `pg_cron` only for soft jobs (expiry-warning emails, pruning `cron.job_run_details`, which pg_cron does not clean up and which will eat disk).

---

## 12. Architecture

```
Browser (Astro + Solid islands, Cloudflare)
   │  presigned PUT ────────────────────────────────► R2  (audio, artwork)
   │  JWT ──► Supabase Edge Function (presign + quota check)
   │
   └──► Supabase Postgres (tracks, files, crates, members, RLS)

R2 object-create event
   └──► Cloudflare Queue
          └──► consumer Worker
                 ├─ mints short-TTL presigned GET/PUT
                 ├─ POSTs {file_id, get_url, put_url, analysis_version} ──► Cloud Run
                 └─ writes the returned result to Supabase
```

### App: Astro on Cloudflare

Matches `butternutcrack`, same platform as R2, cheapest option, and its persistent-player pattern is directly reusable.

**One thing that must change from butternutcrack:** it is `output: 'static'` and fetches Supabase at *build time* with a top-level `await` in `src/data/mixes.ts`, so every metadata change requires a redeploy. A pool where ten people upload continuously cannot work that way. localchune needs SSR (`@astrojs/cloudflare` adapter with a real `main` Worker) or client-side fetching. That also gives you the R2 binding butternutcrack's static-assets-only `wrangler.jsonc` doesn't have.

### Analysis worker: Google Cloud Run

Not Railway, not Workers.

- **Workers is dead three ways over.** 128 MB per isolate covering JS heap *and* all WASM allocations — a 3-minute stereo track is ~63 MB of float32 PCM before working buffers. No native binaries, ever. And `ffmpeg.wasm` fails four independent ways: a ~31 MB core against a 3/10 MB bundle cap, `workerd` blocking runtime WASM compilation from fetched bytes (exactly what ffmpeg.wasm does at init), no Web Workers, and CPU/memory exhaustion regardless.
- **Supabase Edge Functions cap CPU at 2 seconds.** You need 5–30. That number ends the discussion before the 256 MB ceiling and no-native-binaries problems.
- **Railway can't scale to zero for this shape.** Its Serverless mode detects inactivity by *outbound* traffic, and its own docs list open DB connections and telemetry as sleep-blockers. A queue-polling worker never sleeps, so you pay a permanent idle floor for ~100 minutes of monthly work.
- **Cloud Run**: request-based services get 180,000 vCPU-s + 360,000 GiB-s + 2M requests free every month, as a standing offering, not promo credit. Your ongoing load (200 tracks × ~30 s) is **~3% of that**. The entire 2,000-track backfill in a single month is ~33%. It genuinely autoscales through a 200-track burst *and* genuinely scales to zero. 60-minute request ceiling means no pathological FLAC times you out. And it's a plain Dockerfile behind an HTTP handler, so it lifts to Fly/Railway/ECS unchanged.

Cost of that choice: a GCP project, a service account, Artifact Registry, and ~40 lines of WebCrypto RS256 JWT signing in the Worker to mint a Google ID token (deploy `--no-allow-unauthenticated`). One afternoon.

**Fallback: Cloudflare Containers** ($5/mo Workers Paid floor, GA since 2026-04-13, 1–3 s cold start, one vendor, no OIDC plumbing). Two things to accept: memory and disk bill on *provisioned* resources for full wall-clock uptime while only CPU is active-billed — on a 4 GiB instance the included 25 GiB-hours is just 6.25 hours/month, and a container you forget to `sleepAfter` runs ~$26/mo. And **it has no autoscaling** — Cloudflare says so and points at `getRandom` for manual fan-out. Since absorbing a 200-track burst is the defining requirement, that gap is the real reason it's the fallback, not the $5.

### Orchestration: Cloudflare Queues

Free at this volume (10,000 ops/day on the free plan; ongoing load ~600 ops/month, full backfill ~6,000 in one day). Native R2 event notifications mean uploads trigger analysis with no poller anywhere. The consumer Worker is exactly where presigned-URL minting belongs.

**Keep the Cloud Run worker stateless and credential-free**: presigned URLs mean it never sees an R2 key; returning results to the Worker rather than writing to Postgres directly means the `service_role` key never leaves Cloudflare, and makes retries trivially safe because a failed run mutates nothing.

**Queues is at-least-once, so the handler must be idempotent.** Use `content_sha256` as the idempotency key and `ON CONFLICT (file_id, analysis_version) DO UPDATE`. One track per message, never a batch — a batch retry re-delivers every message in it.

**Free-plan Queues retention is 24 hours and non-configurable**, so the queue cannot be the system of record. `files.state` in Supabase is the truth, plus a Cron Trigger Worker that re-enqueues anything stuck in `analysing` for >1 h. That one cron makes the pipeline self-healing and the retention limit a non-issue.

### Streaming

FLAC/WAV/AIFF are not broadly streamable in-browser. Analysis emits a **128 kbps Opus preview** (~5.5 MB for 6 min) written back to R2 alongside the peaks JSON. The player streams the preview; download serves the original.

GCP egress is $0.12/GB with 1 GiB/month free, so pushing previews back from Cloud Run costs ~$0.14/mo ongoing and ~$1.44 for the whole backfill. Real but trivial. If it ever matters, move the transcode step to a Cloudflare Container ($0.025/GB, 1 TB included).

Playback itself: presigned GET, `<audio>`, R2's edge handles Range so seeking is free and egress is $0. **Never proxy audio bytes through a Worker.**

---

## 13. Reuse map

### From `butternutcrack` (Astro/Solid/Cloudflare/Supabase/R2)

| Take | Path |
|---|---|
| Module-singleton audio engine — one lazy `new Audio()`, Solid signals, pendingSeek-until-loadedmetadata, localStorage position bookmark, throttled save on 5 s / pause / `pagehide`. Survives client-side nav because it lives in a module, not a component. Pure serialize/parse split makes it unit-testable with no DOM. | `src/lib/playerStore.ts` |
| Persistent dock/immersive player. Mounted once in `Layout.astro` with `client:only` + `transition:persist`; the `astro:page-load` body-class re-apply is a non-obvious Astro ClientRouter workaround already debugged. | `src/components/PersistentPlayer.tsx` |
| Key-naming + shared client/server validators (`sanitizeFilename`, `audioKey`, timestamp-versioned `sleeveKey`, `isUploadKeyAllowed`, `validateMixInput`). Zero deps, 48 lines. | `src/lib/catalog.ts` |
| RLS discipline: enable on every table, **write no mutation policies at all**, expose mutations as `security definer` functions with `set search_path` + explicit `revoke execute from public`. | `supabase/migrations/20260717090000_catalog.sql` |
| Vitest harness that tests a browser audio singleton under the *node* environment via a `FakeAudio` stub + `globalThis` storage shims — 45 fast tests, zero jsdom. | `src/lib/playerStore.test.ts` |
| Play-count accumulator that can't be gamed by scrubbing (discards deltas >5 s, fires once at 30 s cumulative). | `src/lib/listens.ts` |

**Do not copy:** the `/__r2/put` dev endpoint (it `spawn`s `npx wrangler r2 object put` and only works on one machine with an authed CLI — and its `spawn` has no `.on('error')`, so a failure crashes the dev server); the localhost-Origin guard (it passes when `Origin` is absent, i.e. any non-browser client); the build-time Supabase fetch; the destructive delete-all-then-reinsert annotation save; the `annotations` RLS policy (`using (true)`, not gated on the parent being published).

### From `cue-tracks` / cuePlay (Next.js)

| Take | Path |
|---|---|
| **Camelot wheel math** — 1A–12A/1B–12B → 0–23 map, circular distance with mode-change penalty, perfect-fifth = 0, BPM % difference, two blend-scoring formulas. Highest-value domain logic in either repo; untracked and unimported, so pure salvage. | `src/app/hooks/useSimilarityFilter.ts` |
| Camelot composite sort trick (3 lines) | `src/app/components/FileList.tsx:120-125` |
| Circle-of-fifths colour palette + chip styling (`${color}15` bg / `${color}30` border) | `src/app/components/FileCarousel.tsx:97-127` |
| DJ filename normalisation before catalogue search — strip `[...]` and `(feat. …)`, fold into artist | `src/app/hooks/useSpotify.ts:117-139` |
| Match-score gating with `string-similarity` on title + joined artists, 0.6 confidence threshold | `src/app/api/spotify/search/route.ts:46-91` |
| Multi-format DJ XML parser skeleton — root-element detection (Rekordbox/Traktor/Serato/generic), `xml2js` with `{explicitArray: false, mergeAttrs: true}` (that option pair is what makes Rekordbox attributes readable as plain properties) | `src/app/api/parse-xml/route.ts` |
| Accessible sticky-header track table (`role="grid"`, `aria-labelledby` linking cells to column headers, sr-only caption, scroll-selected-into-view) | `src/app/components/TrackTable.tsx` |
| Two-tier album-art fallback precedence: remote match → embedded → placeholder | `TrackTable.tsx:131-153` |

**Do not copy:** the XML merge matcher (`fileName.includes(xmlTitle)` where `xmlTitle` is often `''`, and `''.includes` is always true — **every such XML track merges into the first audio file**); the Spotify token handling (`check-auth` returns httpOnly tokens back to client JS, defeating the point; CSRF `state` generated but never verified); `key: features.key`, which overwrites the Camelot string with Spotify's integer pitch class and silently breaks colour, sort and similarity; the IndexedDB write amplification (`store.clear()` + re-`add` the whole library on every change, each row carrying a base64 art data-URI).

### From `cue-parser`

Nothing for v1. It's a fork of `better-cue-parser` — a CD `.cue` **sheet** text parser (`ICueSheet`/`IFile`/`ITrack`, with `catalog`, `performer`, `songWriter`, `isrc`, pregap/postgap, indexes). No album art, no filters, no Spotify. Genuinely useful later if you want to ingest a CUE-split album or extract cue points, but it is not the "filters" repo — that was `cue-tracks`.

---

## 14. Build order

1. **Auth + schema.** `allowlist`, `members`, `credit_grants`, `grant_days()`, before-user-created hook (verify a non-allowlisted Google account gets 403 and creates **no** `auth.users` row), owner seed migration, admin page.
2. **Upload.** Presigned PUT + multipart, client duration pre-flight, batch UI with resume journal, server-side duration re-verify, `files` rows.
3. **Analysis worker.** One Cloud Run container: decode → fpcalc → key/BPM → loudness → peaks → tags → quality forensics. Queue + consumer Worker + the stuck-job cron.
4. **Dedup.** Fingerprints table + GIN, candidate query, offset-swept BER, bands, `assign_track` with the advisory lock, merge/undo, review queue with the divergence strip.
5. **Pool UI.** Track list, filters, player, download.
6. **Crates.**
7. **Catalogue matching.** AcoustID → MusicBrainz → CAA, uploader artwork upload, confirm-match UI.
8. **Calibration pass** at ~2k tracks: reset `T_high`/`T_low` from your own library, tune the `query_items` mask by measurement.
9. **v2:** credits enforcement, crate sharing, MusicBrainz mirror if no-match rate >25%.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Wrong auto-merges destroy someone's crates | Merges reversible by design; crates read through `canonical_track_id()` and are never rewritten. Add a "recent merges" feed so wrong ones get noticed. |
| Review queue is demoralisingly large at first | Expect high hundreds on the first few thousand files. Build the bulk "apply to similar" action earlier than feels necessary. |
| Vinyl rips at different speeds never dedup | Accepted for v1. Panako 2.0 if it becomes a real problem. |
| BPM octave errors | Genre prior + one-click ×2/÷2 persisted to `bpm_display`. Not fixable in the analyser. |
| Fake-upgrade false positives insult contributors | Abstain generously (5–15% to review is correct), always show the spectrogram, always allow appeal, strikes not bans. |
| MusicBrainz coverage gap on white-labels | Uploader-supplied artwork and tags as a first-class path, not a fallback. |
| Thresholds are guesses | Explicit calibration step at ~2k tracks; every decision records the thresholds it used. |
| GCP account is a second cloud to operate | Fallback to Cloudflare Containers is a documented swap; the worker is a plain container either way. |
| Free Supabase projects pause after ~7 days idle | Would silently break the stuck-job cron. Monitor, or take the paid tier. |

---

## 16. Open questions

Ranked by how much the answer changes the build.

1. Backfill — dump all ~2k tracks day one, or trickle? Sets max-instances and whether Supabase needs a rate limit in front.
2. Genre: normalise to a controlled vocabulary, or free tags? Decides whether the genre facet is usable at all.
3. Crate sharing in v2 — read-only publish, or collaborative?
4. Cap on max `access_expires_at`? Without one a bulk uploader banks years in an afternoon.
5. Expired member: fully dark, or can still see (not download) their own tracks?
6. Trust pre-existing Rekordbox/Serato/Mixed-In-Key BPM+key tags when present, or always re-analyse and flag disagreement?
7. Camelot or Open Key as primary display? (Store both regardless.)
8. Cue points / beat grids from Rekordbox XML — in scope later? Changes whether `beat_grid` needs to round-trip.
9. Second Google account for the same person — allowlist keyed on email forever, or person-level invite?
10. Retention on rejected and quarantined uploads before a sweeper hard-deletes.
