# localchune — PRD

*Private, invite-only track pool for a DJ circle (~8–10 people). Cloudflare R2 for objects, Supabase for auth + Postgres, Astro on Cloudflare for the app, Cloudflare Containers for audio analysis.*

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

One container, one decode, one pass. Each file runs once, in a Cloudflare Container.

### What it produces

| Output | Tool | Notes |
|---|---|---|
| Decoded duration | Essentia `AudioLoader` | authoritative; drives the 15-min gate |
| Chromaprint fingerprint | `fpcalc` (LGPL 2.1) | doubles as the AcoustID lookup key — see §8 |
| Key | Essentia `KeyExtractor(profileType='edmm')`, plus `edma` and `bgate` stored alongside | edmm ranks first on GiantSteps (~70–72 weighted / ~63.7 correct) vs QM's 50.4 / 39.6. These are **DSP parameters, not neural models** — no CC-NC exposure. |
| BPM + **downbeats** | **Beat This!** (CPJKU, ISMIR 2024) | **MIT on both code *and* weights.** Better than Essentia's `RhythmExtractor2013`, and it gives **downbeats** — bar-1 alignment, which is what a DJ tool actually needs and what Essentia's free DSP path largely lacks. **Derive BPM by a least-squares fit over the beat index — never the median inter-beat interval.** See §7.1: measured, the median reports 130.43 on a 128.000 BPM track and 176.47 on a 174.000 one, because the model snaps beats to a ~20 ms grid. The fit gives both exactly. |
| Loudness | `LoudnessEBUR128` + `ReplayGain` | LUFS-I, LRA |
| Waveform peaks | inline reshape of the decoded array | 1000 min/max buckets, <0.01 s, ~41 KB JSON |
| Embedded tags + art | `music-metadata` (MIT) or `mutagen` | keep raw tags forever — enables corpus-wide re-matching later |
| Quality forensics | see §7.2 | drives the upgrade decision |

**Do not add `audiowaveform`** (BBC). It's a whole extra decode pass and a GPL dependency to replace a five-line NumPy reshape.

### 7.1 Measured compute budget

All measured locally on Apple M1 (8 cores), 6:00 44.1 kHz stereo, `ffmpeg` 8.0.1, `fpcalc` 1.5.x, `beat_this` @ HEAD, torch 2.13.0. Not estimates.

| Step | CPU | Peak RSS | Notes |
|---|---|---|---|
| `ffprobe` + tag read | ~0.05 s | — | |
| **`fpcalc` raw fingerprint** | **0.39 s** | small | emits **2,886 ints for 6:00** — exactly the 8/s the schema assumes |
| Decode → f32 mono 44.1k | 0.46 s (FLAC) / 0.77 s (MP3) | — | shared; feed everything from one buffer |
| **Beat This! @ 1 thread** | **13.2 s** | **977 MB** | **65% of the entire budget** |
| Essentia key × 3 profiles | ~0.6 s | ~470 MB | 0.14 s per profile |
| `ebur128` loudness + true peak | 2.16 s | — | |
| `astats` (bit depth, clipping) | 1.24 s | — | |
| Forensics: 8 × 10 s windows | 0.31 s | — | `-ss` **before** `-i` — seek-then-decode is nearly free |
| Forensics: FFT + cutoff | ~0.5 s | ~200 MB | |
| `flaccheck` | ~1 s | small | |
| Waveform peaks | <0.01 s | — | inline reshape |
| Opus 128k preview | 3.33 s | — | **lossless sources only**; 3.9 MB out |
| Spectrogram PNG | 0.74 s | — | **only on a suspect verdict**, not every track |

**Totals: ~20 s CPU for a lossless track (with preview), ~16 s for an MP3.** Cloudflare Containers run on x86 hardware, not the Apple M1 used for these measurements. x86 is about **1.75×** slower, so every cost figure in this document is built on **~35 s of billed CPU per track**.

**Three findings that change the design:**

1. **More threads cost more money, not less.** Beat This! uses 13.2 s of CPU on 1 thread. On 8 threads it uses **19.5 s of CPU**, even though wall-clock time drops to 5.7 s. Cloudflare bills active CPU time, so 8 threads cost 48% more for the same result. **Set `torch.set_num_threads(1)`. Use a 1 vCPU instance and process one file at a time. Accept the longer wall-clock time.** This is a background job; nobody watches it run.
2. **Export Beat This! to ONNX and run `onnxruntime` (MIT).** A PyTorch image is about 2.5 GB; an onnxruntime image is about 300 MB. Image size matters for cold start on Cloudflare Containers, and ONNX CPU inference is typically 1.5–3× faster than eager PyTorch. This is the single highest-leverage optimisation available and it should be **benchmarked as the first task of the analysis worker**, because 65% of the compute budget rides on it.
3. **Derive BPM by least-squares fit over the beat index, never from the median inter-beat interval.** Measured: on a 128.000 BPM track median-IBI gives **130.43**; on 174.000 it gives **176.47**. The least-squares fit gives **128.000** and **174.000** exactly. Beat This! quantises beat times to its ~20 ms frame grid (IBI std ≈ 9 ms), and the median inherits that quantisation while a linear fit averages it out. A 2% BPM error is beatmatching-fatal.

