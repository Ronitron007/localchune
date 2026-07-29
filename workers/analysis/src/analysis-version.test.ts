// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * ANALYSIS_VERSION exists in THREE places and they must move together.
 *
 * Two of them are producers — the app Worker's queue send and the
 * maintenance Worker's stuck-job cron — and the string they put in the
 * message is what ends up in audio_analysis.analysis_version. The third is
 * the container's own envVars, which only reaches /healthz.
 *
 * The third is the one that gets missed, and a mismatch is silent: the
 * backfill re-analyses every file and stores it under the OLD version, so
 * the rows look done, nothing errors, and the only symptom is a query that
 * finds no v2 rows after a run that plainly happened.
 *
 * Compared by reading the three source files rather than by importing them.
 * They live in three different module worlds — one imports
 * `cloudflare:workers`, one is a field on a Container subclass, one is a
 * plain const — and no single import graph reaches all three.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')

function versionIn(relPath: string, pattern: RegExp): string {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  const m = src.match(pattern)
  if (!m) throw new Error(`no ANALYSIS_VERSION found in ${relPath}`)
  return m[1]
}

describe('ANALYSIS_VERSION', () => {
  const sites: Array<[string, RegExp]> = [
    ['src/lib/analyze-queue.ts', /export const ANALYSIS_VERSION = '([^']+)'/],
    ['workers/maintenance/src/index.ts', /export const ANALYSIS_VERSION = '([^']+)'/],
    ['workers/analysis/src/index.ts', /envVars = \{ ANALYSIS_VERSION: '([^']+)' \}/],
  ]

  it('is the same string in all three places', () => {
    const found = sites.map(([path, re]) => [path, versionIn(path, re)])
    const distinct = new Set(found.map(([, v]) => v))
    expect(distinct.size, JSON.stringify(found)).toBe(1)
  })

  it('is v2 — the version that carries a real forensics verdict', () => {
    // Not decoration. A v1 row has forensics NULL and no content_sha256 by
    // design; M4's keep-if-better falls back to keep_both:no_forensics on
    // every comparison against one. The version string is how a row says
    // which of those two worlds it came from.
    for (const [path, re] of sites) expect(versionIn(path, re)).toBe('v2')
  })
})
