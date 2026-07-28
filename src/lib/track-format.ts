// src/lib/track-format.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Pure formatting and Camelot maths, shared by every track-rendering
 * component. No DOM, no fetch — so it is unit-testable under Vitest's node
 * environment, which is the only environment this repo has.
 *
 * `formatDuration` lives in ./preflight and `formatBytes` in ./format.
 * Import them; do not add a third copy here.
 */

export type Camelot = { num: number; letter: 'A' | 'B' }

/** Sorts after every real key. 12B is 121, so anything above that will do. */
export const UNKNOWN_SORT_KEY = 999

/**
 * Above this coefficient of variation the beat grid is not a constant
 * tempo, and the displayed BPM is an average rather than a fact. PRD 4
 * names 0.02.
 */
export const CONSTANT_TEMPO_CV = 0.02

const CAMELOT_RE = /^([1-9]|1[0-2])([AB])$/

export function parseCamelot(key: string | null | undefined): Camelot | null {
  if (typeof key !== 'string') return null
  const m = CAMELOT_RE.exec(key.trim().toUpperCase())
  if (m === null) return null
  return { num: Number(m[1]), letter: m[2] as 'A' | 'B' }
}

/**
 * The cue-tracks composite-sort trick (`FileList.tsx:120-125`). Camelot keys
 * sort wrong lexicographically — '10A' lands before '2A' — in every naive
 * implementation. Mirrored by `camelot_sort` in migration 11 so the client
 * and the server agree on the order.
 */
export function camelotSortKey(key: string | null | undefined): number {
  const c = parseCamelot(key)
  if (c === null) return UNKNOWN_SORT_KEY
  return c.num * 10 + (c.letter === 'B' ? 1 : 0)
}

/**
 * The harmonically compatible neighbours of a key: one step either way
 * around the wheel in the same mode, plus the relative major/minor. Order is
 * self, +1, -1, relative — stable, so the KeyFilter can render the chip set
 * without re-sorting. The server computes the same set in
 * `public.camelot_neighbours()`; this copy exists so the filter can SHOW
 * which keys it is about to include.
 */
export function harmonicKeys(key: string | null | undefined): string[] {
  const c = parseCamelot(key)
  if (c === null) return []
  const up = (c.num % 12) + 1
  const down = ((c.num + 10) % 12) + 1
  const other = c.letter === 'A' ? 'B' : 'A'
  return [`${c.num}${c.letter}`, `${up}${c.letter}`, `${down}${c.letter}`, `${c.num}${other}`]
}

/**
 * One decimal, '~' when the tempo drifts, em dash when there is no beat.
 * A degraded analysis (bpm 0) is data: the worker listened and found no
 * pulse. It is never rendered as an error state.
 */
export function formatBpm(
  bpm: number | null | undefined, ibiStdMs: number | null | undefined,
): string {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return '—'
  const drifts =
    typeof ibiStdMs === 'number' && Number.isFinite(ibiStdMs) && ibiStdMs > 0 &&
    (ibiStdMs * bpm) / 60_000 >= CONSTANT_TEMPO_CV
  return `${drifts ? '~' : ''}${bpm.toFixed(1)}`
}

const MUSICAL_LONG: Record<string, string> = { m: ' minor', M: ' major' }

export function keyTooltip(
  camelot: string | null, open: string | null, musical: string | null,
): string {
  if (!camelot) return 'no key detected'
  const parts = [`Camelot ${camelot}`]
  if (open) parts.push(`Open Key ${open}`)
  if (musical) {
    // 'Am' -> 'A minor', 'C#M' -> 'C# major', anything else passed through.
    const tail = musical.slice(-1)
    const long = MUSICAL_LONG[tail]
    parts.push(long === undefined ? musical : `${musical.slice(0, -1)}${long}`)
  }
  return parts.join(' · ')
}

export function qualityLabel(tier: number | null | undefined): string {
  return typeof tier === 'number' ? `Tier ${tier}` : '—'
}

/**
 * The tooltip must say MEASURED, and must name the measurement, because the
 * claim it is making is "your file is not what its container says". PRD 7.2:
 * `abstain` means the detector had nothing to work with — rendering that as
 * suspicion is how a clean rip gets called a fake.
 */
export function qualityTooltip(
  tier: number | null | undefined,
  lossyAncestor: string | null | undefined,
  measCutoffHz: number | null | undefined,
): string {
  if (typeof tier !== 'number') return 'not analysed yet'
  const cutoff =
    typeof measCutoffHz === 'number' && measCutoffHz > 0
      ? `measured cutoff ${(measCutoffHz / 1000).toFixed(1)} kHz`
      : null
  switch (lossyAncestor) {
    case 'suspected':
      return `Tier ${tier} · FLAC/WAV container, ${cutoff ?? 'no cutoff measured'} — transcode suspected`
    case 'confirmed':
      return `Tier ${tier} · ${cutoff ?? 'no cutoff measured'} — lossy ancestor confirmed`
    case 'abstain':
      return `Tier ${tier} · not enough signal to judge the source`
    case 'none':
      return cutoff === null ? `Tier ${tier}` : `Tier ${tier} · ${cutoff}, no transcode indicators`
    default:
      return `Tier ${tier}`
  }
}