```python
k = np.arange(len(beats))
slope, _ = np.linalg.lstsq(np.vstack([k, np.ones_like(k)]).T, beats, rcond=None)[0]
bpm = 60.0 / slope
```

Memory: run each stage as a **sequential subprocess** (which §7.3 requires anyway for Essentia) so peak RSS is `max(stage)` ≈ 1 GB, not the sum. Peak RSS of 977 MB would fit a 2 GiB instance, but Cloudflare Containers enforce a **minimum of 3 GiB of memory per vCPU**. So the container runs at **1 vCPU / 3 GiB memory / 6 GB disk** — the 3 GiB is a platform floor, not a choice, and it costs $0.30 extra across the entire 2,000-track backfill (§10).

> **Encouraging but not proof:** Beat This! returned **176.47** on the 174 BPM test track — it did **not** half-time it, where Essentia's three estimators all returned 87.00 on the research agent's DnB test. But the test track here is a clean synthetic kick pattern, which is far easier than real drum & bass with a half-time bassline. Treat this as a positive signal, not as evidence the octave problem is solved. The ×2/÷2 control below still ships.

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

### 7.3 Licensing — decided: open-source under AGPL-3.0

Essentia is AGPL-3.0. §13 is the one copyleft clause that triggers **without** distribution:

> "if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network … an opportunity to receive the Corresponding Source of your version by providing access to the Corresponding Source from a network server at no charge"

**Publishing the repo collapses this to a single footer link.** That is a far better trade than handicapping key detection to dodge a licence we'd satisfy anyway — the permissive substitutes cost 8–20 points of key accuracy, and key is the most user-visible number in a DJ pool.

Six rules, all cheap:

1. **License localchune's own source files MIT or Apache-2.0** in the headers. README states: *"This project's own source is MIT. The distributed combination is AGPL-3.0 because it includes Essentia."* Your code stays permissive and reusable; only the combination is copyleft. If Essentia is ever swapped out, relicensing is a README edit rather than chasing every contributor for consent.
2. **Invoke Essentia as a subprocess** — `streaming_extractor_music`, argv in, JSON out. **Never `import essentia`.** Under AGPL it makes no difference today, but the FSF treats dynamic linking as creating a combined work while `fork`/`exec` with simple communication is separate programs. Costs nothing now, preserves the exit later. Guard it in code review: the mere-aggregation position erodes the moment someone adds a C++ shim or round-trips Pool objects.
3. **Ship zero `.pb` files.** MTG's own pages contradict each other — [models.html](https://essentia.upf.edu/models.html) says CC BY-NC-**SA** 4.0, [licensing_information.html](https://essentia.upf.edu/licensing_information.html) says CC BY-NC-**ND** 4.0. SA vs ND is material: under ND you may not redistribute *any* derivative of the weights, including an ONNX conversion. Never resolving this is free, because **everything we need is DSP** — `KeyExtractor` (including the `edma`/`edmm` EDM profiles), `LoudnessEBUR128`, `ReplayGain` and the spectral descriptors load no model. `streaming_extractor_music` itself uses only DSP.
4. ~~Build Essentia without FFTW~~ **Superseded at M3 Task 8, deliberately.** The shipped image uses MTG's official prebuilt `essentia_streaming_extractor_music`, which **is** linked against FFTW (GPL). This is acceptable **only under our AGPL publication posture** — the combination we distribute is AGPL anyway, and GPL is compatible one-way. What it costs: buying a commercial Essentia licence later would also require rebuilding against KissFFT, since UPF cannot sublicense FFTW. Recorded in `worker/Dockerfile` alongside the binary provenance. (The alternative — compiling Essentia from source without FFTW — was rejected as a large build for an option we do not currently hold.)
5. **§13 compliance:** a "Source" link in the footer pointing at the public repo, **pinned to the deployed commit SHA**, plus `/api/build-info` exposing that SHA so the link is verifiable. An offer to email source on request does *not* satisfy §13 — it must be fetchable from a network server.
6. **Before the first public push:** `gitleaks detect` over the working tree **and** full history; `.env` gitignored; rotate any credential ever committed (rewriting history does not un-leak a pushed key); confirm no audio, no DB dump, and no library manifest is in the tree — that's the likelier embarrassment than a stray API key.

