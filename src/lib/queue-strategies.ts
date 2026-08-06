// src/lib/queue-strategies.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * M6b — THE STRATEGY PLUGINS, and the durable contract they satisfy.
 *
 * "there are multiple ways to compute the array of the queued tracks … but at
 * its core is one queue engine" — the owner. This file holds the *multiple
 * ways*. It holds no cap, no layers, no exclusions and no fetch: those belong
 * to queue-engine.ts, and the split is the entire reason a future genre or
 * artist-similarity strategy can land as a NEW FILE plus one registry line
 * rather than as an engine rewrite (§3.6).
 *
 * A strategy gets a typed context and returns ranked ids. It MUST NOT exceed
 * `need`, re-filter exclusions (the engine already did), mutate its inputs,
 * read the DOM, or touch the network — and it MUST be deterministic for a
 * given context, because spec §8's promise is "what you see is exactly what
 * plays". Nothing here calls `Math.random`; `shuffle` runs a seeded PRNG.
 *
 * WHY THE SCORING IS SPELLED OUT HERE. Spec §8 says it is "salvaged from
 * useSimilarityFilter.ts". That file is in butternutcrack, not in this repo
 * or in ~/Projects/cue-parser, so there was nothing to port. Every constant
 * below is therefore a named export in one place, so the owner can tune the
 * feel without reading the algorithm.
 */

import { parseCamelot } from './track-format'
import { METHOD_LABELS, type AutoMethod } from './queue-model'

// ------------------------------------------------------------- constants

/** ±1 hour, same letter, is the perfect-fifth / subdominant move. Both
 *  directions are standard mix moves and the wheel exists precisely so either
 *  is safe — so both are free. Key clash is measured on the wheel, which is
 *  what Camelot notation is FOR; there is no separate semitone tolerance. */
export const KEY_FREE_HOURS = 1
/** A → B or B → A at any distance except 0 hours. */
export const MODE_SWAP_PENALTY = 1.5
/** Same hour, other letter: the relative major/minor. Cheap, not free. */
export const RELATIVE_PENALTY = 0.5
/** No key_camelot. Pickable — an unanalysed track is not banned — but never
 *  preferred over anything the wheel can actually place. */
export const UNKNOWN_KEY_PENALTY = 3.0
export const UNKNOWN_BPM_PENALTY = 2.0
/** ±6 %, a DJ's comfortable pitch range. This is the server-side gate in
 *  queue-candidates.ts AND the drift bound: a set should not wander from 128
 *  to 96 BPM without being asked. */
export const BPM_WINDOW = 0.06
/** 6 % of drift therefore costs 2.0 — the same order as a mode swap. */
export const BPM_PCT_DIVISOR = 3

/** Two scores this close are the same score. Without it, float noise of
 *  ~1e-13 between two tempos that are musically identical would silently
 *  decide a tie that the documented tie-break order is supposed to own. */
const SCORE_EPSILON = 1e-9

// ------------------------------------------------------------- interfaces

/**
 * Everything a strategy is allowed to know about a track. Additive by design:
 * a genre strategy adds `genre` here and reads it; nothing else moves. This
 * is also exactly what /api/queue/candidates projects onto the wire — nine
 * fields out of pool_list's forty-odd, which is the migration-20/28 narrowing
 * held on the client side too.
 */
export interface TrackFeatures {
  file_id: string
  display_artist: string | null
  display_title: string
  duration_ms: number | null
  bpm: number | null
  key_camelot: string | null
  like_count: number
  play_count: number
  created_at: string
}

export interface StrategyContext {
  /** The track the tail continues FROM — the last known-forward entry, NOT
   *  necessarily `current` (§3.3). Null when there is nothing to seed from. */
  seed: TrackFeatures | null
  /** Server-narrowed, pool-visible, already exclusion-filtered by the engine. */
  candidates: readonly TrackFeatures[]
  /** Most-recent-first. For recency-aware ranking, NOT for exclusion — the
   *  engine has already removed everything in it. */
  history: readonly string[]
  /** How many slots the engine wants. Never negative when the engine calls. */
  need: number
}

