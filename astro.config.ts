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
    // Textual substitution at build time, so the constant reaches both the
    // server bundle and any island that imports it, with no runtime cost
    // and no secret involved.
    define: {
      __BUILD_SHA__: JSON.stringify(buildSha()),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  },
})