**What open-sourcing does not solve:** the CC-NC model zoo stays non-commercial forever, and "non-commercial" is fuzzier than it looks — a donation tier or Patreon-gated invite can be argued into commercial advantage. Rule 3 makes this moot rather than relying on our current status.

**Fallback if commercial optionality is ever wanted** — a complete no-AGPL, no-CC-NC bill of materials: Beat This! (MIT) + keyfinder-cli/libKeyFinder (GPL-3.0, subprocess) + libebur128 (**MIT**) + music-metadata (MIT) or TinyTag (MIT) + LGPL-only ffmpeg (`--disable-gpl --disable-nonfree`) + DIY numpy peaks. Better beats, ~8 points worse key. Shippable. Note: **avoid `mutagen`** (GPL-2.0) in that world, and note distro ffmpeg builds are usually `--enable-gpl`, which makes the *binary* GPL even though the `ebur128` filter source is LGPL.

**Do not email UPF for a commercial quote.** Non-commercial, ten users, publishing anyway — no need, and it's a university tech-transfer office with an unpublished price and weeks of latency.

Also still true: **madmom** is a trap (BSD badge, CC BY-NC-SA *models* with an explicit "contact Gerhard Widmer" gate for commercial use), and **tempo-cnn** is AGPL on code *and* weights despite having the best published octave accuracy.

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

**Stage 2b — Apple ISRC bridge.** If Stage 1 missed, fuzzy-match against Apple Music API, take its ISRC, and resolve deterministically via MusicBrainz `/ws/2/isrc/{isrc}`. See §8.1.

**Stage 5 — artwork.** **Apple Music API first**, Cover Art Archive second. See §8.1 — inverted from the obvious ordering for a good reason.

**Stage 6 — Spotify deep link only.** One Search call to obtain the track URI for a "listen on Spotify" button. Store **nothing but the URI**. No metadata, no artwork, no audio features.

### 8.1 Apple — use the Apple Music API (we already hold the Developer Program membership)

**Decision: Apple Music API primary, iTunes Search API as an unauthenticated fallback.**