export interface Strategy {
  readonly id: AutoMethod
  readonly label: string
  /** Rank and select, in play order. See this file's header for the contract. */
  select(ctx: StrategyContext): readonly string[]
}

/**
 * Which method takes over when one returns short, applied ONCE by the engine.
 * A map rather than an `if (method === 'harmonic')` so that a future strategy
 * declares its own fallback here instead of editing the engine — the same
 * additive-file rule the registry itself follows.
 */
export const FALLBACK_METHOD: Partial<Record<AutoMethod, AutoMethod>> = {
  harmonic: 'bpm',
}

// ------------------------------------------------------------- scoring

/**
 * Distance on the Camelot wheel, in penalty units. Symmetric. An off-wheel,
 * malformed or missing key is UNKNOWN_KEY_PENALTY — `parseCamelot` is the
 * same validator the pool filter and migration 11 agree on.
 */
export function keyPenalty(a: string | null | undefined, b: string | null | undefined): number {
  const ka = parseCamelot(a)
  const kb = parseCamelot(b)
  if (ka === null || kb === null) return UNKNOWN_KEY_PENALTY

  const raw = Math.abs(ka.num - kb.num)
  const hours = Math.min(raw, 12 - raw)
  if (hours === 0 && ka.letter !== kb.letter) return RELATIVE_PENALTY

  const hourCost = Math.max(0, hours - KEY_FREE_HOURS)
  const modeCost = ka.letter === kb.letter ? 0 : MODE_SWAP_PENALTY
  return hourCost + modeCost
}

/**
 * Tempo distance as a percentage of the SEED's tempo, scaled so the edge of
 * the ±6 % window costs 2.0. Deliberately seed-relative and therefore NOT
 * symmetric: the question is always "how far must I pitch this to sit under
 * what is playing", and the answer is measured against what is playing.
 */
export function bpmPenalty(a: number | null | undefined, b: number | null | undefined): number {
  if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return UNKNOWN_BPM_PENALTY
  if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) return UNKNOWN_BPM_PENALTY
  return ((Math.abs(a - b) / a) * 100) / BPM_PCT_DIVISOR
}

/** Lower is better. A null seed scores every candidate identically, so the
 *  total tie-break order below decides — still deterministic. */
export function score(seed: TrackFeatures | null, cand: TrackFeatures): number {
  return keyPenalty(seed?.key_camelot ?? null, cand.key_camelot) +
    bpmPenalty(seed?.bpm ?? null, cand.bpm)
}

/**
 * The total order. Lower penalty → higher like_count → newer created_at →
 * file_id ascending. TOTAL is the operative word: with it, "what you see is
 * exactly what plays" survives a reload, a re-fetch and a different candidate
 * ordering off the wire.
 *
 * `play_count` is deliberately absent (§2.2). Letting popularity break
 * harmonic ties would drift the auto tail toward the same tracks every
 * session for no musical reason, and M6c ranks discovery by plays.
 */
function compare(
  a: TrackFeatures, b: TrackFeatures,
  seed: TrackFeatures | null,
  scoreOf: (seed: TrackFeatures | null, cand: TrackFeatures) => number,
): number {
  const sa = scoreOf(seed, a)
  const sb = scoreOf(seed, b)
  if (Math.abs(sa - sb) > SCORE_EPSILON) return sa - sb

  if (a.like_count !== b.like_count) return b.like_count - a.like_count

  const ta = Date.parse(a.created_at)
  const tb = Date.parse(b.created_at)
  const na = Number.isNaN(ta) ? 0 : ta
  const nb = Number.isNaN(tb) ? 0 : tb
  if (na !== nb) return nb - na

  return a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0
}

// ------------------------------------------------------------- selection

/** Clamps whatever the caller passed to a whole, non-negative count. */
function slotsWanted(need: number): number {
  return Number.isFinite(need) ? Math.max(0, Math.floor(need)) : 0
}

/** First occurrence wins. A duplicate id in the candidate set is a server or
 *  cache artefact, and a strategy must never hand the same track back twice. */
