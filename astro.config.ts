// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { execSync } from 'node:child_process'
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import solid from '@astrojs/solid-js'

/**
 * The deployed commit, resolved at build time. AGPL §13 obliges us to offer
 * the source of the *running* version, so a link to `main` is not enough —
 * it has to name a commit.
 *
 * Never throws: a build from a tarball has no .git, and a broken build is a
 * worse outcome than a vague source link.
 */
function buildSha(): string {
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA
  if (fromCi) return fromCi
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  integrations: [solid()],
  vite: {
    ssr: { external: ['node:buffer'] },
    /**
     * PERF TASK 2.5 — the pre-flight Worker stops carrying its own copy of
     * every audio parser.
     *
     * Vite's `worker.format` defaults to `'iife'`, and an IIFE cannot code
     * split: every dynamic `import()` inside the worker graph is inlined.
     * music-metadata's `parseBlob` picks its parser by container at
     * runtime — MP4, Mpeg, Ogg, Flac, Matroska, ASF, APE, Musepack, WavPack,
     * DSD and the ID3 readers — so an IIFE worker shipped ALL of them,
     * 219 KB raw / 64 KB gzip, to read one duration out of one header. The
     * same parsers were separately code split for the main-thread fallback,
     * which is the "double ship" the audit's sin #5 names.
     *
     * `format: 'es'` makes the worker a real module (which the call site
     * already requires — `new Worker(url, { type: 'module' })`), so it code
     * splits and SHARES those chunks with the fallback graph: one parser
     * graph in the manifest, and a member uploading MP3s downloads the MP3
     * parser rather than all sixteen.
     */
    worker: { format: 'es' },
    // Textual substitution at build time, so the constant reaches both the
    // server bundle and any island that imports it, with no runtime cost
    // and no secret involved.
    define: {
      __BUILD_SHA__: JSON.stringify(buildSha()),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  },
})