The $99/yr Apple Developer Program membership is **already held**, so `api.music.apple.com` costs zero marginal spend. There is no separate Apple Music API fee. Critically, a **developer token alone** covers every `/v1/catalog/*` endpoint — **no Apple Music subscription and no Music User Token are required**. Those are only needed for `/v1/me/*` (a user's own library and playback), which we never call.

> Verbatim, [Generating Developer Tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens): *"To make requests to the Apple Music API, you need to authorize yourself as a trusted developer and member of the Apple Developer Program."* And [User Authentication for MusicKit](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit): *"Apple Music API requires the inclusion of a Music User Token for any requests for data specific to an Apple Music subscriber, such as to fetch content from the user's library."*

**Token mechanics.** MusicKit identifier + private key (`.p8`) from the developer portal, plus the 10-character Team ID and Key ID. JWT signed **ES256 only** — Apple rejects unsecured tokens or any other algorithm with a `401`. `exp` must not exceed `15777000` seconds (6 months), so it's re-minted twice a year by a scheduled job. Rate limits are unpublished; back off exponentially on `429`. Catalog endpoints are server-side cached and rarely throttled — it's `/v1/me/*` that bites, and we don't touch it.

**What we get over the free iTunes Search API:**

1. **ISRC — the important one.** `/v1/catalog/{sf}/songs?filter[isrc]=…` and ISRC on the Songs resource. iTunes Search returns no ISRC at all (verified absent on both `/search` and `/lookup`). ISRC turns a fuzzy Apple match into a **hard, deterministic join** into MusicBrainz via `/ws/2/isrc/{isrc}`. That matters most for the tracks AcoustID misses — see the bridge path below.
2. **A contractual artwork API.** An `artwork` object with a `{w}x{h}` URL template and explicit `width`/`height` maxima, instead of string-hacking `artworkUrl100`. Same 3000px ceiling, but a documented surface rather than undocumented CDN behaviour that Apple owes us nothing about.
3. **`bgColor` and `textColor1..4`** — Apple's extracted palette per artwork. Free auto-theming for track cards, and a cheaper, better version of butternutcrack's blurred-cover backdrop.
4. `composerName`, `editorialNotes`, `previews`, proper storefront handling.

**The ISRC bridge — where this earns its place in the cascade.** Apple's ISRC is only available *after* a match, so it is not a matching input. But it converts a soft match into a hard one:

```
AcoustID → MBID                            (primary; most reliable)
  ↓ miss
Apple fuzzy match → Apple ISRC → MB /isrc/ → MBID   (deterministic recovery)
  ↓ miss
MB fielded fuzzy search
```

That second rung recovers part of the coverage gap that fuzzy string matching alone would leave unmatched. It does **not** help with white labels — nothing does.

**What it does *not* fix — both tested, both still true:**

- **Genre does not improve.** `genreNames` is an array, but it returns the *same* leaf genre with ancestors appended — `["Techno","Music","Dance"]` where iTunes returns `primaryGenreName: "Techno"`. Extra parents, not extra precision. Live iTunes results: de Witte → `Techno`, DJ Koze → `House`, but Burial, Aphex Twin, Four Tet, Peggy Gou, Objekt, Overmono and Two Shell **all → `Electronic`**, and Larry Heard → `Dance`. ~30% useful; it is label-supplied delivery metadata, not classification. **Genre still comes from Discogs styles (§9.1).**
- **Coverage does not improve** — it's the same catalogue behind both APIs. Tested against Anunaku, Sedef Adasi, Interplanetary Criminal and Hodge: Apple and MusicBrainz **miss the identical tracks.** Apple wins on mainstream and recent major-label; MB wins on reissues, bootlegs and obscure compilations.
- **No label or catalogue number worth having.** `recordLabel` exists only on Albums and is usually a distributor ("Believe", "The Orchard"), not the imprint. Imprint identity — Hessle Audio, Livity Sound — is how DJs actually navigate crates, so **label still comes from MusicBrainz/Discogs.**
- **Store dates, not original release dates.** A 1992 Aphex track on a 2012 reissue reports 2012. Original release date still comes from MB release-groups.
- **Silent wrong matches.** Apple never says "no confident match" — it returns its best guess. A Bristol dubstep query came back with Neo-Soul metadata. **Gate every result on normalised artist AND title similarity plus a duration check within ±3 s** against the decoded duration, and drop anything below threshold to unmatched. Without that gate this pipeline actively degrades the library.

**iTunes Search API stays as a fallback** — free, no key, no token to expire, Akamai-cached for 24 h. Documented at *"approximately 20 calls per minute"* though 30 rapid uncached queries all returned 200, so it's soft. Use it if token minting ever fails, and for the artwork URL-rewrite trick (`artworkUrl100` → `3000x3000bb.jpg`, verified 200 OK at 2.4 MB) as a belt-and-braces path.

**Compliance.** Album art is "Promo Content" under Apple's terms and must sit *"proximate to a 'Download on iTunes' … badge … that acts as a link directly to pages within iTunes."* The no-caching clause in that same paragraph is scoped to *audio previews*, not artwork. MusicKit's terms attach the equivalent "Listen on Apple Music" badge requirement. Render art with the returned `url` behind an official badge — twenty minutes, and it puts a private display inside the spirit of the clause that actually binds.

> **Two things to verify first-hand, which the design research could not.** Both need the developer account we already have:
> 1. **Confirm the `genreNames` finding with one live authenticated call.** The claim that it returns the same leaf plus ancestors is *inferred from the shared taxonomy, not proven* — no authenticated call was possible during research. Five minutes to settle, and it's the only thing that could change the genre decision.
> 2. **Read the metadata-retention clause in the Apple Developer Program License Agreement (MusicKit attachment).** Research found **no** caching prohibition but also could not read the authoritative text — the PDLA sits behind developer-account auth and Apple's doc pages are JS-rendered. Do **not** assume either way. Since we're persisting Apple metadata in Postgres, this is a real gap to close before build.

**Artwork precedence:** uploader-supplied → Apple Music API artwork (3000px) → iTunes rewrite → Cover Art Archive → embedded ID3 → generated placeholder.

**MusicKit JS is irrelevant** — a browser-side auth and DRM-playback shim that fetches from the same REST endpoints. Nothing to offer a server-side worker.

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

### 9.1 Genre — Discogs *styles*, from the CC0 dumps

Genre needed its own answer because none of the obvious sources work. Measured during design:

| Source | Vocabulary | Coverage | Licence | Verdict |
|---|---|---|---|---|
| **Discogs monthly dumps** | 15 genres + **757 styles** | best in class for 12"/white-label electronic | **CC0** | **primary** |
| Discogs REST API | same | same | ToU: no caching beyond need, 6 h staleness rule | gap-filler only |
| MusicBrainz genres | 2,176 curated | **9.4% of recordings**, 54% of release-groups | CC0 | weak third tier |
| iTunes `primaryGenreName` | Apple taxonomy | ~30% useful | promo terms | weak prior only |
| Beatport | best there is | — | **no public dev programme** | unavailable |
| Last.fm tags | folksonomy | decent | non-commercial, noisy | skip |
| Spotify | artist-level only | — | ToS bars retention | skip |
| AcousticBrainz | — | — | **shut down 2022** | do not use |

Three findings that decide it:

1. **MusicBrainz does not solve genre.** Measured over a 1,000-recording sample across ten well-known electronic artists: **9.4% of recordings have any genre at all.** Release-group level is 54%, artist level is 9/10. And that's a *generous upper bound* — famous artists. Use **release-group** genres as a third-tier fallback (per-release, so a techno artist's ambient B-side sits elsewhere); **never surface artist-level genre as a track's genre** — Jamie Jones carries 16 artist genres, which is noise.
2. **Discogs publishes monthly XML dumps under CC0.** This is the unlock. The REST API's Terms of Use forbid caching *"longer than is necessary"* and displaying anything more than six hours stale — fundamentally incompatible with a persisted facet. The dumps have no such constraint: parse once, keep forever, re-sync monthly. And the join is free — MusicBrainz carries a Discogs URL relationship (`inc=url-rels`) on release, release-group, artist and label, so it's recording → release-group → Discogs master ID → `styles[]` from the local dump, with **zero Discogs API calls**.
3. **`style`, not `genre`, is the useful field.** Discogs' genre list is 15 entries and everything here is `Electronic`. Its 757 styles include `Tech House`, `Deep House`, `Minimal`, `Dub Techno`, `UK Garage`, `Speed Garage`, `Bassline`, `Ghetto House`, `Juke`, `Footwork`, `Broken Beat`, `Balearic`, `Nu-Disco`, `Electroclash`, `Schranz`. Use the **master** level (canonical rollup); fall back to the release's own styles when there's no master — very common for white labels and digital-only.