function uniqueById(candidates: readonly TrackFeatures[]): TrackFeatures[] {
  const seen = new Set<string>()
  const out: TrackFeatures[] = []
  for (const c of candidates) {
    if (seen.has(c.file_id)) continue
    seen.add(c.file_id)
    out.push(c)
  }
  return out
}

/**
 * THE GREEDY WALK of spec §8, shared by `harmonic` and `bpm` with different
 * score functions — which is the whole "strategies are plugins" claim in
 * miniature.
 *
 * EACH PICK RE-SEEDS THE NEXT. Non-obvious and easy to get wrong: ranking
 * every slot against the ORIGINAL seed builds a tail where track 4 mixes out
 * of something three positions in the past and clashes with the track
 * immediately before it. The chain is a chain.
 *
 * It never pads, never repeats and never widens its window: when the
 * candidates run out the tail is short, and §1.3 says that is correct
 * behaviour rather than a defect.
 */
function greedyWalk(
  ctx: StrategyContext,
  scoreOf: (seed: TrackFeatures | null, cand: TrackFeatures) => number,
): string[] {
  const want = slotsWanted(ctx.need)
  if (want === 0) return []

  const remaining = uniqueById(ctx.candidates)
  const picked: string[] = []
  let seed = ctx.seed

  while (picked.length < want && remaining.length > 0) {
    let best = 0
    for (let i = 1; i < remaining.length; i++) {
      if (compare(remaining[i], remaining[best], seed, scoreOf) < 0) best = i
    }
    const chosen = remaining.splice(best, 1)[0]
    picked.push(chosen.file_id)
    seed = chosen
  }
  return picked
}

// A seeded PRNG, so `shuffle` is random-looking but reproducible: the same
// queue state renders the same tail after a reload, which is what makes it
// testable at all. FNV-1a for the string seed, mulberry32 for the stream.
function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // A zero state makes mulberry32 degenerate; any non-zero constant will do.
  return (h >>> 0) || 0x9e3779b9
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------- registry

/**
 * THE EXTENSION POINT (§3.6). A genre strategy adds `genre` to TrackFeatures,
 * scores Jaccard overlap against the seed's set, and lands here as one more
 * entry. The engine does not change, because the candidate fetch already goes
 * through a port and the cap/exclusion/layer logic never mentions a feature
 * name.
 */
export const STRATEGIES: Record<AutoMethod, Strategy> = {
  /** The DEFAULT. Returns nothing, and the engine short-circuits before ever
   *  calling it — so a member who never opens the drawer issues zero
   *  queue-related requests. This entry exists so the registry is total and
   *  the UI has a label to press. */
  off: {
    id: 'off',
    label: METHOD_LABELS.off,
    select: () => [],
  },

  /** The greedy Camelot + BPM chain. M3's key and BPM analysis, on the decks. */
  harmonic: {
    id: 'harmonic',
    label: METHOD_LABELS.harmonic,
    select: (ctx) => greedyWalk(ctx, score),
  },

  /**
   * Tempo proximity only, key ignored. It is a named method rather than an
   * inline branch in the engine precisely so the harmonic-dead-end fallback
   * (§1.3 case 3) gets its own tests and its own name in the UI.
   */
  bpm: {
    id: 'bpm',
    label: METHOD_LABELS.bpm,
    select: (ctx) => greedyWalk(ctx, (seed, cand) => bpmPenalty(seed?.bpm ?? null, cand.bpm)),
  },

  /** Uniform random over the candidate set. Not intelligence — the deliberate
   *  absence of it. A peer method, not a modifier on the others: `method ×
   *  shuffle` would be eight configurations to reason about and persist, for
   *  one that anybody wants. */
  shuffle: {
    id: 'shuffle',
    label: METHOD_LABELS.shuffle,
    select: (ctx) => {
      const want = slotsWanted(ctx.need)
      if (want === 0) return []
      const pool = uniqueById(ctx.candidates)
      const rng = mulberry32(hashSeed(ctx.seed?.file_id ?? ''))
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        const tmp = pool[i]
        pool[i] = pool[j]
        pool[j] = tmp
      }
      return pool.slice(0, want).map((c) => c.file_id)
    },
  },
}