> Gaps you'll hit in Discogs' vocabulary: **no Afro House, no Melodic House, no Organic House, no Bass House, no Jersey Club.** It does have Amapiano. Plan local extension terms in the schema from day one, flagged so you always know which can't round-trip.

**Schema:**

```sql
create table style (
  canonical      text primary key,
  family         text not null,       -- house | techno | trance | breaks | bass | jungle | downtempo | disco
  discogs_native boolean not null
);

create table style_synonym (
  key        text primary key,        -- casefolded, de-punctuated match key
  canonical  text not null references style(canonical),
  confidence real not null default 1.0
);

create table track_style (
  track_id   uuid not null references tracks(id) on delete cascade,
  style      text not null references style(canonical),
  source     text not null check (source in
    ('manual','discogs_master','discogs_release','user_tag','musicbrainz_rg','audio_model','musicbrainz_artist')),
  confidence real,
  primary key (track_id, style, source)
);
```

**Provenance is mandatory.** Without `source` you can never tell a Discogs-grade label from a model guess, and you can never safely re-run normalisation. Precedence: `manual > discogs_master > discogs_release > cleaned user_tag > musicbrainz_rg > audio_model > musicbrainz_artist`. Take the highest non-empty tier; don't union across tiers except to render as "suggested".

**Normalisation pipeline** (deterministic, idempotent, re-runnable when the synonym table changes):

1. **Reject sentinels first** — drop `^\s*(genre:?|unknown|other|n/?a|none|-{1,}|\d+)\s*$` case-insensitively. This kills the 55 `"Genre: "` rows. Strip a leading `Genre:` prefix before anything else.
2. **Split** on `[/,;|]`, plus ` - ` and ` & ` when both sides resolve to known styles.
3. **Trim**, collapse whitespace, strip quotes/brackets/asterisks.
4. **Casefold → match key**: lowercase, NFKD, strip diacritics, remove `-`, `_`, `.` and all whitespace. So `Tech House`, `tech-house`, `TECHHOUSE`, `Tech  house` all key to `techhouse`.
5. **Look up** in `style_synonym`. Seeded with the identity mapping of every canonical style plus hand-written aliases (`dnb`/`d&b` → `Drum n Bass`; `minimaltechhouse` → *both* `Minimal` and `Tech House`; bare `progressive` → `Progressive House`).
6. **Unmatched tokens go to a quarantine table**, never silently dropped and never auto-invented as canonical. The top-50 unmatched strings are the weekly synonym backlog.
7. **Emit** deduped, sorted `text[]` with a GIN index, plus a derived single-valued `family` so the UI can do coarse chips → nested styles.

Worked: `"Minimal/Techno/Tech House"` and `"Techno/Minimal/Tech House"` both → `{Minimal, Tech House, Techno}`. Order-insensitive, which is the whole point.

**Starter vocabulary — 54 styles** (Discogs spellings; `*` = local extension):

- **House (14):** House, Deep House, Tech House, Progressive House, Electro House, Minimal, Microhouse, Acid House, Garage House, Italo House, Tribal House, Hip-House, Ghetto House, Amapiano
- **House extensions (4):** Afro House\*, Melodic House\*, Organic House\*, Bass House\*
- **Techno (7):** Techno, Minimal Techno, Hard Techno, Dub Techno, Deep Techno, Detroit Techno\*, Melodic Techno\*
- **Trance (5):** Trance, Progressive Trance, Psy-Trance, Goa Trance, Hard Trance
- **Electro / Disco (7):** Electro, Electroclash, Disco, Nu-Disco, Italo-Disco, Eurodance, New Beat
- **Breaks / Bass (9):** Breakbeat, Breaks, Progressive Breaks, Big Beat, Broken Beat, UK Garage, Speed Garage, Bassline, UK Funky
- **Jungle / Hardcore (5):** Drum n Bass, Jungle, Breakcore, Hardcore, Gabber
- **Club (3):** Juke, Footwork, Baltimore Club
- **Downtempo (8):** Ambient, Dark Ambient, Downtempo, Trip Hop, Balearic, Leftfield, IDM, Dub
- **Bass/US (4):** Dubstep, Grime, Trap, Future Bass
- **Adjacent (3):** Industrial, EBM, Synthwave

**Audio classification is tier four and coarse only.** Essentia's `genre_discogs400` / Discogs-EffNet is CC BY-NC-SA — fine for a non-commercial pool, but it violates §7.3 rule 3 (ship zero `.pb` files), so treat it as opt-in and out of the default image. Regardless of licence, it will **not** reliably separate Tech House from Minimal from Deep House — those differ by groove weight, swing and label context, and Discogs' own human annotators disagree. Use it to assign a **family** only, tagged `source='audio'` with a confidence, and let the UI de-emphasise it.

**The highest-value data in the system is manual correction.** Make the "unclassified" bucket a first-class UI element with a one-click assign, flowing straight to `source='manual'`, which outranks everything.

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

### Cost — the whole project

> An earlier draft costed a hypothetical 2 TB. That was carried over uncritically from a research scenario and it is **wrong for this project by ~40×**. 2,000 tracks is nowhere near 2 TB — you'd need ~32,000 WAVs to get there. Corrected below from measured file sizes.

**Measured sizes**, 6:00 44.1/16 stereo: WAV **61 MB**, FLAC ~**38 MB** (real music; my synthetic test compressed to 18 MB), MP3 320 **14 MB**, M4A 256 ~12 MB, Opus 128k preview **3.9 MB**.

Realistic pool mix for 2,000 tracks — 55% MP3, 25% FLAC, 12% WAV/AIFF, 8% M4A → **~26 MB average**:

| | GB |
|---|---|
| Audio (2,000 tracks × 26 MB) | 51 |
| Opus previews (740 lossless × 3.9 MB) | 2.9 |
| Artwork (2,000 × ~400 KB @ 1200px) | 0.8 |
| Waveform peaks (2,000 × 41 KB) → **R2, not Postgres** | 0.08 |
| **Total** | **~55 GB** |

Even an all-lossless worst case is 2,000 × 62 MB = **124 GB**.

**Monthly:**

| Line | Cost |
|---|---|
| R2 storage — (55 − 10 free) GB × $0.015 | **$0.68** |
| R2 Class A + B operations | $0 (free tier by ~3 orders of magnitude) |
| R2 egress | **$0, always** |
| Cloudflare Containers — CPU, memory, disk at 200 tracks/mo | **$0.00** (inside Workers Paid allowances) |
| Supabase | $0 (free tier) |
| Apple Developer Program | $0 marginal — already held |
| **Cloudflare Workers Paid** — required for Queues and Containers | **$5.00** |
| **Total** | **≈ $5.68/month** |

Growth: +200 tracks/mo ≈ +5.2 GB ≈ **+$0.08/mo, each month**. Year-1 end ≈ 117 GB ≈ $1.61/mo storage, so **~$7/month**.

**Backfill (one-off):** 2,000 tracks × ~35 s of billed CPU = 70,000 vCPU-s, and 3 GiB × 70,000 s awake = 210,000 GiB-s of memory. After the Workers Paid allowances (22,500 vCPU-s and 90,000 GiB-s included free each month), the backfill costs **$0.95** in CPU and **$0.30** in memory. Disk stays fully inside its allowance at **$0.00**. Add **$0.03** for the `sleepAfter` idle tails between bursts. **Total: $1.28, once.** The instances stay warm when tracks are fed back to back, so the idle tail is paid once per burst, not once per track.

**The headline: Workers Paid at $5 is the single largest line item — it costs more than all the storage and all the compute combined.** Unlike an earlier design built around Google Cloud, this line is no longer skippable: Cloudflare Containers itself requires the Workers Paid plan, with no free tier at all. So even if the Supabase Edge Function called the container directly and skipped Queues, the $5/month floor would remain. Queues is effectively free at this volume (see below), so there is no lever left to cut this line.

Operations pricing is irrelevant here — you'd need ~7M Class A ops/month before ops matched storage. Architect for correctness and reconcile as often as you like. For comparison, the same content on S3 with modest listening would add a **per-play egress line that grows forever**; R2's zero egress is the entire reason it's the right store.

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
                 ├─ gets a Durable Object stub (one container instance)
                 ├─ DO reads the file from R2 through a binding, streams it
                 │  to the container, and calls its /analyze endpoint
                 ├─ DO pulls derived artifacts back and writes them to R2,
                 │  through the same binding
                 └─ consumer Worker writes the returned result to Supabase
```

### App: Astro on Cloudflare

Matches `butternutcrack`, same platform as R2, cheapest option, and its persistent-player pattern is directly reusable.

**One thing that must change from butternutcrack:** it is `output: 'static'` and fetches Supabase at *build time* with a top-level `await` in `src/data/mixes.ts`, so every metadata change requires a redeploy. A pool where ten people upload continuously cannot work that way. localchune needs SSR (`@astrojs/cloudflare` adapter with a real `main` Worker) or client-side fetching. That also gives you the R2 binding butternutcrack's static-assets-only `wrangler.jsonc` doesn't have.

### Analysis worker: Cloudflare Containers

Not Railway, not Google Cloud, not plain Workers.

- **Workers is dead three ways over.** 128 MB per isolate covering JS heap *and* all WASM allocations — a 3-minute stereo track is ~63 MB of float32 PCM before working buffers. No native binaries, ever. And `ffmpeg.wasm` fails four independent ways: a ~31 MB core against a 3/10 MB bundle cap, `workerd` blocking runtime WASM compilation from fetched bytes (exactly what ffmpeg.wasm does at init), no Web Workers, and CPU/memory exhaustion regardless.
- **Supabase Edge Functions cap CPU at 2 seconds.** You need 5–30. That number ends the discussion before the 256 MB ceiling and no-native-binaries problems.
- **Google Cloud is ruled out.** The owner has decided against a second cloud vendor for this project. Running the worker there also meant a Google Cloud project, a service account, a container image registry, and about 40 lines of WebCrypto JWT signing in the Worker just to authenticate as a Google client. None of that plumbing is needed once the worker lives next to the files it reads.
- **Railway loses on idle cost, not on capability.** It floors at **$5/month even at zero traffic**, because the service stays resident whether or not a file is queued. Its per-vCPU-second rate is 2.6× better than Cloudflare's, which would matter if the machine were busy — but this worker is idle about **99.7% of the time** (roughly 35 seconds of billed work per track, at ~200 tracks a month). Idle memory dominates the bill, and the break-even against Cloudflare is around **30,000 tracks/month — about 150× the current volume**. Railway remains the documented fallback if that volume is ever reached.

**Cloudflare Containers is the choice.** It went generally available on 13 April 2026, on the Workers Paid plan ($5/month, already paid for Queues). One-off processing of the 2,000-track backfill costs about **$1.28**; the ongoing load of 200 tracks/month costs **$0.00**, inside allowances already paid for. §10 has the arithmetic.

Memory and disk bill for the whole time an instance stays awake; only CPU bills for active work. That is why `sleepAfter` is set to **30 seconds** instead of the 10-minute default — the default alone turns a $0.00 month into about $0.73 for identical work. The same asymmetry means a smaller, fractional-vCPU instance costs *more*, not less: a quarter-vCPU instance turns 35 seconds of CPU work into about 140 seconds of elapsed time, so the memory bill rises even though the machine runs slower. The instance size is **1 vCPU / 3 GiB memory / 6 GB disk**. Peak memory use is 977 MB, which would fit 2 GiB, but the platform enforces a minimum of 3 GiB of memory per vCPU, so 3 GiB is a floor, not a choice.

Containers run on `linux/amd64` only, so images are cross-built on the M1 with `docker buildx` and cannot be timed locally — a cross-built image runs under QEMU emulation, and QEMU timings are meaningless.

One real limit remains: a container does not autoscale in the traditional sense. Concurrent files are handled by starting more container instances behind more Durable Objects, up to a fixed `max_instances` cap; a request beyond that cap **fails instead of queuing**. The cap is set well above the expected burst size, and this failure mode does not reproduce in local development — it has to be designed around, not tested.

### Orchestration: Cloudflare Queues

Free at this volume (10,000 ops/day on the free plan; ongoing load ~600 ops/month, full backfill ~6,000 in one day). Native R2 event notifications mean uploads trigger analysis with no poller anywhere. The consumer Worker's job is to get a Durable Object stub for the container and call it — no URL minting, because the Durable Object reaches R2 through a binding instead.

**Keep the container stateless and credential-free.** The Durable Object in front of it holds the only R2 access, through a binding, so the container itself never holds an R2 key, a Supabase key, or a bearer token of any kind. This is a step up from the earlier presigned-URL design: a presigned URL is itself a credential, one with a countdown on it, and this design has none anywhere. Returning results to the Worker rather than writing to Postgres directly means the `service_role` key never leaves Cloudflare, and makes retries trivially safe because a failed run mutates nothing.

**Queues is at-least-once, so the handler must be idempotent.** Use `content_sha256` as the idempotency key and `ON CONFLICT (file_id, analysis_version) DO UPDATE`. One track per message, never a batch — a batch retry re-delivers every message in it.

**Free-plan Queues retention is 24 hours and non-configurable**, so the queue cannot be the system of record. `files.state` in Supabase is the truth, plus a Cron Trigger Worker that re-enqueues anything stuck in `analysing` for >1 h. That one cron makes the pipeline self-healing and the retention limit a non-issue.

### Streaming

FLAC/WAV/AIFF are not broadly streamable in-browser. Analysis emits a **128 kbps Opus preview** (~5.5 MB for 6 min) written back to R2 alongside the peaks JSON. The player streams the preview; download serves the original.

The Opus preview is written back to R2 through the same binding the container uses to read the source file. There is no egress cost, because the container and R2 sit on the same network.

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
3. **Analysis worker.** One Cloudflare Container: decode → fpcalc → key/BPM → loudness → peaks → tags → quality forensics. Queue + consumer Worker + Durable Object + the stuck-job cron.
4. **Dedup.** Fingerprints table + GIN, candidate query, offset-swept BER, bands, `assign_track` with the advisory lock, merge/undo, review queue with the divergence strip.
5. **Pool UI.** Track list, filters, player, download.
6. **Crates.**
7. **Catalogue matching.** AcoustID → MusicBrainz → Apple ISRC bridge → Apple/CAA artwork, uploader artwork upload, confirm-match UI with the ±3 s duration gate. **First task: the two Apple verifications in §8.1.**
7b. **Genre.** Discogs dump ingest, MB→Discogs join, synonym table, normalisation of existing dirty tags, two-level facet.
8. **Calibration pass** at ~2k tracks: reset `T_high`/`T_low` from your own library, tune the `query_items` mask by measurement.
9. **v2:** credits enforcement, crate sharing, MusicBrainz mirror if no-match rate >25%.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Wrong auto-merges destroy someone's crates | Merges reversible by design; crates read through `canonical_track_id()` and are never rewritten. Add a "recent merges" feed so wrong ones get noticed. |
| Review queue is demoralisingly large at first | Expect high hundreds on the first few thousand files. Build the bulk "apply to similar" action earlier than feels necessary. |
| Vinyl rips at different speeds never dedup | **Accepted for v1.** Trigger to revisit: near-miss pairs clustering in the 0.40–0.70 band with 1–3% duration deltas — that signature *is* speed drift. At that point add Panako 2.0 as a second matcher for the residue only. |
| BPM octave errors | Genre prior + one-click ×2/÷2 persisted to `bpm_display`. Not fixable in the analyser. |
| Fake-upgrade false positives insult contributors | Abstain generously (5–15% to review is correct), always show the spectrogram, always allow appeal, strikes not bans. |
| MusicBrainz coverage gap on white-labels | Uploader-supplied artwork and tags as a first-class path, not a fallback. |
| Thresholds are guesses | Explicit calibration step at ~2k tracks; every decision records the thresholds it used. |
| Container burst exceeds `max_instances` and errors instead of queuing | Set the cap well above the expected concurrent burst; this can't be reproduced in local dev, so verify behaviour on the first real production burst. |
| Free Supabase projects pause after ~7 days idle | Would silently break the stuck-job cron. Monitor, or take the paid tier. |

---

## 16. Open questions

Ranked by how much the answer changes the build.

1. Backfill — dump all ~2k tracks day one, or trickle? Sets max-instances and whether Supabase needs a rate limit in front.
2. Ingest the full Discogs monthly dump locally (§9.1) — it's the right answer but it's a real chunk of Postgres. In v1, or start with the API as a gap-filler and add the dump when the facet proves itself?
3. Crate sharing in v2 — read-only publish, or collaborative?
4. Cap on max `access_expires_at`? Without one a bulk uploader banks years in an afternoon.
5. Expired member: fully dark, or can still see (not download) their own tracks?
6. Trust pre-existing Rekordbox/Serato/Mixed-In-Key BPM+key tags when present, or always re-analyse and flag disagreement?
7. Camelot or Open Key as primary display? (Store both regardless.)
8. Cue points / beat grids from Rekordbox XML — in scope later? Changes whether `beat_grid` needs to round-trip.
9. Second Google account for the same person — allowlist keyed on email forever, or person-level invite?
10. Retention on rejected and quarantined uploads before a sweeper hard-deletes.
